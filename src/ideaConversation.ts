import { OpenAIClient, IdeaConversationResult } from "./clients/openai.js";
import { Repositories } from "./database/repositories.js";
import { classifyMessageIntent, hasIdeaSaveSignal, isHardSourceText } from "./intentRouter.js";
import { ideaCardDir, inferDomains, normalizeIdeaKind } from "./knowledgeTaxonomy.js";
import { noteContentHash, ObsidianVault } from "./obsidian/vault.js";
import { AgentMessageRequest, AgentMessageResponse, GeneratedNote, IdeaKind } from "./types.js";
import { nowIso, slugify } from "./utils.js";

interface IdeaTurn {
  role: "user" | "assistant";
  content: string;
  at: string;
}

interface IdeaSession {
  sessionId: string;
  key: string;
  source: AgentMessageRequest["source"];
  senderId: string;
  chatId?: string;
  turns: IdeaTurn[];
  startedAt: string;
  updatedAt: string;
  savedAt?: string;
}

export class IdeaConversationService {
  private readonly sessions = new Map<string, IdeaSession>();

  constructor(
    private readonly vault: ObsidianVault,
    private readonly ai: OpenAIClient,
    private readonly repo: Repositories
  ) {}

  hasOpenSession(request: AgentMessageRequest): boolean {
    if (this.sessions.has(sessionKey(request))) return true;
    return this.repo.getOpenConversationSession(request.source, request.senderId, request.chatId)?.mode === "discussing_idea";
  }

  cancelOpenSession(request: AgentMessageRequest): AgentMessageResponse | undefined {
    const key = sessionKey(request);
    const session = this.sessions.get(key);
    const persisted = this.repo.getOpenConversationSession(request.source, request.senderId, request.chatId);
    const sessionId = session?.sessionId ?? persisted?.id;
    if (!sessionId) return undefined;
    if (session) this.sessions.delete(key);
    this.repo.addConversationTurn({ sessionId, role: "user", text: request.text });
    this.repo.closeConversationSession(sessionId);
    return {
      ok: true,
      action: "chat_reply",
      reply: "已取消这轮想法讨论，没有写入 Obsidian。你可以直接开始一个新想法，或者发链接让我重新识别。",
      writtenFiles: [],
      warnings: []
    };
  }

  async handle(request: AgentMessageRequest): Promise<AgentMessageResponse | undefined> {
    if (!isIdeaConversationCandidate(request.text, this.hasOpenSession(request))) return undefined;
    const session = this.sessionFor(request);
    this.appendAndPersistTurn(session, "user", request.text);
    const shouldSaveHint = hasIdeaSaveSignal(request.text);
    const result = await this.develop(session, shouldSaveHint);

    if (result.readyToSave || shouldSaveHint) {
      const note = buildIdeaNote(request, session, result);
      const writtenFiles = await this.vault.writeNotes([note]);
      this.repo.registerVaultFile({
        noteId: slugify(note.relativePath),
        title: note.title,
        path: note.relativePath,
        type: note.type,
        sourceUrls: [],
        sourceIds: [],
        entities: [],
        domains: result.domains,
        contentHash: noteContentHash(note.content)
      });
      session.savedAt = nowIso();
      this.sessions.delete(session.key);
      this.repo.closeConversationSession(session.sessionId);
      return {
        ok: true,
        action: "idea_saved",
        reply: formatSavedReply(result, writtenFiles[0]),
        writtenFiles,
        warnings: []
      };
    }

    this.appendAndPersistTurn(session, "assistant", result.reply);
    return {
      ok: true,
      action: "chat_reply",
      reply: result.reply,
      writtenFiles: [],
      warnings: []
    };
  }

  private sessionFor(request: AgentMessageRequest): IdeaSession {
    const key = sessionKey(request);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.chatId = request.chatId ?? existing.chatId;
      existing.updatedAt = nowIso();
      return existing;
    }
    const persisted = this.repo.getOpenConversationSession(request.source, request.senderId, request.chatId)
      ?? this.repo.upsertConversationSession({
        source: request.source,
        senderId: request.senderId,
        chatId: request.chatId,
        mode: "discussing_idea",
        topic: request.text.slice(0, 40)
      });
    const persistedTurns = this.repo.listConversationTurns(persisted.id)
      .filter((turn) => turn.role === "user" || turn.role === "assistant")
      .map((turn) => ({
        role: turn.role as IdeaTurn["role"],
        content: turn.text,
        at: turn.createdAt
      }));
    const now = nowIso();
    const session: IdeaSession = {
      sessionId: persisted.id,
      key,
      source: request.source,
      senderId: request.senderId,
      chatId: request.chatId,
      turns: persistedTurns.slice(-12),
      startedAt: persisted.createdAt || now,
      updatedAt: persisted.updatedAt || now
    };
    this.sessions.set(key, session);
    return session;
  }

  private appendAndPersistTurn(session: IdeaSession, role: IdeaTurn["role"], content: string): void {
    const clean = content.trim();
    if (!clean) return;
    const persistedTurns = this.repo.listConversationTurns(session.sessionId);
    const lastPersisted = persistedTurns[persistedTurns.length - 1];
    const lastMemory = session.turns[session.turns.length - 1];
    if (lastMemory?.role !== role || lastMemory.content !== clean) appendTurn(session, role, clean);
    if (lastPersisted?.role !== role || lastPersisted.text !== clean) {
      this.repo.addConversationTurn({ sessionId: session.sessionId, role, text: clean });
    }
  }

  private async develop(session: IdeaSession, shouldSaveHint: boolean): Promise<IdeaConversationResult> {
    try {
      return await this.ai.developIdeaConversation({
        messages: session.turns.map((turn) => ({ role: turn.role, content: turn.content })),
        shouldSaveHint
      });
    } catch {
      return fallbackIdeaConversation(session, shouldSaveHint);
    }
  }
}

export function isIdeaConversationCandidate(text: string, hasOpenSession = false): boolean {
  if (isHardSourceText(text)) return false;
  return classifyMessageIntent(text, { hasOpenIdeaSession: hasOpenSession }).kind === "idea_chat";
}

function appendTurn(session: IdeaSession, role: IdeaTurn["role"], content: string): void {
  session.turns.push({ role, content: content.trim(), at: nowIso() });
  session.turns = session.turns.slice(-12);
  session.updatedAt = nowIso();
}

function buildIdeaNote(request: AgentMessageRequest, session: IdeaSession, result: IdeaConversationResult): GeneratedNote {
  const created = nowIso();
  const ideaKind: IdeaKind = normalizeIdeaKind(result.ideaKind);
  const title = cleanIdeaTitle(result.title || titleFromSession(session));
  const domains = result.domains.length ? result.domains : inferDomains(`${title} ${result.summary} ${session.turns.map((turn) => turn.content).join(" ")}`);
  const relativePath = `${ideaCardDir(ideaKind)}/${slugify(title)}.md`;
  const content = `---
type: idea
title: "${escapeYaml(title)}"
idea_kind: "${ideaKind}"
source_type: "${request.source}"
domains:
${yamlList(domains)}
tags:
${yamlList(["idea", "inspiration", ideaKind, ...domains])}
status: inspiration
created: "${created}"
updated: "${created}"
---

# ${title}

## 一句话
${result.summary || "从对话中沉淀出来的开发/产品灵感。"}

## 已经聊清楚的点
${listOrFallback(result.clarifiedPoints)}

## 还需要补的问题
${listOrFallback(result.openQuestions)}

## 最小实验
${result.minimalExperiment || "先做一个最小原型，验证这个想法是否真的有使用价值。"}

## 下一步
${result.nextAction || "补充目标用户、核心场景和第一版功能边界。"}

## 对话摘录
${session.turns.map((turn) => `- ${turn.role === "user" ? "我" : "智能体"}：${turn.content}`).join("\n")}
`;
  return {
    title,
    relativePath,
    content,
    type: "idea",
    operation: "create",
    reason: "开发想法对话已澄清，直接沉淀为灵感卡",
    confidence: 0.78,
    domains
  };
}

function fallbackIdeaConversation(session: IdeaSession, shouldSaveHint: boolean): IdeaConversationResult {
  const userText = session.turns.filter((turn) => turn.role === "user").map((turn) => turn.content).join("\n");
  const domains = inferDomains(userText);
  const title = titleFromSession(session);
  if (shouldSaveHint) {
    return {
      readyToSave: true,
      reply: "我先把这个想法沉淀成一张灵感卡，后面可以继续扩展成项目方案。",
      title,
      summary: userText.split(/\n/)[0]?.slice(0, 120) || "开发想法灵感",
      clarifiedPoints: userText.split(/\n/).filter(Boolean).slice(0, 5),
      openQuestions: ["目标用户是谁？", "第一版最小验证怎么做？"],
      domains,
      ideaKind: "product",
      minimalExperiment: "用一页文档或一个最小 Demo 验证核心流程。",
      nextAction: "补充目标用户、使用场景和第一版功能边界。"
    };
  }
  return {
    readyToSave: false,
    reply: [
      "我理解这是一个可以继续展开的开发想法，我先不入库。",
      "现在我想帮你把它收紧一点：它主要解决谁的什么问题？第一版只保留哪一个核心动作？你希望它最后是工具、Bot、网页应用，还是接入现有系统的自动化流程？"
    ].join("\n"),
    title,
    summary: userText.slice(0, 120),
    clarifiedPoints: [],
    openQuestions: ["目标用户", "核心问题", "第一版形态"],
    domains,
    ideaKind: "product",
    minimalExperiment: "",
    nextAction: ""
  };
}

function formatSavedReply(result: IdeaConversationResult, file?: string): string {
  return [
    "我已经把这个想法沉淀成 Obsidian 灵感卡。",
    "",
    `标题：${result.title}`,
    `一句话：${result.summary}`,
    result.minimalExperiment ? `最小实验：${result.minimalExperiment}` : "",
    file ? `写入：${file}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function titleFromSession(session: IdeaSession): string {
  const first = session.turns.find((turn) => turn.role === "user")?.content ?? "开发想法灵感";
  const normalized = first
    .replace(/^(我想|我希望|想法|点子|灵感|我有个开发点子|我有个点子)[:：]?\s*/i, "")
    .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "开发灵感卡";
  if (/做一个|做个/.test(normalized)) return cleanIdeaTitle(normalized.replace(/^.*?(做一个|做个)/, "$1"));
  return cleanIdeaTitle(normalized);
}

function cleanIdeaTitle(input: string): string {
  const title = input
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!title || /^(未命名想法|开发想法灵感|测试)$/i.test(title)) return "开发灵感卡";
  return title.length > 36 ? title.slice(0, 36) : title;
}

function yamlList(items: string[] | undefined): string {
  const values = items?.filter(Boolean) ?? [];
  return values.length ? values.map((item) => `  - "${escapeYaml(item)}"`).join("\n") : "  []";
}

function listOrFallback(items: string[] | undefined): string {
  const values = items?.filter(Boolean) ?? [];
  return values.length ? values.map((item) => `- ${item}`).join("\n") : "- 待补充";
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sessionKey(request: AgentMessageRequest): string {
  return `${request.source}:${request.senderId}`;
}
