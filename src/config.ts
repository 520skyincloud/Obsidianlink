import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(38721),
  OBSIDIANLINK_DB_PATH: z.string().min(1).default("./data/obsidianlink.sqlite"),
  OBSIDIAN_VAULT_PATH: z.string().min(1).default("/Users/sky/Documents/obsidian/sky"),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_MODEL: z.string().min(1).default("gpt-4o-mini"),
  OPENAI_ALLOW_INSECURE_TLS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  GITHUB_TOKEN: z.string().optional().default(""),
  DOUYIN_PARSE_API: z.string().url().default("https://api.bugpk.com/api/douyin?url="),
  OCR_FRAME_INTERVAL_SECONDS: z.coerce.number().positive().default(4),
  OCR_MAX_FRAMES: z.coerce.number().int().positive().default(8),
  OCR_MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(80 * 1024 * 1024)
});

export const config = envSchema.parse(process.env);

if (config.OPENAI_ALLOW_INSECURE_TLS) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

export function resolveVaultPath(relativePath = ""): string {
  const root = path.resolve(config.OBSIDIAN_VAULT_PATH);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(root)) {
    throw new Error("Refusing to write outside OBSIDIAN_VAULT_PATH");
  }
  return target;
}

export function missingRequiredConfig(): string[] {
  const missing: string[] = [];
  if (!config.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!config.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  return missing;
}
