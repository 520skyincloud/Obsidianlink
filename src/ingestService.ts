import { DouyinClient } from "./clients/douyin.js";
import { GitHubClient } from "./clients/github.js";
import { OcrClient } from "./clients/ocr.js";
import { OpenAIClient } from "./clients/openai.js";
import { WebpageExtractor } from "./clients/webpage.js";
import { runPreviewAgentGraph } from "./agent/previewGraph.js";
import { runFeishuKnowledgeAgentV2 } from "./agent/runtime-v2/feishuKnowledgeAgent.js";
import { classifyAgentIntentV2 } from "./agent/runtime-v2/intentRouterV2.js";
import { Repositories, repositories } from "./database/repositories.js";
import { IdeaConversationService } from "./ideaConversation.js";
import { classifyMessageIntent } from "./intentRouter.js";
import { runAgentGraph } from "./agentGraph.js";
import { buildNotes } from "./obsidian/markdown.js";
import { noteContentHash, ObsidianVault } from "./obsidian/vault.js";
import { PreviewStore } from "./previewStore.js";
import {
  AgentMessageRequest,
  AgentMessageResponse,
  ConfirmRequest,
  ConfirmResult,
  IngestPreview,
  PreviewRequest,
  StoredPreview
} from "./types.js";
import { nowIso, slugify } from "./utils.js";

export { shouldSearchGitHub } from "./agent/previewGraph.js";

export class IngestService {
  private readonly agentCache = new Map<string, AgentMessageResponse>();
  private readonly previewRuns = new Map<string, { jobId: string; runId: string }>();
  private queueTail = Promise.resolve();
  private readonly ideaConversation: IdeaConversationService;

  constructor(
    private readonly store = new PreviewStore(),
    private readonly vault = new ObsidianVault(),
    private readonly douyin = new DouyinClient(),
    private readonly github = new GitHubClient(),
    private readonly ocr = new OcrClient(),
    private readonly ai = new OpenAIClient(),
    private readonly repo = repositories,
    private readonly webpage = new WebpageExtractor()
  ) {
    this.ideaConversation = new IdeaConversationService(this.vault, this.ai, this.repo);
  }

  async preview(request: PreviewRequest): Promise<IngestPreview> {
    const duplicate = this.duplicatePreview(request);
    if (duplicate) return duplicate;
    const tracking = this.startRun(request, "new_ingest");
    const stored = await this.runPreviewWithTracking(request, tracking);
    return toPublicPreview(stored);
  }

  async enqueueAgentMessage(request: AgentMessageRequest, onComplete?: (response: AgentMessageResponse) => Promise<void> | void): Promise<AgentMessageResponse> {
    const cacheKey = `${request.source}:${request.senderId}:${request.messageId}`;
    const hasOpenIdeaSession = this.ideaConversation.hasOpenSession(request);
    const routed = await runFeishuKnowledgeAgentV2({
      request,
      repo: this.repo,
      hasOpenIdeaSession,
      hasPendingPreview: Boolean(this.findPendingPreview(request.source, request.senderId))
    });
    if (routed.shouldUseIdeaConversation) {
      const incoming = this.repo.createIncomingMessage({
        source: request.source,
        senderId: request.senderId,
        chatId: request.chatId,
        messageId: request.messageId,
        text: request.text,
        rawPayload: request.raw,
        normalizedPayload: request
      });
      if (incoming.duplicate) {
        return {
          ok: true,
          action: "ignored",
          reply: "",
          writtenFiles: [],
          warnings: ["duplicate_message"]
        };
      }
      const ideaResponse = await this.ideaConversation.handle(request);
      if (ideaResponse) {
        return ideaResponse;
      }
    }
    const previewAction = await this.handlePreviewTextAction(request);
    if (previewAction) return previewAction;
    if (routed.intent.intent === "casual_chat" || routed.intent.intent === "help" || routed.intent.intent === "status" || routed.intent.intent === "knowledge_question") {
      const reply = routed.reply?.trim() || (await this.handleAgentMessage(request)).reply;
      return {
        ok: true,
        action: "chat_reply",
        reply,
        writtenFiles: [],
        warnings: []
      };
    }
    if (isImmediateChatIntent(request.text)) {
      return this.handleAgentMessage(request);
    }
    const duplicate = this.duplicateQueuedResponse(request);
    if (duplicate) return duplicate;
    const incoming = this.repo.createIncomingMessage({
      source: request.source,
      senderId: request.senderId,
      chatId: request.chatId,
      messageId: request.messageId,
      text: request.text,
      rawPayload: request.raw,
      normalizedPayload: request
    });
    if (incoming.duplicate) {
      const replay = this.duplicateQueuedResponse(request);
      if (replay) return replay;
      return queuedResponse({ jobId: incoming.record.jobId, source: request.source });
    }
    const job = this.repo.createJob({
      messageRecordId: incoming.record.id,
      source: request.source,
      senderId: request.senderId,
      chatId: request.chatId,
      status: "queued",
      intentType: "new_ingest"
    });
    this.repo.markIncomingMessageProcessed(incoming.record.id, job.id);
    this.queueTail = this.queueTail
      .catch(() => undefined)
      .then(() => this.processQueuedAgentMessage(request, job.id, onComplete));
    return queuedResponse({ jobId: job.id, source: request.source });
  }

  private async runPreviewWithTracking(request: PreviewRequest, tracking: { jobId: string; runId: string }): Promise<StoredPreview> {
    try {
      const stored = await runPreviewAgentGraph({
        request,
        tracking,
        douyin: this.douyin,
        github: this.github,
        ocr: this.ocr,
        webpage: this.webpage,
        ai: this.ai,
        vault: this.vault,
        repo: this.repo
      });
      this.store.set(stored);
      this.previewRuns.set(stored.previewId, tracking);
      this.repo.savePreview(stored, tracking.jobId, tracking.runId, markdownPreview(stored));
      this.repo.updateJob(tracking.jobId, {
        status: "waiting_user",
        currentNode: "reply_builder",
        previewId: stored.previewId,
        finishedAt: nowIso()
      });
      this.repo.updateRun(tracking.runId, {
        status: "preview_generated",
        finalState: {
          previewId: stored.previewId,
          summary: stored.summary,
          notesToWrite: stored.notesToWrite,
          warnings: stored.warnings
        },
        endedAt: nowIso()
      });
      return stored;
    } catch (error) {
      const message = messageOf(error);
      this.repo.updateJob(tracking.jobId, { status: "failed", currentNode: "failure_handler", errorSummary: message, finishedAt: nowIso() });
      this.repo.updateRun(tracking.runId, { status: "failed", finalState: { error: message }, endedAt: nowIso(), error: message });
      throw error;
    }
  }

  private async processQueuedAgentMessage(
    request: AgentMessageRequest,
    jobId: string,
    onComplete?: (response: AgentMessageResponse) => Promise<void> | void
  ): Promise<void> {
    const run = this.repo.createRun({
      jobId,
      status: "running",
      inputState: {
        job: { jobId, source: request.source, senderId: request.senderId, messageId: request.messageId },
        input: { rawText: request.text }
      }
    });
    this.repo.updateJob(jobId, { status: "running", currentNode: "load_context", startedAt: nowIso() });
    try {
      const stored = await this.runPreviewWithTracking(request, { jobId, runId: run.id });
      const response: AgentMessageResponse = {
        ok: true,
        action: "preview_generated",
        jobId,
        runId: run.id,
        previewId: stored.previewId,
        reply: formatQueuedPreviewReply(toPublicPreview(stored)),
        preview: toPublicPreview(stored),
        writtenFiles: [],
        warnings: stored.warnings
      };
      await this.notifyCompletion(onComplete, response);
    } catch (error) {
      const response: AgentMessageResponse = {
        ok: false,
        action: "error",
        jobId,
        runId: run.id,
        reply: `处理失败：${messageOf(error)}`,
        writtenFiles: [],
        warnings: [messageOf(error)]
      };
      await this.notifyCompletion(onComplete, response);
    }
  }

  private async notifyCompletion(
    onComplete: ((response: AgentMessageResponse) => Promise<void> | void) | undefined,
    response: AgentMessageResponse
  ): Promise<void> {
    try {
      await onComplete?.(response);
    } catch {
      // Platform replies are best-effort. The job/run state above is the source of truth.
    }
  }

  async handleAgentMessage(request: AgentMessageRequest): Promise<AgentMessageResponse> {
    const cacheKey = `${request.source}:${request.senderId}:${request.messageId}`;
    const cached = this.agentCache.get(cacheKey);
    if (cached) return cached;
    const response = await runAgentGraph(
      {
        preview: (previewRequest) => this.preview(previewRequest),
        confirm: (confirmRequest) => this.confirm(confirmRequest),
        findPendingPreview: (source, senderId) => this.findPendingPreview(source, senderId)
      },
      request
    );
    this.agentCache.set(cacheKey, response);
    return response;
  }

  recentPreviews(limit = 30) {
    return this.store.list(limit).map((preview) => ({
      previewId: preview.previewId,
      status: preview.status,
      source: preview.request.source,
      senderId: preview.request.senderId,
      messageId: preview.request.messageId,
      createdAt: preview.createdAt,
      summary: preview.summary,
      projects: preview.detectedProjects.map((project) => project.githubRepo ?? project.name),
      knowledge: preview.knowledge.map((item) => ({ title: item.title, category: item.category })),
      ideas: preview.ideas.map((item) => item.title),
      noteCount: preview.notesToWrite.length,
      warnings: preview.warnings
    }));
  }

  activity(limit = 80) {
    const dbSteps = this.repo.listRecentSteps(limit);
    if (dbSteps.length) {
      return dbSteps.map((step) => ({
        id: step.id,
        runId: step.runId,
        jobId: step.jobId,
        previewId: undefined,
        createdAt: step.createdAt,
        step: nodeLabel(step.nodeName),
        detail: [step.outputSummary, step.error].filter(Boolean).join(" / ") || step.inputSummary || step.toolName || step.nodeName,
        status: stepStatusToActivity(step.status)
      }));
    }
    return this.store
      .list(30)
      .flatMap((preview) => buildActivityItems(preview))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async confirm(request: ConfirmRequest): Promise<ConfirmResult> {
    const stored = this.store.get(request.previewId) ?? this.repo.getStoredPreview(request.previewId) ?? this.reconstructStoredPreview(request.previewId);
    if (!stored) {
      throw new Error(`Preview not found: ${request.previewId}`);
    }
    if (request.extraText?.trim()) {
      const regenerated = await this.preview({
        ...stored.request,
        text: `${stored.request.text}\n\n补充信息：${request.extraText.trim()}`,
        messageId: `${stored.request.messageId}:regen:${Date.now()}`
      });
      stored.status = "cancelled";
      this.store.update(stored);
      this.repo.updatePreviewStatus(stored.previewId, "cancelled");
      return { previewId: regenerated.previewId, status: "regenerated", writtenFiles: [], preview: regenerated };
    }
    if (request.decision === "cancel") {
      stored.status = "cancelled";
      this.store.update(stored);
      this.repo.updatePreviewStatus(stored.previewId, "cancelled");
      const tracking = this.previewRuns.get(stored.previewId) ?? this.trackingForPreview(stored.previewId);
      if (tracking) this.repo.updateJob(tracking.jobId, { status: "cancelled", currentNode: "cancel_preview", finishedAt: nowIso() });
      return { previewId: stored.previewId, status: "cancelled", writtenFiles: [] };
    }
    if (stored.status === "confirmed") {
      return {
        previewId: stored.previewId,
        status: "confirmed",
        writtenFiles: [],
        alreadyCommitted: true,
        plannedFiles: stored.notesToWrite.map((note) => note.path)
      };
    }

    const notes = buildNotes(stored);
    const plan = await this.vault.planNotes(notes);
    notes.forEach((note, index) => {
      note.operation = plan[index]?.operation ?? note.operation;
      note.reason = plan[index]?.reason ?? note.reason;
      note.confidence = plan[index]?.confidence ?? note.confidence;
    });
    const writtenFiles = await this.vault.writeNotes(notes);
    stored.status = "confirmed";
    this.store.update(stored);
    const tracking = this.previewRuns.get(stored.previewId) ?? this.trackingForPreview(stored.previewId);
    if (tracking) this.repo.savePreview(stored, tracking.jobId, tracking.runId, markdownPreview(stored));
    if (tracking) {
      this.repo.updatePreviewStatus(stored.previewId, "confirmed");
      this.repo.updateJob(tracking.jobId, { status: "committed", currentNode: "vault_writer", finishedAt: nowIso() });
      this.repo.addStep({
        runId: tracking.runId,
        jobId: tracking.jobId,
        nodeName: "vault_writer",
        status: "success",
        inputSummary: `${notes.length} notes`,
        outputSummary: `${writtenFiles.length} files`
      });
      for (const note of notes) {
        this.repo.registerVaultFile({
          noteId: slugify(note.relativePath),
          title: note.title,
          path: note.relativePath,
          type: note.type,
          githubRepo: note.githubRepo,
          sourceUrls: note.sourceUrls,
          sourceIds: note.sourceIds,
          entities: note.entities,
          domains: note.domains,
          contentHash: noteContentHash(note.content)
        });
      }
    }
    return { previewId: stored.previewId, status: "confirmed", writtenFiles };
  }

  jobs(limit = 50) {
    return this.repo.listJobs(limit);
  }

  job(jobId: string) {
    return this.repo.getJob(jobId);
  }

  runs(limit = 50) {
    return this.repo.listRuns(limit);
  }

  run(runId: string) {
    return this.repo.getRun(runId);
  }

  runSteps(runId: string) {
    return this.repo.listRunSteps(runId);
  }

  runToolCalls(runId: string) {
    return this.repo.listRunToolCalls(runId);
  }

  sessions(limit = 50) {
    return this.repo.listConversationSessions(limit);
  }

  session(sessionId: string) {
    const session = this.repo.getConversationSession(sessionId);
    if (!session) return undefined;
    return { ...session, turns: this.repo.listConversationTurns(sessionId) };
  }

  closeSession(sessionId: string) {
    return this.repo.closeConversationSession(sessionId);
  }

  intentLogs(limit = 80) {
    return this.repo.listIntentLogs(limit);
  }

  debugIntent(request: AgentMessageRequest) {
    return classifyAgentIntentV2(request.text, {
      hasOpenIdeaSession: this.ideaConversation.hasOpenSession(request),
      hasPendingPreview: Boolean(this.findPendingPreview(request.source, request.senderId))
    });
  }

  dbPreviews(limit = 50, status?: string) {
    return this.repo.listPreviews(limit, status);
  }

  dbPreview(previewId: string) {
    return this.repo.getPreview(previewId);
  }

  async retryRun(runId: string): Promise<IngestPreview & { jobId: string; runId: string; status: "waiting_user" }> {
    const previousRun = this.repo.getRun(runId);
    if (!previousRun) throw new Error(`Run not found: ${runId}`);
    const job = this.repo.getJob(previousRun.jobId);
    if (!job) throw new Error(`Job not found for run: ${runId}`);
    const message = job.messageRecordId ? this.repo.getIncomingMessage(job.messageRecordId) : undefined;
    if (!message) throw new Error(`Job ${job.id} has no incoming message to retry`);

    if (job.previewId) this.repo.updatePreviewStatus(job.previewId, "expired");
    this.repo.incrementJobRetry(job.id);
    const request: PreviewRequest = {
      text: message.text,
      source: job.source,
      senderId: job.senderId,
      messageId: message.messageId
    };
    const run = this.repo.createRun({
      jobId: job.id,
      status: "running",
      inputState: {
        retryOfRunId: previousRun.id,
        job: { jobId: job.id, source: job.source, senderId: job.senderId, messageId: message.messageId },
        input: { rawText: message.text }
      }
    });
    this.repo.updateJob(job.id, {
      status: "running",
      currentNode: "load_context",
      previewId: null,
      errorSummary: null,
      startedAt: nowIso(),
      finishedAt: null
    });
    const stored = await this.runPreviewWithTracking(request, { jobId: job.id, runId: run.id });
    return { ...toPublicPreview(stored), jobId: job.id, runId: run.id, status: "waiting_user" };
  }

  findPendingPreview(source: AgentMessageRequest["source"], senderId: string) {
    return this.store.list(50).find((preview) => preview.status === "pending" && preview.request.source === source && preview.request.senderId === senderId)
      ?? this.repo.getLatestPendingPreview(source, senderId);
  }

  private async handlePreviewTextAction(request: AgentMessageRequest): Promise<AgentMessageResponse | undefined> {
    const clean = request.text.trim();
    const pending = this.findPendingPreview(request.source, request.senderId);
    if (!pending) return undefined;
    const stored = this.store.get(pending.previewId) ?? this.repo.getStoredPreview(pending.previewId) ?? this.reconstructStoredPreview(pending.previewId);
    const isKnowledge = stored ? stored.detectedProjects.length === 0 && stored.knowledge.length > 0 : pending.detectedProjects.length === 0 && pending.knowledge.length > 0;
    if (/^(生成应用想法|只联想|展开想法)$/i.test(clean)) {
      const ideas = stored?.ideas ?? pending.ideas ?? [];
      return {
        ok: true,
        action: "chat_reply",
        previewId: pending.previewId,
        reply: formatIdeasReply(pending.previewId, ideas),
        writtenFiles: [],
        warnings: []
      };
    }
    if (/^(入库知识|只入库|入库)$/i.test(clean)) {
      const result = await this.confirm({ previewId: pending.previewId, decision: "confirm", writeMode: isKnowledge ? "knowledge_only" : "default" });
      return {
        ok: true,
        action: "confirmed",
        previewId: result.previewId,
        reply: formatConfirmReply(result),
        writtenFiles: result.writtenFiles,
        warnings: []
      };
    }
    if (/^(入库并保存想法|入库并联想|入库并展开)$/i.test(clean)) {
      const result = await this.confirm({ previewId: pending.previewId, decision: "confirm", writeMode: isKnowledge ? "knowledge_only" : "default" });
      const ideas = stored?.ideas ?? pending.ideas ?? [];
      return {
        ok: true,
        action: "confirmed",
        previewId: result.previewId,
        reply: [formatConfirmReply(result), "", formatIdeasReply(pending.previewId, ideas)].join("\n"),
        writtenFiles: result.writtenFiles,
        warnings: []
      };
    }
    return undefined;
  }

  private trackingForPreview(previewId: string): { jobId: string; runId: string } | undefined {
    const row = this.repo.getPreview(previewId);
    return row ? { jobId: row.jobId, runId: row.runId } : undefined;
  }

  private reconstructStoredPreview(previewId: string): StoredPreview | undefined {
    const preview = this.repo.getPreview(previewId);
    if (!preview) return undefined;
    const job = this.repo.getJob(preview.jobId);
    const message = job?.messageRecordId ? this.repo.getIncomingMessage(job.messageRecordId) : undefined;
    const rawText = message?.text ?? preview.summary;
    const urls = extractUrls(rawText);
    return {
      previewId: preview.previewId,
      summary: preview.summary,
      detectedProjects: preview.detectedProjects,
      notesToWrite: preview.notesToWrite,
      knowledge: preview.knowledge,
      ideas: preview.ideas,
      warnings: [...preview.warnings, "这是从旧版 preview 记录恢复的草稿，来源/OCR/GitHub 细节可能不完整。"],
      request: {
        text: rawText,
        source: preview.source,
        senderId: preview.senderId,
        messageId: message?.messageId ?? preview.previewId
      },
      parsedInput: {
        rawText,
        urls,
        githubRepos: [],
        douyinUrls: urls.filter((url) => /douyin\.com|iesdouyin\.com|v\.douyin\.com/i.test(url)),
        candidateQuery: rawText.replace(/https?:\/\/\S+/g, "").trim()
      },
      douyin: [],
      ocr: [],
      githubRepos: [],
      createdAt: preview.createdAt,
      status: preview.status === "confirmed" ? "confirmed" : preview.status === "cancelled" ? "cancelled" : "pending"
    };
  }

  private startRun(request: PreviewRequest, intentType: "new_ingest" | "supplement_preview") {
    const incoming = this.repo.createIncomingMessage({
      source: request.source,
      senderId: request.senderId,
      messageId: request.messageId,
      text: request.text,
      normalizedPayload: request
    });
    if (incoming.duplicate) {
      throw new Error(`Duplicate message is already received but not yet assigned to a job: ${request.source}/${request.messageId}`);
    }
    const job = this.repo.createJob({
      messageRecordId: incoming.record.id,
      source: request.source,
      senderId: request.senderId,
      status: "running",
      intentType
    });
    this.repo.markIncomingMessageProcessed(incoming.record.id, job.id);
    const run = this.repo.createRun({
      jobId: job.id,
      status: "running",
      inputState: {
        job: { jobId: job.id, source: request.source, senderId: request.senderId, messageId: request.messageId },
        input: { rawText: request.text }
      }
    });
    this.repo.updateJob(job.id, { currentNode: "load_context", startedAt: nowIso() });
    return { jobId: job.id, runId: run.id };
  }

  private duplicatePreview(request: PreviewRequest): IngestPreview | undefined {
    const incoming = this.repo.getIncomingMessageBySourceMessageId(request.source, request.messageId);
    if (!incoming?.jobId) return undefined;
    const job = this.repo.getJob(incoming.jobId);
    if (!job) return undefined;
    if (job.previewId) {
      const stored = this.store.get(job.previewId) ?? this.repo.getStoredPreview(job.previewId) ?? this.reconstructStoredPreview(job.previewId);
      if (stored) return toPublicPreview(stored);
    }
    if (job.status === "failed") {
      throw new Error(`Duplicate message already failed in job ${job.id}: ${job.errorSummary ?? "unknown error"}`);
    }
    throw new Error(`Duplicate message is already being processed in job ${job.id} (${job.status})`);
  }

  private duplicateQueuedResponse(request: AgentMessageRequest): AgentMessageResponse | undefined {
    const incoming = this.repo.getIncomingMessageBySourceMessageId(request.source, request.messageId);
    if (!incoming?.jobId) return undefined;
    const job = this.repo.getJob(incoming.jobId);
    if (!job) return undefined;
    if (job.previewId) {
      const stored = this.store.get(job.previewId) ?? this.repo.getStoredPreview(job.previewId) ?? this.reconstructStoredPreview(job.previewId);
      if (stored) {
        const preview = toPublicPreview(stored);
        return {
          ok: true,
          action: "preview_generated",
          jobId: job.id,
          previewId: preview.previewId,
          reply: formatQueuedPreviewReply(preview),
          preview,
          writtenFiles: [],
          warnings: preview.warnings
        };
      }
    }
    if (job.status === "failed") {
      return {
        ok: false,
        action: "error",
        jobId: job.id,
        reply: `这条消息之前处理失败：${job.errorSummary ?? "unknown error"}`,
        writtenFiles: [],
        warnings: [job.errorSummary ?? "unknown error"]
      };
    }
    return queuedResponse({ jobId: job.id, source: request.source, status: job.status });
  }

  private setNode(tracking: { jobId: string; runId: string }, nodeName: string) {
    this.repo.updateJob(tracking.jobId, { currentNode: nodeName });
  }

  private finishStep(
    tracking: { jobId: string; runId: string },
    nodeName: string,
    status: "running" | "success" | "warning" | "failed" | "skipped",
    inputSummary?: string,
    outputSummary?: string,
    toolName?: string,
    durationMs?: number,
    error?: string
  ) {
    this.repo.addStep({ runId: tracking.runId, jobId: tracking.jobId, nodeName, status, inputSummary, outputSummary, toolName, durationMs, error });
  }
}

function toPublicPreview(stored: StoredPreview): IngestPreview {
  return {
    previewId: stored.previewId,
    summary: stored.summary,
    detectedProjects: stored.detectedProjects,
    notesToWrite: stored.notesToWrite,
    knowledge: stored.knowledge,
    ideas: stored.ideas,
    warnings: stored.warnings
  };
}

function markdownPreview(stored: StoredPreview): string {
  return buildNotes(stored)
    .map((note) => `<!-- ${note.type}: ${note.relativePath} -->\n${note.content}`)
    .join("\n\n---\n\n");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function queuedResponse(input: { jobId?: string; source: string; status?: string }): AgentMessageResponse {
  return {
    ok: true,
    action: "queued",
    jobId: input.jobId,
    reply: `已收到，已进入后台队列${input.status ? `（当前状态：${input.status}）` : ""}。处理完成后会返回预览，请稍等。`,
    writtenFiles: [],
    warnings: []
  };
}

export function isImmediateChatIntent(text: string): boolean {
  const kind = classifyMessageIntent(text).kind;
  return ["casual_chat", "help", "status", "confirm_preview", "cancel_preview", "supplement_preview"].includes(kind);
}

function formatQueuedPreviewReply(preview: IngestPreview): string {
  const hasProject = preview.detectedProjects.length > 0;
  return [
    "我已经生成预览，还没有写入 Obsidian。",
    "回复“确认”写入，回复“取消”丢弃，回复“补充：...”重新生成。",
    "",
    `摘要：${preview.summary}`,
    preview.detectedProjects.length ? `识别项目：${preview.detectedProjects.map((item) => item.githubRepo ?? item.name).join("、")}` : "",
    !preview.detectedProjects.length && preview.knowledge.length ? `识别知识：${preview.knowledge.map((item) => `${item.category}/${item.title}`).slice(0, 3).join("、")}` : "",
    hasProject && preview.ideas.length ? `联动分析：${preview.ideas.map((item) => item.title).slice(0, 5).join("、")}` : "",
    hasProject ? `计划写入：${preview.notesToWrite.length} 个项目文件（联动分析只放在预览和项目卡内部）` : `计划写入：${preview.notesToWrite.length} 个文件`,
    preview.warnings.length ? `注意：${preview.warnings.slice(0, 2).join("；")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function formatIdeasReply(previewId: string, ideas: StoredPreview["ideas"]): string {
  if (!ideas.length) return `这次预览没有生成应用想法。\nPreview：${previewId}`;
  return [
    `应用想法：${previewId}`,
    ...ideas.slice(0, 5).map((idea, index) =>
      [
        `${index + 1}. ${idea.title}`,
        `产品设想：${idea.productConcept}`,
        `最小实验：${idea.minimalExperiment}`,
        `下一步：${idea.nextAction}`
      ].join("\n")
    )
  ].join("\n\n");
}

function formatConfirmReply(result: ConfirmResult): string {
  if (result.alreadyCommitted) {
    return [
      "这条预览已经入库过，本次没有重复写入。",
      result.plannedFiles?.length ? `已关联：${result.plannedFiles.slice(0, 5).join("、")}` : ""
    ].filter(Boolean).join("\n");
  }
  return [`已写入 Obsidian。`, `写入：${result.writtenFiles.length} 个文件`].join("\n");
}

function nodeLabel(nodeName: string): string {
  const labels: Record<string, string> = {
    load_context: "读取任务上下文",
    intent_router: "判断用户意图",
    parse_input: "解析输入",
    source_type_router: "选择处理路线",
    douyin_pipeline: "抖音解析与视频理解",
    github_pipeline: "GitHub 研究",
    webpage_pipeline: "网页内容提取",
    plain_text_pipeline: "自然语言理解",
    mixed_input_pipeline: "多来源合并",
    research_collector: "汇总研究事实",
    vault_context_retriever: "检索已有知识库",
    knowledge_extractor: "抽取知识卡片",
    idea_generator: "生成组合创意",
    action_generator: "生成行动建议",
    note_planner: "规划写入文件",
    preview_builder: "构建预览",
    quality_checker: "质量检查",
    reply_builder: "生成回复",
    vault_writer: "写入 Obsidian",
    failure_handler: "失败兜底"
  };
  return labels[nodeName] ?? nodeName;
}

function stepStatusToActivity(status: "running" | "success" | "warning" | "failed" | "skipped") {
  if (status === "failed") return "error";
  if (status === "warning" || status === "skipped") return "warning";
  return "success";
}

function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s)）]+/g)].map((match) => match[0]);
}

function buildActivityItems(preview: StoredPreview) {
  const items = [
    activityItem(preview, "接收消息", `${preview.request.source} / ${preview.request.senderId}`, "success"),
    activityItem(preview, "解析输入", `${preview.parsedInput.urls.length} 个链接，${preview.parsedInput.githubRepos.length} 个 GitHub 候选`, "success")
  ];
  if (preview.douyin.length) {
    const imageCount = preview.douyin.reduce((sum, item) => sum + (item.images?.length ?? 0), 0);
    items.push(activityItem(preview, "抖音解析", `${preview.douyin.length} 个来源，${imageCount} 张图片`, "success"));
  }
  if (preview.ocr.length) {
    const mediaCount = preview.ocr.reduce((sum, item) => sum + item.framesAnalyzed, 0);
    const hasError = preview.ocr.some((item) => item.error);
    items.push(activityItem(preview, "视频/图片 OCR", `${mediaCount} 个媒体单元，${preview.ocr.filter((item) => item.text.trim()).length} 段文本`, hasError ? "warning" : "success"));
  }
  if (preview.githubRepos.length) {
    items.push(activityItem(preview, "GitHub 研究", preview.githubRepos.map((repo) => repo.fullName).join("、"), "success"));
  }
  items.push(activityItem(preview, "AI 分类联想", `${preview.knowledge.length} 个知识卡片，${preview.ideas.length} 个创意`, preview.warnings.length ? "warning" : "success"));
  if (preview.status === "confirmed") {
    items.push(activityItem(preview, "写入 Obsidian", `${preview.notesToWrite.length} 个 Markdown 文件`, "success"));
  } else if (preview.status === "cancelled") {
    items.push(activityItem(preview, "取消写入", "用户取消或重新生成", "warning"));
  }
  return items;
}

function activityItem(preview: StoredPreview, step: string, detail: string, status: "success" | "warning" | "error") {
  return {
    id: `${preview.previewId}:${step}`,
    previewId: preview.previewId,
    createdAt: preview.createdAt,
    step,
    detail,
    status
  };
}
