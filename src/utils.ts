import crypto from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function previewId(): string {
  return `pv_${crypto.randomUUID()}`;
}

export function jobId(): string {
  return `job_${crypto.randomUUID()}`;
}

export function runId(): string {
  return `run_${crypto.randomUUID()}`;
}

export function dbId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function slugify(input: string): string {
  return input
    .trim()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90) || "untitled";
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function truncate(input: string, max = 12000): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}\n\n...[truncated]`;
}

export function extractJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Model did not return valid JSON");
  }
}
