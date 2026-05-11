import { getDb } from "./db.js";
import {
  AgentRunRecord,
  AgentRunStatus,
  AgentStepLogRecord,
  AgentStepStatus,
  IngestJobRecord,
  IngestJobStatus,
  IngestIntentType,
  IncomingMessageRecord,
  SourceKind,
  StoredPreview,
  ToolCallRecord
} from "../types.js";
import { config } from "../config.js";
import { dbId } from "../utils.js";

type Row = Record<string, unknown>;

export class Repositories {
  constructor(private readonly db = getDb()) {}

  createIncomingMessage(input: {
    source: SourceKind;
    senderId: string;
    chatId?: string;
    messageId: string;
    text: string;
    rawPayload?: unknown;
    normalizedPayload: unknown;
  }): { record: IncomingMessageRecord; duplicate: boolean } {
    const now = new Date().toISOString();
    const id = dbId("msg");
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO incoming_messages
        (id, source, sender_id, chat_id, message_id, text, raw_payload_json, normalized_payload_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`
      )
      .run(
        id,
        input.source,
        input.senderId,
        input.chatId ?? null,
        input.messageId,
        input.text,
        input.rawPayload === undefined ? null : json(input.rawPayload),
        json(input.normalizedPayload),
        now
      );
    const row = this.db.prepare("SELECT * FROM incoming_messages WHERE source = ? AND message_id = ?").get(input.source, input.messageId) as Row;
    return { record: toIncomingMessage(row), duplicate: result.changes === 0 };
  }

  markIncomingMessageProcessed(id: string, jobId: string): void {
    this.db.prepare("UPDATE incoming_messages SET status = 'processed', job_id = ? WHERE id = ?").run(jobId, id);
  }

  getIncomingMessage(id: string): IncomingMessageRecord | undefined {
    const row = this.db.prepare("SELECT * FROM incoming_messages WHERE id = ?").get(id) as Row | undefined;
    return row ? toIncomingMessage(row) : undefined;
  }

  getIncomingMessageBySourceMessageId(source: SourceKind, messageId: string): IncomingMessageRecord | undefined {
    const row = this.db.prepare("SELECT * FROM incoming_messages WHERE source = ? AND message_id = ?").get(source, messageId) as Row | undefined;
    return row ? toIncomingMessage(row) : undefined;
  }

  createJob(input: {
    messageRecordId?: string;
    source: SourceKind;
    senderId: string;
    chatId?: string;
    status?: IngestJobStatus;
    intentType: IngestIntentType;
  }): IngestJobRecord {
    const now = new Date().toISOString();
    const id = dbId("job");
    this.db
      .prepare(
        `INSERT INTO ingest_jobs
        (id, message_id, source, sender_id, chat_id, status, intent_type, retry_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(id, input.messageRecordId ?? null, input.source, input.senderId, input.chatId ?? null, input.status ?? "received", input.intentType, now, now);
    return this.getJob(id)!;
  }

  updateJob(
    id: string,
    patch: Partial<Record<"status", IngestJobStatus> & Record<"currentNode" | "previewId" | "errorSummary" | "startedAt" | "finishedAt", string | null>>
  ): void {
    const current = this.getJob(id);
    if (!current) return;
    const next = {
      status: patch.status ?? current.status,
      currentNode: patch.currentNode === undefined ? current.currentNode ?? null : patch.currentNode,
      previewId: patch.previewId === undefined ? current.previewId ?? null : patch.previewId,
      errorSummary: patch.errorSummary === undefined ? current.errorSummary ?? null : patch.errorSummary,
      startedAt: patch.startedAt === undefined ? current.startedAt ?? null : patch.startedAt,
      finishedAt: patch.finishedAt === undefined ? current.finishedAt ?? null : patch.finishedAt,
      updatedAt: new Date().toISOString()
    };
    this.db
      .prepare(
        `UPDATE ingest_jobs
        SET status = ?, current_node = ?, preview_id = ?, error_summary = ?, started_at = ?, finished_at = ?, updated_at = ?
        WHERE id = ?`
      )
      .run(next.status, next.currentNode, next.previewId, next.errorSummary, next.startedAt, next.finishedAt, next.updatedAt, id);
  }

  incrementJobRetry(id: string): void {
    this.db.prepare("UPDATE ingest_jobs SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  getJob(id: string): IngestJobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM ingest_jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? toJob(row) : undefined;
  }

  listJobs(limit = 50): IngestJobRecord[] {
    return (this.db.prepare("SELECT * FROM ingest_jobs ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(toJob);
  }

  createRun(input: { jobId: string; inputState: unknown; status?: AgentRunStatus }): AgentRunRecord {
    const now = new Date().toISOString();
    const id = dbId("run");
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, job_id, status, input_state_json, model, started_at)
        VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.jobId, input.status ?? "created", json(input.inputState), config.OPENAI_MODEL, now);
    return this.getRun(id)!;
  }

  updateRun(id: string, patch: Partial<Pick<AgentRunRecord, "status" | "finalState" | "tokenUsage" | "endedAt" | "error">>): void {
    const current = this.getRun(id);
    if (!current) return;
    this.db
      .prepare(
        `UPDATE agent_runs SET status = ?, final_state_json = ?, token_usage_json = ?, ended_at = ?, error = ? WHERE id = ?`
      )
      .run(
        patch.status ?? current.status,
        patch.finalState === undefined ? (current.finalState === undefined ? null : json(current.finalState)) : json(patch.finalState),
        patch.tokenUsage === undefined ? (current.tokenUsage === undefined ? null : json(current.tokenUsage)) : json(patch.tokenUsage),
        patch.endedAt ?? current.endedAt ?? null,
        patch.error ?? current.error ?? null,
        id
      );
  }

  getRun(id: string): AgentRunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as Row | undefined;
    return row ? toRun(row) : undefined;
  }

  listRuns(limit = 50): AgentRunRecord[] {
    return (this.db.prepare("SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?").all(limit) as Row[]).map(toRun);
  }

  addStep(input: {
    runId: string;
    jobId: string;
    nodeName: string;
    status: AgentStepStatus;
    inputSummary?: string;
    outputSummary?: string;
    toolName?: string;
    durationMs?: number;
    error?: string;
  }): AgentStepLogRecord {
    const id = dbId("step");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_step_logs
        (id, run_id, job_id, node_name, status, input_summary, output_summary, tool_name, duration_ms, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.runId, input.jobId, input.nodeName, input.status, input.inputSummary ?? null, input.outputSummary ?? null, input.toolName ?? null, input.durationMs ?? null, input.error ?? null, now);
    return this.listRunSteps(input.runId).find((step) => step.id === id)!;
  }

  listRunSteps(runId: string): AgentStepLogRecord[] {
    return (this.db.prepare("SELECT * FROM agent_step_logs WHERE run_id = ? ORDER BY created_at ASC").all(runId) as Row[]).map(toStep);
  }

  listRecentSteps(limit = 80): AgentStepLogRecord[] {
    return (this.db.prepare("SELECT * FROM agent_step_logs ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(toStep);
  }

  addToolCall(input: {
    runId: string;
    jobId: string;
    nodeName: string;
    toolName: string;
    input?: unknown;
    output?: unknown;
    status: ToolCallRecord["status"];
    durationMs?: number;
    error?: string;
  }): ToolCallRecord {
    const id = dbId("tool");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tool_calls
        (id, run_id, job_id, node_name, tool_name, input_json, output_json, status, duration_ms, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.runId,
        input.jobId,
        input.nodeName,
        input.toolName,
        input.input === undefined ? null : json(input.input),
        input.output === undefined ? null : json(input.output),
        input.status,
        input.durationMs ?? null,
        input.error ?? null,
        now
      );
    return this.listRunToolCalls(input.runId).find((call) => call.id === id)!;
  }

  listRunToolCalls(runId: string): ToolCallRecord[] {
    return (this.db.prepare("SELECT * FROM tool_calls WHERE run_id = ? ORDER BY created_at ASC").all(runId) as Row[]).map(toToolCall);
  }

  savePreview(preview: StoredPreview, jobId: string, runId: string, markdownPreview = ""): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO previews
        (id, job_id, run_id, sender_id, source, status, summary, detected_projects_json, notes_to_write_json, knowledge_json, ideas_json, warnings_json, markdown_preview, stored_preview_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          summary = excluded.summary,
          detected_projects_json = excluded.detected_projects_json,
          notes_to_write_json = excluded.notes_to_write_json,
          knowledge_json = excluded.knowledge_json,
          ideas_json = excluded.ideas_json,
          warnings_json = excluded.warnings_json,
          markdown_preview = excluded.markdown_preview,
          stored_preview_json = excluded.stored_preview_json,
          updated_at = excluded.updated_at`
      )
      .run(
        preview.previewId,
        jobId,
        runId,
        preview.request.senderId,
        preview.request.source,
        preview.status,
        preview.summary,
        json(preview.detectedProjects),
        json(preview.notesToWrite),
        json(preview.knowledge),
        json(preview.ideas),
        json(preview.warnings),
        markdownPreview,
        json(preview),
        preview.createdAt,
        now
      );
  }

  updatePreviewStatus(previewId: string, status: "pending" | "confirmed" | "cancelled" | "expired"): void {
    this.db.prepare("UPDATE previews SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), previewId);
  }

  listPreviews(limit = 50, status?: string) {
    const sql = status
      ? "SELECT * FROM previews WHERE status = ? ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM previews ORDER BY created_at DESC LIMIT ?";
    const rows = status ? this.db.prepare(sql).all(status, limit) : this.db.prepare(sql).all(limit);
    return (rows as Row[]).map(toPreviewRow);
  }

  getPreview(previewId: string) {
    const row = this.db.prepare("SELECT * FROM previews WHERE id = ?").get(previewId) as Row | undefined;
    return row ? toPreviewRow(row) : undefined;
  }

  getStoredPreview(previewId: string): StoredPreview | undefined {
    const row = this.db.prepare("SELECT stored_preview_json FROM previews WHERE id = ?").get(previewId) as Row | undefined;
    return parseJson(row?.stored_preview_json, undefined);
  }

  getLatestPendingPreview(source: SourceKind, senderId: string) {
    const row = this.db
      .prepare("SELECT * FROM previews WHERE source = ? AND sender_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
      .get(source, senderId) as Row | undefined;
    return row ? toPreviewRow(row) : undefined;
  }

  addConnectorLog(input: { source: string; eventType: string; status: string; message?: string; metadata?: unknown }): void {
    this.db
      .prepare("INSERT INTO connector_logs (id, source, event_type, status, message, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(dbId("clog"), input.source, input.eventType, input.status, input.message ?? null, input.metadata === undefined ? null : json(input.metadata), new Date().toISOString());
  }

  listConnectorLogs(limit = 80, source?: string) {
    const sql = source
      ? "SELECT * FROM connector_logs WHERE source = ? ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM connector_logs ORDER BY created_at DESC LIMIT ?";
    const rows = source ? this.db.prepare(sql).all(source, limit) : this.db.prepare(sql).all(limit);
    return (rows as Row[]).map((row) => ({
      id: String(row.id),
      source: String(row.source),
      eventType: String(row.event_type),
      status: String(row.status),
      message: text(row.message) ?? "",
      metadata: parseJson(row.metadata_json, undefined),
      createdAt: String(row.created_at)
    }));
  }

  upsertConnectorStatus(input: {
    source: string;
    enabled: boolean;
    mode: string;
    publicBaseUrl?: string;
    localEndpoint: string;
    configStatus: string;
    configuredFields: Record<string, boolean>;
    capabilities: string[];
    lastMessageAt?: string;
    lastTestAt?: string;
    lastTestResult?: string;
    lastError?: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO connector_configs
        (id, source, enabled, mode, public_base_url, local_endpoint, config_status, configured_fields_json, capabilities_json, last_message_at, last_test_at, last_test_result, last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source) DO UPDATE SET
          enabled = excluded.enabled,
          mode = excluded.mode,
          public_base_url = excluded.public_base_url,
          local_endpoint = excluded.local_endpoint,
          config_status = excluded.config_status,
          configured_fields_json = excluded.configured_fields_json,
          capabilities_json = excluded.capabilities_json,
          last_message_at = COALESCE(excluded.last_message_at, connector_configs.last_message_at),
          last_test_at = COALESCE(excluded.last_test_at, connector_configs.last_test_at),
          last_test_result = COALESCE(excluded.last_test_result, connector_configs.last_test_result),
          last_error = excluded.last_error,
          updated_at = excluded.updated_at`
      )
      .run(
        dbId("conn"),
        input.source,
        input.enabled ? 1 : 0,
        input.mode,
        input.publicBaseUrl ?? null,
        input.localEndpoint,
        input.configStatus,
        json(input.configuredFields),
        json(input.capabilities),
        input.lastMessageAt ?? null,
        input.lastTestAt ?? null,
        input.lastTestResult ?? null,
        input.lastError ?? null,
        now,
        now
      );
  }

  registerVaultFile(input: {
    noteId: string;
    title: string;
    path: string;
    type: string;
    githubRepo?: string;
    sourceUrls?: string[];
    sourceIds?: string[];
    entities?: string[];
    domains?: string[];
    contentHash?: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO vault_files
        (id, note_id, title, path, type, github_repo, source_urls_json, source_ids_json, entities_json, domains_json, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          title = excluded.title,
          type = excluded.type,
          github_repo = excluded.github_repo,
          source_urls_json = excluded.source_urls_json,
          source_ids_json = excluded.source_ids_json,
          entities_json = excluded.entities_json,
          domains_json = excluded.domains_json,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at`
      )
      .run(
        dbId("vf"),
        input.noteId,
        input.title,
        input.path,
        input.type,
        input.githubRepo ?? null,
        json(input.sourceUrls ?? []),
        json(input.sourceIds ?? []),
        json(input.entities ?? []),
        json(input.domains ?? []),
        input.contentHash ?? null,
        now,
        now
      );
  }

  listVaultFiles(limit = 50) {
    return (this.db.prepare("SELECT * FROM vault_files ORDER BY updated_at DESC LIMIT ?").all(limit) as Row[]).map((row) => ({
      id: String(row.id),
      noteId: String(row.note_id),
      title: String(row.title),
      path: String(row.path),
      type: String(row.type),
      githubRepo: text(row.github_repo),
      sourceUrls: parseJson(row.source_urls_json, []),
      sourceIds: parseJson(row.source_ids_json, []),
      entities: parseJson(row.entities_json, []),
      domains: parseJson(row.domains_json, []),
      contentHash: text(row.content_hash),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
  }
}

export const repositories = new Repositories();

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function toIncomingMessage(row: Row): IncomingMessageRecord {
  return {
    id: String(row.id),
    source: row.source as SourceKind,
    senderId: String(row.sender_id),
    chatId: text(row.chat_id),
    messageId: String(row.message_id),
    text: String(row.text),
    rawPayload: parseJson(row.raw_payload_json, undefined),
    normalizedPayload: parseJson(row.normalized_payload_json, {}),
    status: row.status as IncomingMessageRecord["status"],
    jobId: text(row.job_id),
    createdAt: String(row.created_at)
  };
}

function toJob(row: Row): IngestJobRecord {
  return {
    id: String(row.id),
    messageRecordId: text(row.message_id),
    source: row.source as SourceKind,
    senderId: String(row.sender_id),
    chatId: text(row.chat_id),
    status: row.status as IngestJobStatus,
    intentType: row.intent_type as IngestIntentType,
    currentNode: text(row.current_node),
    previewId: text(row.preview_id),
    errorSummary: text(row.error_summary),
    retryCount: Number(row.retry_count ?? 0),
    startedAt: text(row.started_at),
    finishedAt: text(row.finished_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toRun(row: Row): AgentRunRecord {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    status: row.status as AgentRunStatus,
    inputState: parseJson(row.input_state_json, {}),
    finalState: parseJson(row.final_state_json, undefined),
    model: text(row.model),
    tokenUsage: parseJson(row.token_usage_json, undefined),
    startedAt: String(row.started_at),
    endedAt: text(row.ended_at),
    error: text(row.error)
  };
}

function toStep(row: Row): AgentStepLogRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    jobId: String(row.job_id),
    nodeName: String(row.node_name),
    status: row.status as AgentStepStatus,
    inputSummary: text(row.input_summary),
    outputSummary: text(row.output_summary),
    toolName: text(row.tool_name),
    durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
    error: text(row.error),
    createdAt: String(row.created_at)
  };
}

function toToolCall(row: Row): ToolCallRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    jobId: String(row.job_id),
    nodeName: String(row.node_name),
    toolName: String(row.tool_name),
    input: parseJson(row.input_json, undefined),
    output: parseJson(row.output_json, undefined),
    status: row.status as ToolCallRecord["status"],
    durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
    error: text(row.error),
    createdAt: String(row.created_at)
  };
}

function toPreviewRow(row: Row) {
  return {
    previewId: String(row.id),
    jobId: String(row.job_id),
    runId: String(row.run_id),
    senderId: String(row.sender_id),
    source: row.source as SourceKind,
    status: String(row.status),
    summary: String(row.summary),
    detectedProjects: parseJson(row.detected_projects_json, []),
    notesToWrite: parseJson(row.notes_to_write_json, []),
    knowledge: parseJson(row.knowledge_json, []),
    ideas: parseJson(row.ideas_json, []),
    warnings: parseJson(row.warnings_json, []),
    markdownPreview: text(row.markdown_preview) ?? "",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
