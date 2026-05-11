import { Request } from "express";
import { z } from "zod";
import { AgentMessageRequest, IngestPreview, SourceKind } from "../../types.js";

export interface ConnectorConfigField {
  key: string;
  envKey: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
}

export interface ConnectorSetupStatus {
  configured: boolean;
  missing: string[];
  notes: string[];
  capabilities: string[];
}

export interface ChallengeResult {
  handled: boolean;
  status?: number;
  body?: unknown;
  contentType?: string;
}

export interface ConnectorTestResult {
  ok: boolean;
  message: string;
}

export interface ConnectorReplyTarget {
  source: SourceKind;
  senderId: string;
  chatId?: string;
  messageId: string;
  raw?: Record<string, unknown>;
}

export interface ConnectorReply {
  text: string;
  jobId?: string;
  runId?: string;
  previewId?: string;
  preview?: IngestPreview;
  action?: string;
  warnings?: string[];
}

export interface ConnectorAdapter {
  source: SourceKind;
  adapter: string;
  label: string;
  endpoint: string;
  description: string;
  mode: "sdk" | "protocol" | "bridge" | "generic";
  getConfigSchema(): ConnectorConfigField[];
  getSetupStatus(config: ConnectorRuntimeConfig): ConnectorSetupStatus;
  handleChallenge(req: Request, config: ConnectorRuntimeConfig): Promise<ChallengeResult>;
  verifyRequest(req: Request, config: ConnectorRuntimeConfig): Promise<void>;
  normalizeMessage(req: Request, config: ConnectorRuntimeConfig): Promise<AgentMessageRequest>;
  sendReply(target: ConnectorReplyTarget, reply: ConnectorReply, config: ConnectorRuntimeConfig): Promise<ConnectorTestResult>;
  sendTestMessage(config: ConnectorRuntimeConfig): Promise<ConnectorTestResult>;
}

export interface ConnectorRuntimeConfig {
  enabled: boolean;
  publicBaseUrl: string;
  values: Record<string, string>;
}

export const commonTextPayloadSchema = z
  .object({
    text: z.string().optional(),
    content: z.string().optional(),
    message: z.string().optional(),
    rawText: z.string().optional(),
    senderId: z.string().optional(),
    userId: z.string().optional(),
    openId: z.string().optional(),
    chatId: z.string().optional(),
    messageId: z.string().optional(),
    msgId: z.string().optional(),
    message_id: z.string().optional(),
    autoWrite: z.boolean().optional()
  })
  .passthrough();

export function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function firstNonEmpty(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function contentText(value: unknown): string | undefined {
  const parsed = parseJsonText(value);
  if (typeof parsed === "string") return parsed.trim() || undefined;
  return firstNonEmpty([
    readPath(parsed, ["text"]),
    readPath(parsed, ["content"]),
    readPath(parsed, ["message"]),
    collectNestedText(parsed)
  ]);
}

function collectNestedText(value: unknown): string | undefined {
  const chunks: string[] = [];
  const visit = (current: unknown) => {
    if (!current) return;
    if (typeof current === "string") {
      const clean = current.trim();
      if (clean) chunks.push(clean);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    for (const key of ["text", "title", "content", "href"]) visit(record[key]);
  };
  visit(value);
  return chunks.join(" ").trim() || undefined;
}

export function requireEnabled(config: ConnectorRuntimeConfig, source: string): void {
  if (!config.enabled) throw new Error(`${source} connector is disabled`);
}

export function setupStatus(fields: ConnectorConfigField[], config: ConnectorRuntimeConfig, capabilities: string[], notes: string[] = []): ConnectorSetupStatus {
  const missing = fields.filter((field) => field.required && !config.values[field.key]).map((field) => field.key);
  return {
    configured: missing.length === 0,
    missing,
    notes,
    capabilities
  };
}
