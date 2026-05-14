import { config } from "../config.js";
import { DouyinMetadata } from "../types.js";
import { Agent } from "undici";

interface DouyinApiResponse {
  code: number;
  msg?: string;
  platform?: string;
  type?: string;
  author?: {
    nickname?: string;
    name?: string;
  };
  title?: string;
  desc?: string;
  aweme_id?: string;
  video_url?: string;
  video_url_HQ?: string;
  url?: string | null;
  images?: string[] | null;
  cover?: string | null;
  live_photo?: DouyinLivePhoto[] | null;
  video_backup?: DouyinVideoBackup[] | null;
  data?: {
    type?: string;
    title?: string;
    video_url?: string;
    video_url_HQ?: string;
    url?: string | null;
    nickname?: string;
    desc?: string;
    aweme_id?: string;
    images?: string[] | null;
    cover?: string | null;
    live_photo?: DouyinLivePhoto[] | null;
    author?: {
      name?: string;
      nickname?: string;
      id?: string | number;
    };
    video_backup?: DouyinVideoBackup[] | null;
  };
}

interface DouyinVideoBackup {
  url?: string;
  quality?: string;
  bit_rate?: number;
  width?: number;
  height?: number;
  codec?: string;
}

interface DouyinLivePhoto {
  image?: string;
  video?: string;
}

export class DouyinClient {
  async parse(url: string): Promise<DouyinMetadata> {
    const endpoint = buildDouyinParseUrl(config.DOUYIN_PARSE_API, url);
    let response: Response;
    try {
      response = await fetch(endpoint, douyinFetchOptions());
    } catch (error) {
      throw new Error(`Douyin parse request failed before response: ${formatFetchError(error)}`);
    }
    if (!response.ok) {
      throw new Error(`Douyin parse request failed: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as DouyinApiResponse;
    if (payload.code !== 200) {
      throw new Error(`Douyin parse failed: ${payload.msg ?? `code ${payload.code}`}`);
    }
    const data = payload.data;
    const awemeId = data?.aweme_id ?? payload.aweme_id ?? (await resolveAwemeId(url));
    const videoBackup = pickVideoBackup(data?.video_backup ?? payload.video_backup);
    const images = collectImages(data?.images ?? payload.images, data?.live_photo ?? payload.live_photo, data?.cover ?? payload.cover);
    return {
      type: data?.type ?? payload.type,
      videoUrl: data?.url ?? payload.url ?? data?.video_url ?? payload.video_url ?? videoBackup?.url,
      videoUrlHQ: videoBackup?.url ?? data?.video_url_HQ ?? payload.video_url_HQ ?? data?.url ?? payload.url ?? undefined,
      images,
      nickname: data?.nickname ?? data?.author?.name ?? data?.author?.nickname ?? payload.author?.name ?? payload.author?.nickname,
      desc: data?.desc ?? payload.desc ?? data?.title ?? payload.title,
      awemeId,
      sourceUrl: url
    };
  }
}

function douyinFetchOptions(): RequestInit {
  const headers = { "user-agent": "ObsidianLink/0.1" };
  if (!config.DOUYIN_ALLOW_INSECURE_TLS) return { headers };
  return {
    headers,
    dispatcher: new Agent({ connect: { rejectUnauthorized: false } })
  } as RequestInit;
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    return `${error.message} (${String((cause as { code?: unknown }).code)})`;
  }
  return error.message;
}

function collectImages(images?: string[] | null, livePhotos?: DouyinLivePhoto[] | null, cover?: string | null): string[] {
  return [
    ...(images ?? []),
    ...(livePhotos ?? []).map((item) => item.image ?? ""),
    cover ?? ""
  ]
    .map((item) => item.trim())
    .filter((item): item is string => Boolean(item))
    .filter((item, index, all) => all.indexOf(item) === index);
}

export function buildDouyinParseUrl(base: string, inputUrl: string): string {
  if (base.includes("{url}")) return base.replace("{url}", encodeURIComponent(inputUrl));
  if (/[?&]url=$/.test(base) || base.endsWith("=")) return `${base}${encodeURIComponent(inputUrl)}`;
  const endpoint = new URL(base);
  endpoint.searchParams.set("url", inputUrl);
  return endpoint.toString();
}

function pickVideoBackup(backups?: DouyinVideoBackup[] | null): DouyinVideoBackup | undefined {
  if (!backups?.length) return undefined;
  return [...backups]
    .filter((item) => item.url)
    .sort((a, b) => scoreBackup(b) - scoreBackup(a))[0];
}

function scoreBackup(item: DouyinVideoBackup): number {
  const height = item.height ?? Number(item.quality?.match(/\d+/)?.[0] ?? 0);
  const codecScore = item.codec?.toLowerCase() === "h264" ? 20 : 0;
  const sizeScore = height && height <= 1080 ? 30 : height > 1080 ? -20 : 0;
  const bitrateScore = item.bit_rate ? Math.max(0, 20 - item.bit_rate / 100_000) : 0;
  return sizeScore + codecScore + bitrateScore + Math.min(height / 100, 12);
}

async function resolveAwemeId(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { redirect: "follow" });
    const matched = response.url.match(/\/video\/(\d+)/);
    return matched?.[1];
  } catch {
    return undefined;
  }
}
