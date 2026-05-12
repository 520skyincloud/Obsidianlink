import { z } from "zod";
import { connectorAdapters, normalizeWithAdapter } from "./connectors/adapters/index.js";
import { AgentMessageRequest, SourceKind } from "./types.js";

export const sourceKinds = ["feishu", "wechat", "wecom", "dingtalk", "telegram", "cli", "web", "api"] as const;

export const sourceKindSchema = z.enum(sourceKinds);

export const connectorDefinitions = connectorAdapters.map((adapter) => ({
  source: adapter.source,
  adapter: adapter.adapter,
  label: adapter.label,
  endpoint: adapter.endpoint,
  status: "ready" as const,
  description: adapter.description,
  mode: adapter.mode,
  configFields: adapter.getConfigSchema()
}));

export function normalizeConnectorMessage(source: SourceKind, payload: unknown): AgentMessageRequest {
  return normalizeWithAdapter(source, payload);
}
