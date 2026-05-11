import { Annotation, END, START, StateGraph } from "#langgraph";
import {
  AgentMessageRequest,
  AgentMessageResponse,
  ConfirmResult,
  IngestPreview,
  PreviewRequest,
  SourceKind
} from "./types.js";
import { classifyMessageIntent } from "./intentRouter.js";

interface AgentGraphDeps {
  preview: (request: PreviewRequest) => Promise<IngestPreview>;
  confirm: (request: { previewId: string; decision: "confirm" | "cancel"; extraText?: string }) => Promise<ConfirmResult>;
  findPendingPreview: (source: SourceKind, senderId: string) => IngestPreview | { previewId: string; summary: string; warnings?: string[] } | undefined;
}

type ChatIntent = "new_ingest" | "confirm_preview" | "cancel_preview" | "supplement_preview" | "query_status" | "ignored";

const AgentState = Annotation.Root({
  request: Annotation<AgentMessageRequest>,
  intent: Annotation<ChatIntent>({
    reducer: (_left, right) => right,
    default: () => "new_ingest"
  }),
  extraText: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  pendingPreviewId: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  ignored: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false
  }),
  preview: Annotation<IngestPreview | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  result: Annotation<ConfirmResult | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  error: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  response: Annotation<AgentMessageResponse | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  })
});

export async function runAgentGraph(deps: AgentGraphDeps, request: AgentMessageRequest): Promise<AgentMessageResponse> {
  const graph = new StateGraph(AgentState)
    .addNode("classify", async (state) => {
      const pending = deps.findPendingPreview(state.request.source, state.request.senderId);
      const parsed = classifyChatIntent(state.request.text, Boolean(pending));
      return {
        intent: parsed.intent,
        extraText: parsed.extraText,
        pendingPreviewId: pending?.previewId,
        ignored: parsed.intent === "ignored"
      };
    })
    .addNode("make_preview", async (state) => {
      if (state.ignored || state.intent !== "new_ingest") return {};
      try {
        return { preview: await deps.preview({ ...state.request, messageId: state.request.messageId }) };
      } catch (error) {
        return { error: messageOf(error) };
      }
    })
    .addNode("apply_decision", async (state) => {
      if (state.ignored || state.error || state.intent === "new_ingest" || state.intent === "query_status") return {};
      if (!state.pendingPreviewId) return { error: "没有找到待确认的预览。请先发送一个链接或想法生成预览。" };
      try {
        if (state.intent === "cancel_preview") return { result: await deps.confirm({ previewId: state.pendingPreviewId, decision: "cancel" }) };
        if (state.intent === "supplement_preview") return { result: await deps.confirm({ previewId: state.pendingPreviewId, decision: "confirm", extraText: state.extraText }) };
        return { result: await deps.confirm({ previewId: state.pendingPreviewId, decision: "confirm" }) };
      } catch (error) {
        return { error: messageOf(error) };
      }
    })
    .addNode("write_notes", async (state) => {
      if (state.ignored || state.error || state.intent !== "new_ingest" || !state.preview || state.request.autoWrite === false) return {};
      try {
        return { result: await deps.confirm({ previewId: state.preview.previewId, decision: "confirm" }) };
      } catch (error) {
        return { error: messageOf(error) };
      }
    })
    .addNode("make_reply", async (state) => ({
      response: buildResponse(state)
    }))
    .addEdge(START, "classify")
    .addEdge("classify", "make_preview")
    .addEdge("make_preview", "apply_decision")
    .addEdge("apply_decision", "write_notes")
    .addEdge("write_notes", "make_reply")
    .addEdge("make_reply", END)
    .compile();

  const finalState = await graph.invoke({ request });
  if (!finalState.response) {
    throw new Error("LangGraph agent finished without a response");
  }
  return finalState.response;
}

function buildResponse(state: typeof AgentState.State): AgentMessageResponse {
  if (state.ignored) {
    return {
      ok: true,
      action: "ignored",
      reply: "我在。发我抖音链接、GitHub 链接、项目名或一句想法，我会自动整理进 Obsidian。",
      writtenFiles: [],
      warnings: []
    };
  }

  if (state.error) {
    return {
      ok: false,
      action: "error",
      reply: `入库失败：${state.error}\n你可以补充项目名/链接再发一次，我会重新处理。`,
      writtenFiles: [],
      warnings: [state.error]
    };
  }

  if (state.intent === "query_status") {
    return {
      ok: true,
      action: "ignored",
      previewId: state.pendingPreviewId,
      reply: state.pendingPreviewId
        ? `当前有一个待确认预览：${state.pendingPreviewId}\n回复“确认”写入 Obsidian，回复“取消”丢弃，回复“补充：...”重新生成。`
        : "当前没有待确认预览。发我抖音链接、GitHub 链接、项目名或一句想法即可开始。",
      writtenFiles: [],
      warnings: []
    };
  }

  if (state.intent === "confirm_preview" || state.intent === "cancel_preview" || state.intent === "supplement_preview") {
    return buildDecisionResponse(state);
  }

  if (!state.preview) {
    return {
      ok: false,
      action: "error",
      reply: "入库失败：智能体没有生成预览。",
      writtenFiles: [],
      warnings: ["missing preview"]
    };
  }

  if (state.request.autoWrite === false) {
    return {
      ok: true,
      action: "preview_generated",
      jobId: undefined,
      runId: undefined,
      reply: formatAgentPreviewReply(state.preview),
      previewId: state.preview.previewId,
      preview: state.preview,
      writtenFiles: [],
      warnings: state.preview.warnings
    };
  }

  const writtenFiles = state.result?.writtenFiles ?? [];
  return {
    ok: true,
    action: "auto_written",
    reply: formatAgentWrittenReply(state.preview, writtenFiles),
    preview: state.preview,
    writtenFiles,
    warnings: state.preview.warnings
  };
}

function buildDecisionResponse(state: typeof AgentState.State): AgentMessageResponse {
  if (!state.result) {
    return {
      ok: false,
      action: "error",
      previewId: state.pendingPreviewId,
      reply: "处理确认指令失败：没有返回写入结果。",
      writtenFiles: [],
      warnings: ["missing decision result"]
    };
  }
  if (state.result.status === "cancelled") {
    return {
      ok: true,
      action: "cancelled",
      previewId: state.result.previewId,
      reply: `已取消这次预览：${state.result.previewId}`,
      writtenFiles: [],
      warnings: []
    };
  }
  if (state.result.status === "regenerated") {
    return {
      ok: true,
      action: "regenerated",
      previewId: state.result.previewId,
      reply: state.result.preview
        ? `已根据补充信息重新生成预览：${state.result.preview.previewId}\n\n${formatAgentPreviewReply(state.result.preview)}`
        : `已根据补充信息重新生成预览：${state.result.previewId}`,
      preview: state.result.preview,
      writtenFiles: [],
      warnings: state.result.preview?.warnings ?? []
    };
  }
  return {
    ok: true,
    action: "confirmed",
    previewId: state.result.previewId,
    reply: [`已确认并写入 Obsidian。`, `写入：${state.result.writtenFiles.length} 个文件`].join("\n"),
    writtenFiles: state.result.writtenFiles,
    warnings: []
  };
}

function isIgnorableChat(text: string): boolean {
  return ["casual_chat", "help"].includes(classifyMessageIntent(text).kind);
}

function classifyChatIntent(text: string, hasPendingPreview: boolean): { intent: ChatIntent; extraText?: string } {
  const clean = text.trim();
  const routed = classifyMessageIntent(clean, { hasPendingPreview });
  if (routed.kind === "casual_chat" || routed.kind === "help") return { intent: "ignored" };
  if (routed.kind === "status") return { intent: "query_status" };
  if (routed.kind === "confirm_preview") return { intent: "confirm_preview" };
  if (routed.kind === "cancel_preview") return { intent: "cancel_preview" };
  if (routed.kind === "supplement_preview") return { intent: "supplement_preview", extraText: routed.extraText };
  if (hasPendingPreview && /^(再生成|重新生成|重做|regenerate)$/i.test(clean)) return { intent: "supplement_preview", extraText: "请根据已有上下文重新生成预览。" };
  return { intent: "new_ingest" };
}

function formatAgentPreviewReply(preview: IngestPreview): string {
  return [
    "我已经生成预览，还没有写入 Obsidian。",
    "回复“确认”写入，回复“取消”丢弃，回复“补充：...”重新生成。",
    "",
    `摘要：${preview.summary}`,
    formatDetectedLine(preview),
    `计划写入：${preview.notesToWrite.length} 个文件`,
    preview.warnings.length ? `注意：${preview.warnings.slice(0, 2).join("；")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function formatAgentWrittenReply(preview: IngestPreview, writtenFiles: string[]): string {
  const projectLine = preview.detectedProjects.length
    ? `项目：${preview.detectedProjects.map((item) => item.githubRepo ?? item.name).join("、")}`
    : "";
  const knowledgeLine = preview.knowledge.length
    ? `知识：${preview.knowledge.map((item) => `${item.category}/${item.title}`).slice(0, 3).join("、")}`
    : "";
  const ideaLine = preview.ideas.length ? `联想：${preview.ideas.map((item) => item.title).slice(0, 3).join("、")}` : "";
  const warningLine = preview.warnings.length ? `\n注意：${preview.warnings.slice(0, 2).join("；")}` : "";

  return [
    "已自动整理并写入 Obsidian。",
    "",
    `摘要：${preview.summary}`,
    projectLine,
    knowledgeLine,
    ideaLine,
    `写入：${writtenFiles.length} 个文件`,
    warningLine
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDetectedLine(preview: IngestPreview): string {
  if (preview.detectedProjects.length) {
    return `识别项目：${preview.detectedProjects.map((item) => item.githubRepo ?? item.name).join("、")}`;
  }
  if (preview.knowledge.length) {
    return `识别知识：${preview.knowledge.map((item) => `${item.category}/${item.title}`).join("、")}`;
  }
  return "识别结果：普通收件箱内容";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
