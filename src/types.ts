export type SourceKind = "qq" | "feishu" | "wechat" | "wecom" | "dingtalk" | "telegram" | "cli" | "web" | "api";

export type ConfirmDecision = "confirm" | "cancel";
export type ContentKind = "concept" | "method" | "tutorial" | "opinion" | "tool" | "pitfall" | "case" | "unknown";
export type IdeaKind = "product" | "automation" | "hardware" | "content" | "combo" | "unvalidated";
export type IngestJobStatus = "received" | "queued" | "running" | "waiting_user" | "confirmed" | "cancelled" | "failed" | "committed";
export type IngestIntentType = "new_ingest" | "confirm_preview" | "cancel_preview" | "supplement_preview" | "query_status" | "unknown";
export type AgentRunStatus = "created" | "running" | "tool_calling" | "preview_generated" | "need_clarification" | "failed" | "completed";
export type AgentStepStatus = "running" | "success" | "warning" | "failed" | "skipped";
export type PreviewStatus = "pending" | "confirmed" | "cancelled" | "expired";
export type VaultWriteOperation = "create" | "update_frontmatter" | "append_section" | "merge_content";

export interface PreviewRequest {
  text: string;
  source: SourceKind;
  senderId: string;
  messageId: string;
}

export interface ConfirmRequest {
  previewId: string;
  decision: ConfirmDecision;
  extraText?: string;
  writeMode?: "default" | "knowledge_only";
}

export interface ParsedInput {
  rawText: string;
  urls: string[];
  githubRepos: string[];
  douyinUrls: string[];
  candidateQuery: string;
}

export interface DouyinMetadata {
  type?: string;
  videoUrl?: string;
  videoUrlHQ?: string;
  nickname?: string;
  desc?: string;
  awemeId?: string;
  sourceUrl: string;
}

export interface OcrResult {
  text: string;
  framesAnalyzed: number;
  available: boolean;
  sourceVideo?: string;
  subtitleText?: string;
  frameTexts?: string[];
  tempCleaned?: boolean;
  error?: string;
}

export interface GitHubRepo {
  fullName: string;
  htmlUrl: string;
  description: string | null;
  stars: number;
  topics: string[];
  license: string | null;
  updatedAt: string;
  language: string | null;
  readme: string;
}

export interface WebpageExtractResult {
  url: string;
  canonicalUrl?: string;
  title?: string;
  description?: string;
  contentType?: string;
  status: number;
  excerpt: string;
  text: string;
}

export interface DetectedProject {
  name: string;
  noteTitle?: string;
  githubRepo?: string;
  githubUrl?: string;
  description: string;
  confidence: number;
  evidence: string[];
}

export interface IdeaCard {
  title: string;
  ideaKind?: IdeaKind;
  combinedWith: string[];
  productConcept: string;
  softwarePossibility: string;
  hardwarePossibility: string;
  userScenario: string;
  minimalExperiment: string;
  nextAction: string;
}

export interface KnowledgeCard {
  title: string;
  category: string;
  contentKind?: ContentKind;
  domains?: string[];
  sourceType?: SourceKind | "douyin" | "github" | "manual";
  entities?: string[];
  summary: string;
  keyPoints: string[];
  sourceInsights: string[];
  relatedConcepts: string[];
  applicationIdeas: string[];
  nextActions: string[];
}

export interface NotePreview {
  title: string;
  path: string;
  type: "project" | "knowledge" | "idea" | "source" | "inbox" | "action";
  operation?: VaultWriteOperation;
  reason?: string;
  confidence?: number;
}

export interface IngestPreview {
  previewId: string;
  summary: string;
  detectedProjects: DetectedProject[];
  notesToWrite: NotePreview[];
  knowledge: KnowledgeCard[];
  ideas: IdeaCard[];
  warnings: string[];
}

export interface StoredPreview extends IngestPreview {
  request: PreviewRequest;
  parsedInput: ParsedInput;
  douyin: DouyinMetadata[];
  ocr: OcrResult[];
  webpages?: WebpageExtractResult[];
  githubRepos: GitHubRepo[];
  createdAt: string;
  status: "pending" | "confirmed" | "cancelled";
}

export interface GeneratedNote {
  title: string;
  relativePath: string;
  content: string;
  type: NotePreview["type"];
  operation?: VaultWriteOperation;
  reason?: string;
  confidence?: number;
  githubRepo?: string;
  sourceUrls?: string[];
  sourceIds?: string[];
  entities?: string[];
  domains?: string[];
}

export interface ConfirmResult {
  previewId: string;
  status: "confirmed" | "cancelled" | "regenerated";
  writtenFiles: string[];
  alreadyCommitted?: boolean;
  plannedFiles?: string[];
  preview?: IngestPreview;
}

export interface AgentMessageRequest {
  text: string;
  source: SourceKind;
  senderId: string;
  chatId?: string;
  messageId: string;
  mode?: "preview_only" | "auto" | "confirm_context";
  receivedAt?: string;
  raw?: Record<string, unknown>;
  autoWrite?: boolean;
}

export interface AgentMessageResponse {
  ok: boolean;
  action:
    | "auto_written"
    | "preview_only"
    | "ignored"
    | "error"
    | "queued"
    | "preview_generated"
    | "confirmed"
    | "cancelled"
    | "regenerated"
    | "chat_reply"
    | "idea_saved";
  jobId?: string;
  runId?: string;
  previewId?: string;
  reply: string;
  preview?: IngestPreview;
  writtenFiles: string[];
  warnings: string[];
}

export interface IncomingMessageRecord {
  id: string;
  source: SourceKind;
  senderId: string;
  chatId?: string;
  messageId: string;
  text: string;
  rawPayload?: unknown;
  normalizedPayload: unknown;
  status: "received" | "ignored" | "processed";
  jobId?: string;
  createdAt: string;
}

export interface IngestJobRecord {
  id: string;
  messageRecordId?: string;
  source: SourceKind;
  senderId: string;
  chatId?: string;
  status: IngestJobStatus;
  intentType: IngestIntentType;
  currentNode?: string;
  previewId?: string;
  errorSummary?: string;
  retryCount: number;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunRecord {
  id: string;
  jobId: string;
  status: AgentRunStatus;
  inputState: unknown;
  finalState?: unknown;
  model?: string;
  tokenUsage?: unknown;
  startedAt: string;
  endedAt?: string;
  error?: string;
}

export interface AgentStepLogRecord {
  id: string;
  runId: string;
  jobId: string;
  nodeName: string;
  status: AgentStepStatus;
  inputSummary?: string;
  outputSummary?: string;
  toolName?: string;
  durationMs?: number;
  error?: string;
  createdAt: string;
}

export interface ToolCallRecord {
  id: string;
  runId: string;
  jobId: string;
  nodeName: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
  status: "success" | "warning" | "failed" | "skipped";
  durationMs?: number;
  error?: string;
  createdAt: string;
}
