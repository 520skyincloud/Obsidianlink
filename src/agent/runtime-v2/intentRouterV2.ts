import { classifyMessageIntent, hasIdeaSaveSignal } from "../../intentRouter.js";
import { AgentIntentV2, AgentIntentV2Kind } from "../../types.js";

export interface IntentRouterV2Context {
  hasOpenIdeaSession?: boolean;
  hasPendingPreview?: boolean;
  conversationMode?: string;
}

export function classifyAgentIntentV2(text: string, context: IntentRouterV2Context = {}): AgentIntentV2 {
  const clean = text.trim();
  const base = classifyMessageIntent(clean, {
    hasOpenIdeaSession: context.hasOpenIdeaSession || context.conversationMode === "discussing_idea",
    hasPendingPreview: context.hasPendingPreview
  });
  let intent: AgentIntentV2Kind = "unknown";
  let reason = base.reason;
  const knowledgeQuestion = looksLikeKnowledgeQuestion(clean);

  if (base.kind === "source_ingest" && base.reason === "github_project_lookup") {
    intent = "github_project_lookup";
  } else if (base.kind !== "source_ingest" && knowledgeQuestion) {
    intent = "knowledge_question";
    reason = "knowledge_question_keywords";
  } else if (base.kind === "source_ingest" || base.kind === "knowledge_ingest") {
    intent = "source_ingest";
  } else if (base.kind === "idea_chat" && hasIdeaSaveSignal(clean) && (context.hasOpenIdeaSession || context.conversationMode === "discussing_idea")) {
    intent = "save_current_idea";
    reason = "save_open_idea_session";
  } else if (base.kind === "idea_chat") {
    intent = "idea_chat";
  } else if (base.kind === "supplement_preview") {
    intent = "regenerate_preview";
  } else if (base.kind === "confirm_preview") {
    intent = "confirm_preview";
  } else if (base.kind === "cancel_preview") {
    intent = "cancel_preview";
  } else if (base.kind === "help") {
    intent = "help";
  } else if (base.kind === "status") {
    intent = "status";
  } else if (base.kind === "casual_chat") {
    intent = "casual_chat";
  }

  return {
    intent,
    confidence: confidenceFor(intent, base.confidence),
    reason,
    shouldAck: shouldAck(intent),
    shouldCreatePreview: intent === "source_ingest" || intent === "github_project_lookup",
    shouldWriteVault: intent === "confirm_preview" || intent === "save_current_idea",
    needsClarification: intent === "unknown",
    sourceHint: base.sourceHint,
    entities: extractEntities(clean)
  };
}

function looksLikeKnowledgeQuestion(text: string): boolean {
  if (!/[？?]$|^(查一下|帮我查|总结一下|回忆一下|我之前|知识库里|已有知识|存过|有没有)/.test(text)) return false;
  return /知识库|之前|已有|存过|记录|项目|想法|笔记|Obsidian|obsidian|总结|相关/i.test(text);
}

function confidenceFor(intent: AgentIntentV2Kind, baseConfidence: number): number {
  if (intent === "github_project_lookup") return Math.max(baseConfidence, 0.88);
  if (intent === "save_current_idea") return Math.max(baseConfidence, 0.9);
  if (intent === "knowledge_question") return Math.max(baseConfidence, 0.78);
  if (intent === "unknown") return Math.min(baseConfidence, 0.45);
  return baseConfidence;
}

function shouldAck(intent: AgentIntentV2Kind): boolean {
  return ["source_ingest", "github_project_lookup", "idea_chat", "save_current_idea", "knowledge_question", "confirm_preview", "cancel_preview", "regenerate_preview"].includes(intent);
}

function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const match of text.matchAll(/\b[A-Za-z][A-Za-z0-9_.-]{2,}\b/g)) {
    const value = match[0].replace(/[.,;:!?]+$/, "");
    if (!/github|http|https|repo|repository|test|hello/i.test(value)) entities.add(value);
  }
  const quoted = text.match(/[“"']([^“”"']{2,40})[”"']/);
  if (quoted?.[1]) entities.add(quoted[1].trim());
  return [...entities].slice(0, 8);
}
