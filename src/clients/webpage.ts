import { WebpageExtractResult } from "../types.js";
import { truncate } from "../utils.js";

const DEFAULT_TIMEOUT_MS = 12000;
const MAX_HTML_CHARS = 900_000;

export class WebpageExtractor {
  async extract(url: string): Promise<WebpageExtractResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "ObsidianLink/0.1 (+local knowledge ingestion)",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.2"
        }
      });
    } catch (error) {
      throw new Error(`网页请求失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeout);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) throw new Error(`网页请求返回 ${response.status}`);
    if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
      throw new Error(`不支持的网页内容类型：${contentType || "unknown"}`);
    }

    const raw = (await response.text()).slice(0, MAX_HTML_CHARS);
    const html = raw.replace(/\u0000/g, "");
    const title = firstText([metaContent(html, "og:title"), tagText(html, "title"), tagText(html, "h1")]);
    const description = firstText([metaContent(html, "description"), metaContent(html, "og:description")]);
    const canonicalUrl = canonical(html);
    const text = contentType.includes("text/plain") ? normalizeText(html) : htmlToText(html);
    const cleanText = truncate(text, 12000);

    return {
      url,
      canonicalUrl,
      title,
      description,
      contentType,
      status: response.status,
      excerpt: truncate(firstText([description, cleanText]) ?? "", 900),
      text: cleanText
    };
  }
}

function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|p|div|section|article|li|h[1-6]|tr|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return normalizeText(decodeHtml(withoutNoise));
}

function normalizeText(value: string): string {
  return value
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tagText(html: string, tag: string): string | undefined {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? normalizeText(decodeHtml(match[1].replace(/<[^>]+>/g, " "))) : undefined;
}

function metaContent(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta\\b[^>]*(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']${escaped}["'][^>]*>`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return normalizeText(decodeHtml(match[1]));
  }
  return undefined;
}

function canonical(html: string): string | undefined {
  const match = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i) ?? html.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i);
  return match?.[1]?.trim();
}

function firstText(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const clean = value?.trim();
    if (clean) return clean;
  }
  return undefined;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => {
      const point = Number(code);
      return Number.isFinite(point) ? String.fromCodePoint(point) : "";
    });
}
