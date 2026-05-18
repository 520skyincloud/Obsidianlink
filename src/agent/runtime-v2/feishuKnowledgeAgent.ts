import { Annotation, END, START, StateGraph } from "#langgraph";
import { Repositories } from "../../database/repositories.js";
import { AgentIntentV2, AgentMessageRequest, ConversationSessionRecord } from "../../types.js";
import { classifyAgentIntentV2 } from "./intentRouterV2.js";

export interface FeishuKnowledgeAgentV2Deps {
  request: AgentMessageRequest;
  repo: Repositories;
  hasOpenIdeaSession?: boolean;
  hasPendingPreview?: boolean;
}

export interface FeishuKnowledgeAgentV2Result {
  intent: AgentIntentV2;
  conversation?: ConversationSessionRecord;
  shouldQueuePreview: boolean;
  shouldUseIdeaConversation: boolean;
  shouldHandlePreviewAction: boolean;
  reply?: string;
}

const FeishuAgentState = Annotation.Root({
  request: Annotation<AgentMessageRequest>,
  conversation: Annotation<ConversationSessionRecord | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  intent: Annotation<AgentIntentV2 | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  reply: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => ""
  })
});

export async function runFeishuKnowledgeAgentV2(deps: FeishuKnowledgeAgentV2Deps): Promise<FeishuKnowledgeAgentV2Result> {
  const graph = new StateGraph(FeishuAgentState)
    .addNode("load_context", (state) => state)
    .addNode("conversation_retriever", (state) => {
      const conversation = deps.repo.getOpenConversationSession(state.request.source, state.request.senderId, state.request.chatId);
      return { conversation };
    })
    .addNode("intent_router_v2", (state) => {
      const intent = classifyAgentIntentV2(state.request.text, {
        hasOpenIdeaSession: deps.hasOpenIdeaSession || state.conversation?.mode === "discussing_idea",
        hasPendingPreview: deps.hasPendingPreview,
        conversationMode: state.conversation?.mode
      });
      deps.repo.addIntentLog({
        source: state.request.source,
        senderId: state.request.senderId,
        chatId: state.request.chatId,
        messageId: state.request.messageId,
        text: state.request.text,
        intent
      });
      return { intent };
    })
    .addNode("immediate_ack_planner", (state) => state)
    .addNode("route_by_intent", (state) => state)
    .addNode("source_parser", (state) => state)
    .addNode("github_project_lookup", (state) => state)
    .addNode("douyin_or_web_research", (state) => state)
    .addNode("idea_conversation", (state) => state)
    .addNode("vault_context_retriever", (state) => state)
    .addNode("knowledge_question_answerer", (state) => state)
    .addNode("note_policy_planner", (state) => state)
    .addNode("feishu_reply_planner", (state) => ({ reply: planImmediateReply(state.intent) }))
    .addNode("vault_commit", (state) => state)
    .addNode("session_updater", (state) => {
      if (!state.intent) return {};
      const session = updateSession(deps.repo, state.request, state.intent, state.conversation);
      return { conversation: session ?? state.conversation };
    })
    .addNode("final_logger", (state) => state)
    .addEdge(START, "load_context")
    .addEdge("load_context", "conversation_retriever")
    .addEdge("conversation_retriever", "intent_router_v2")
    .addEdge("intent_router_v2", "immediate_ack_planner")
    .addEdge("immediate_ack_planner", "route_by_intent")
    .addEdge("route_by_intent", "source_parser")
    .addEdge("source_parser", "github_project_lookup")
    .addEdge("github_project_lookup", "douyin_or_web_research")
    .addEdge("douyin_or_web_research", "idea_conversation")
    .addEdge("idea_conversation", "vault_context_retriever")
    .addEdge("vault_context_retriever", "knowledge_question_answerer")
    .addEdge("knowledge_question_answerer", "note_policy_planner")
    .addEdge("note_policy_planner", "feishu_reply_planner")
    .addEdge("feishu_reply_planner", "vault_commit")
    .addEdge("vault_commit", "session_updater")
    .addEdge("session_updater", "final_logger")
    .addEdge("final_logger", END)
    .compile();

  const finalState = await graph.invoke({ request: deps.request });
  const intent = finalState.intent ?? classifyAgentIntentV2(deps.request.text);
  return {
    intent,
    conversation: finalState.conversation,
    shouldQueuePreview: intent.shouldCreatePreview,
    shouldUseIdeaConversation: intent.intent === "idea_chat" || intent.intent === "save_current_idea",
    shouldHandlePreviewAction: intent.intent === "confirm_preview" || intent.intent === "cancel_preview" || intent.intent === "regenerate_preview",
    reply: finalState.reply
  };
}

function updateSession(
  repo: Repositories,
  request: AgentMessageRequest,
  intent: AgentIntentV2,
  existing?: ConversationSessionRecord
): ConversationSessionRecord | undefined {
  if (intent.intent === "idea_chat") {
    const session = repo.upsertConversationSession({
      id: existing?.id,
      source: request.source,
      senderId: request.senderId,
      chatId: request.chatId,
      mode: "discussing_idea",
      topic: inferTopic(request.text)
    });
    repo.addConversationTurn({ sessionId: session.id, role: "user", text: request.text, intent });
    return session;
  }
  if (intent.intent === "save_current_idea" && existing) {
    repo.addConversationTurn({ sessionId: existing.id, role: "user", text: request.text, intent });
    return existing;
  }
  if (intent.intent === "source_ingest" || intent.intent === "github_project_lookup") {
    const session = repo.upsertConversationSession({
      id: existing?.mode === "waiting_preview_decision" ? existing.id : undefined,
      source: request.source,
      senderId: request.senderId,
      chatId: request.chatId,
      mode: intent.intent === "github_project_lookup" ? "researching_project" : "waiting_preview_decision",
      topic: intent.entities[0] ?? intent.sourceHint ?? "source"
    });
    repo.addConversationTurn({ sessionId: session.id, role: "user", text: request.text, intent });
    return session;
  }
  if (intent.intent === "knowledge_question") {
    const session = repo.upsertConversationSession({
      id: existing?.mode === "answering_knowledge" ? existing.id : undefined,
      source: request.source,
      senderId: request.senderId,
      chatId: request.chatId,
      mode: "answering_knowledge",
      topic: inferTopic(request.text)
    });
    repo.addConversationTurn({ sessionId: session.id, role: "user", text: request.text, intent });
    return session;
  }
  return existing;
}

function planImmediateReply(intent?: AgentIntentV2): string {
  if (!intent) return "";
  if (intent.intent === "casual_chat") return "我在。你可以直接发抖音链接、GitHub 项目名，或者跟我聊一个开发想法。";
  if (intent.intent === "help") return "你可以发：抖音链接、网页/GitHub 链接、去 GitHub 找某个项目、一个开发想法，或者回复“保存刚才这个”。";
  if (intent.intent === "status") return "我会从任务队列、待确认预览和最近运行记录里查状态。";
  if (intent.intent === "knowledge_question") return "收到，我会优先按知识库问答来处理，不会直接入库。";
  return "";
}

function inferTopic(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 40);
}
