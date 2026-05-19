import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveVaultPath } from "../config.js";
import { GeneratedNote, NotePreview, VaultWriteOperation } from "../types.js";
import { vaultDirs } from "./markdown.js";

export interface BrokenWikiLink {
  sourcePath: string;
  target: string;
  normalizedTarget: string;
  suggestions: string[];
}

export interface BrokenLinkCheckResult {
  ok: boolean;
  checkedFiles: number;
  totalLinks: number;
  brokenLinks: BrokenWikiLink[];
}

export class ObsidianVault {
  async ensureStructure(): Promise<void> {
    for (const dir of vaultDirs) {
      await fs.mkdir(resolveVaultPath(dir), { recursive: true });
    }
  }

  async writeNotes(notes: GeneratedNote[]): Promise<string[]> {
    await this.ensureStructure();
    const written: string[] = [];
    for (const note of notes) {
      const relativePath = await resolveEffectiveNotePath(note);
      const effectiveNote = relativePath === note.relativePath ? note : { ...note, relativePath };
      const absolutePath = resolveVaultPath(relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      const exists = await fileExists(absolutePath);
      const operation = effectiveNote.operation ?? (exists ? inferExistingOperation(effectiveNote.type) : "create");
      if (!exists || operation === "create") {
        await fs.writeFile(absolutePath, effectiveNote.content, "utf8");
      } else if (operation === "update_frontmatter") {
        await fs.writeFile(absolutePath, await mergeByAppendingDiscovery(absolutePath, effectiveNote), "utf8");
      } else if (operation === "append_section" || operation === "merge_content") {
        const current = await fs.readFile(absolutePath, "utf8");
        if (!current.includes(discoveryMarker(effectiveNote))) {
          await fs.appendFile(absolutePath, appendDiscoverySection(effectiveNote), "utf8");
        }
      }
      written.push(absolutePath);
    }
    return written;
  }

  async planNotes(notes: GeneratedNote[]): Promise<NotePreview[]> {
    const previews: NotePreview[] = [];
    for (const note of notes) {
      const relativePath = await resolveEffectiveNotePath(note);
      const absolutePath = resolveVaultPath(relativePath);
      const exists = await fileExists(absolutePath);
      const operation = note.operation ?? (exists ? inferExistingOperation(note.type) : "create");
      previews.push({
        title: note.title,
        path: relativePath,
        type: note.type,
        operation,
        reason: note.reason ?? operationReason(operation, exists),
        confidence: note.confidence ?? (exists ? 0.7 : 0.8)
      });
    }
    return previews;
  }

  async readExistingProjectIndex(): Promise<string> {
    const candidateDirs = ["1_项目/0_开源项目", "3_项目/30_开源项目", "4_项目研究/01_GitHub开源项目", "2_项目", "10_Projects"];
    try {
      const names: string[] = [];
      for (const dir of candidateDirs) {
        const files = await fs.readdir(resolveVaultPath(dir)).catch(() => []);
        const mdFiles = files.filter((file) => file.endsWith(".md")).slice(0, 200);
        names.push(...mdFiles.map((file) => file.replace(/\.md$/, "")));
      }
      return [...new Set(names)].join("\n");
    } catch {
      return "";
    }
  }

  async exists(): Promise<boolean> {
    try {
      const stat = await fs.stat(resolveVaultPath());
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async checkBrokenLinks(): Promise<BrokenLinkCheckResult> {
    const root = resolveVaultPath();
    const files = await listMarkdownFiles(root);
    const relativeFiles = files.map((file) => normalizeVaultPath(path.relative(root, file)));
    const exactTargets = new Set(relativeFiles.map(stripMdExtension));
    const basenameTargets = new Map<string, string[]>();
    for (const file of relativeFiles) {
      const noExt = stripMdExtension(file);
      const base = path.posix.basename(noExt).toLowerCase();
      basenameTargets.set(base, [...(basenameTargets.get(base) ?? []), noExt]);
    }

    const brokenLinks: BrokenWikiLink[] = [];
    let totalLinks = 0;
    for (const absoluteFile of files) {
      const sourcePath = normalizeVaultPath(path.relative(root, absoluteFile));
      const content = await fs.readFile(absoluteFile, "utf8");
      for (const link of extractWikiLinks(content)) {
        totalLinks += 1;
        const target = normalizeLinkTarget(link);
        if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        if (linkExists(target, exactTargets, basenameTargets)) continue;
        brokenLinks.push({
          sourcePath,
          target: link,
          normalizedTarget: target,
          suggestions: suggestTargets(target, relativeFiles)
        });
      }
    }

    return {
      ok: brokenLinks.length === 0,
      checkedFiles: files.length,
      totalLinks,
      brokenLinks
    };
  }
}

async function resolveEffectiveNotePath(note: GeneratedNote): Promise<string> {
  if (note.type !== "project" || !note.githubRepo) return note.relativePath;
  return (await findExistingProjectByGithubRepo(note.githubRepo)) ?? note.relativePath;
}

async function findExistingProjectByGithubRepo(githubRepo: string): Promise<string | undefined> {
  const root = resolveVaultPath();
  const files = await listMarkdownFiles(root);
  const expected = githubRepo.trim().toLowerCase();
  for (const absoluteFile of files) {
    const content = await fs.readFile(absoluteFile, "utf8").catch(() => "");
    const repo = readFrontmatterGithubRepo(content);
    if (repo?.toLowerCase() === expected) return normalizeVaultPath(path.relative(root, absoluteFile));
  }
  return undefined;
}

function readFrontmatterGithubRepo(content: string): string | undefined {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return undefined;
  const match = frontmatter[1].match(/^github_repo:\s*["']?([^"'\n]+)["']?\s*$/m);
  return match?.[1]?.trim();
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(absolutePath);
      }
    }
  }
  await walk(root);
  return results;
}

function extractWikiLinks(content: string): string[] {
  const links: string[] = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  for (const match of content.matchAll(regex)) links.push(match[1]);
  return links;
}

function normalizeLinkTarget(raw: string): string {
  return raw
    .split("|")[0]
    .split("#")[0]
    .replace(/\\/g, "/")
    .replace(/^\//, "")
    .trim();
}

function linkExists(target: string, exactTargets: Set<string>, basenameTargets: Map<string, string[]>): boolean {
  const withoutExtension = stripMdExtension(normalizeVaultPath(target));
  if (withoutExtension.includes("/")) return exactTargets.has(withoutExtension);
  return (basenameTargets.get(withoutExtension.toLowerCase()) ?? []).length > 0;
}

function suggestTargets(target: string, relativeFiles: string[]): string[] {
  const normalized = stripMdExtension(normalizeVaultPath(target)).toLowerCase();
  const targetBase = path.posix.basename(normalized);
  return relativeFiles
    .map(stripMdExtension)
    .map((file) => ({ file, score: suggestionScore(normalized, targetBase, file.toLowerCase()) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, 5)
    .map((item) => item.file);
}

function suggestionScore(target: string, targetBase: string, candidate: string): number {
  const candidateBase = path.posix.basename(candidate);
  if (candidate === target) return 100;
  if (candidateBase === targetBase) return 90;
  if (candidate.includes(target)) return 70;
  if (candidateBase.includes(targetBase) || targetBase.includes(candidateBase)) return 50;
  const targetTokens = new Set(targetBase.split(/[-_\s]+/).filter(Boolean));
  const overlap = candidateBase.split(/[-_\s]+/).filter((token) => targetTokens.has(token)).length;
  const tokenScore = overlap * 10;
  const charScore = characterOverlapScore(targetBase, candidateBase);
  return Math.max(tokenScore, charScore);
}

function characterOverlapScore(left: string, right: string): number {
  if (!left || !right) return 0;
  const leftChars = [...new Set([...left].filter((char) => !/[\s._-]/.test(char)))];
  if (!leftChars.length) return 0;
  const rightChars = new Set([...right]);
  const overlap = leftChars.filter((char) => rightChars.has(char)).length;
  const ratio = overlap / Math.max(leftChars.length, [...rightChars].length);
  return ratio >= 0.45 ? Math.round(ratio * 40) : 0;
}

function stripMdExtension(file: string): string {
  return file.replace(/\.md$/i, "");
}

function normalizeVaultPath(file: string): string {
  return file.split(path.sep).join("/");
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(absolutePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function inferExistingOperation(type: GeneratedNote["type"]): VaultWriteOperation {
  if (type === "project") return "update_frontmatter";
  if (type === "idea") return "merge_content";
  return "append_section";
}

function operationReason(operation: VaultWriteOperation, exists: boolean): string {
  if (!exists) return "新文件，执行 create";
  if (operation === "update_frontmatter") return "文件已存在，更新项目元数据并追加新发现";
  if (operation === "merge_content") return "文件已存在，合并相似内容";
  if (operation === "append_section") return "文件已存在，追加新发现段落";
  return "创建新文件";
}

async function mergeByAppendingDiscovery(absolutePath: string, note: GeneratedNote): Promise<string> {
  const current = await fs.readFile(absolutePath, "utf8");
  if (current.includes(discoveryMarker(note))) return current;
  return `${current.trimEnd()}${appendDiscoverySection(note)}`;
}

function appendDiscoverySection(note: GeneratedNote): string {
  const marker = discoveryMarker(note);
  return `\n\n${marker}\n## 新发现 ${new Date().toISOString()}\n\n来源于一次新的 ObsidianLink 摄入。\n\n${stripFrontmatter(note.content).trim()}\n`;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function discoveryMarker(note: GeneratedNote): string {
  return `<!-- obsidianlink-discovery:${noteContentHash(note.content)} -->`;
}

export function noteContentHash(content: string): string {
  const normalized = stripFrontmatter(content).replace(/\s+/g, " ").trim();
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
