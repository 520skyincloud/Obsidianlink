import { ParsedInput } from "./types.js";
import { unique } from "./utils.js";

const urlRegex = /https?:\/\/[^\s，。)）]+/gi;
const githubRepoRegex = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i;
const githubShorthandRegex = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/g;

export function parseInput(text: string): ParsedInput {
  const urls = unique(text.match(urlRegex) ?? []);
  const githubRepos = unique([
    ...urls
      .map((url) => url.match(githubRepoRegex))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => `${match[1]}/${cleanupRepoName(match[2])}`),
    ...extractRepoShorthands(text)
  ]);
  const douyinUrls = urls.filter((url) => /douyin\.com|iesdouyin\.com|v\.douyin\.com/i.test(url));

  return {
    rawText: text,
    urls,
    githubRepos,
    douyinUrls,
    candidateQuery: buildCandidateQuery(text, urls)
  };
}

function cleanupRepoName(repo: string): string {
  return repo.replace(/\.git$/i, "").replace(/[?#].*$/, "");
}

function extractRepoShorthands(text: string): string[] {
  const repos: string[] = [];
  const textWithoutUrls = text.replace(urlRegex, " ");
  for (const match of textWithoutUrls.matchAll(githubShorthandRegex)) {
    if (isPathLikeMatch(textWithoutUrls, match)) continue;
    if (match[1].includes(".")) continue;
    if (/^\d+$/.test(match[1]) && /^\d+$/.test(match[2])) continue;
    if (!isLikelyRepoShorthand(match[1], match[2])) continue;
    if (/\.(mp4|mov|m4v|webm|png|jpg|jpeg|gif|md|txt)$/i.test(match[2])) continue;
    const candidate = `${match[1]}/${match[2]}`;
    if (!candidate.includes("http")) {
      repos.push(candidate);
    }
  }
  return repos;
}

function isLikelyRepoShorthand(owner: string, repo: string): boolean {
  const generic = new Set([
    "api",
    "docs",
    "github",
    "help",
    "http",
    "https",
    "repo",
    "repos",
    "repository",
    "repositories",
    "rest",
    "workflow",
    "workflows"
  ]);
  return !generic.has(owner.toLowerCase()) && !generic.has(repo.toLowerCase());
}

function isPathLikeMatch(text: string, match: RegExpMatchArray): boolean {
  const index = match.index ?? 0;
  const previous = text[index - 1] ?? "";
  return previous === "/" || previous === "\\" || previous === ".";
}

function buildCandidateQuery(text: string, urls: string[]): string {
  let query = text;
  for (const url of urls) query = query.replace(url, " ");
  query = query.replace(/\s+/g, " ").trim();
  return cleanupGitHubSearchQuery(query);
}

function cleanupGitHubSearchQuery(input: string): string {
  if (!/github|git hub|开源项目|仓库|repo|repository/i.test(input)) return input;
  const explicit = extractExplicitProjectQuery(input);
  if (explicit) return explicit;
  const cleaned = input
    .replace(/git\s*hub|github/gi, " ")
    .replace(/开源项目|项目名称|项目名字|项目名|项目|仓库名称|仓库名字|仓库名|仓库|repo|repository/gi, " ")
    .replace(/帮我|麻烦|请|去|在|上|里|里面|中的|中|的|给我|帮忙/gi, " ")
    .replace(/找到|找一下|搜索一下|搜一下|搜索|搜|研究一下|研究|看看|看一下|查一下|查找|定位|是哪个|叫什么|名为|叫/gi, " ")
    .replace(/\b这个\b|\bthat\b|\bthe\b/gi, " ")
    .replace(/[，。！？；：、,.!?;:()[\]{}"'“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripQueryNoise(cleaned) || input;
}

function extractExplicitProjectQuery(input: string): string | undefined {
  const patterns = [
    /(?:项目名|项目名称|项目名字|仓库名|仓库名称|仓库名字|repo\s*name|repository\s*name)\s*(?:是|叫|为|:|：)?\s*([A-Za-z0-9_. -]{2,80})/i,
    /(?:叫|名为|名字是|名称是)\s*([A-Za-z][A-Za-z0-9_. -]{2,80})/i,
    /(?:找到|找一下|搜索一下|搜一下|搜索|搜|研究一下|研究|看看|查一下|查找)\s*([A-Za-z][A-Za-z0-9_. -]{2,80})\s*(?:这个)?(?:github|git hub|开源项目|项目|仓库|repo|repository)/i,
    /(?:github|git hub|开源项目|项目|仓库|repo|repository)\s*(?:里|上|中)?\s*(?:找到|找一下|搜索一下|搜一下|搜索|搜|研究一下|研究|看看|查一下|查找)?\s*([A-Za-z][A-Za-z0-9_. -]{2,80})/i
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return stripQueryNoise(value);
  }
  return undefined;
}

function stripQueryNoise(value: string): string {
  return value
    .replace(/这个|那个|一个|一下|项目|仓库|repo|repository/gi, " ")
    .replace(/^(的|上|里|中)\s*/g, "")
    .replace(/\s+(的|上|里|中)$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
