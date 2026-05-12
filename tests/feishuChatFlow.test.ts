import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server.js";
import { IngestService } from "../src/ingestService.js";
import { PreviewStore } from "../src/previewStore.js";
import { repositories } from "../src/database/repositories.js";
import { GeneratedNote, IngestPreview, StoredPreview } from "../src/types.js";

const replyMock = vi.fn(async () => ({}));
const createMock = vi.fn(async () => ({}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: vi.fn(() => ({
    im: {
      message: {
        reply: replyMock,
        create: createMock
      }
    }
  })),
  LoggerLevel: { info: "info" }
}));

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = {
    ...originalEnv,
    FEISHU_APP_ID: "cli_test",
    FEISHU_APP_SECRET: "sec_test",
    FEISHU_VERIFICATION_TOKEN: "vt_test",
    FEISHU_CARD_CALLBACK_ENABLED: "true",
    FEISHU_LONG_CONNECTION_ENABLED: "false"
  };
  replyMock.mockClear();
  createMock.mockClear();
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("Feishu chat flow", () => {
  it("replies to casual chat immediately with a styled card and does not queue a job", async () => {
    const suffix = uniqueSuffix();
    const service = {
      enqueueAgentMessage: vi.fn(async () => ({
        ok: true,
        action: "chat_reply" as const,
        reply: "我在。发我抖音链接、GitHub 链接、网页或一个想法都可以。",
        writtenFiles: [],
        warnings: []
      })),
      activity: () => [],
      recentPreviews: () => []
    };
    const { baseUrl, close } = await startTestServer(service);
    try {
      const response = await postFeishuMessage(baseUrl, `om_hi_${suffix}`, "你好");
      expect(response.status).toBe(200);
      expect((await response.json()).action).toBe("chat_reply");
      await tick();

      expect(service.enqueueAgentMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "你好", source: "feishu", senderId: "ou_test", chatId: "oc_test", messageId: `om_hi_${suffix}` }),
        expect.any(Function)
      );
      expect(createMock).not.toHaveBeenCalled();
      expect(replyMock).toHaveBeenCalledTimes(1);
      expectFeishuInteractivePayload(mockCall(replyMock, 0), "ObsidianLink");
    } finally {
      await close();
    }
  });

  it("sends a received ack first, then sends the generated preview decision card for queued source ingest", async () => {
    const suffix = uniqueSuffix();
    const preview = makePreview("pv_feishu_queued");
    const service = {
      enqueueAgentMessage: vi.fn(async (_request: unknown, onComplete?: (response: unknown) => Promise<void> | void) => {
        setTimeout(() => {
          void onComplete?.({
            ok: true,
            action: "preview_generated",
            jobId: "job_feishu_queued",
            runId: "run_feishu_queued",
            previewId: preview.previewId,
            reply: "预览已生成",
            preview,
            writtenFiles: [],
            warnings: []
          });
        }, 5);
        return {
          ok: true,
          action: "queued" as const,
          jobId: "job_feishu_queued",
          reply: "已收到，已进入后台队列。",
          writtenFiles: [],
          warnings: []
        };
      }),
      activity: () => [],
      recentPreviews: () => []
    };
    const { baseUrl, close } = await startTestServer(service);
    try {
      const response = await postFeishuMessage(baseUrl, `om_source_${suffix}`, "记录这个 GitHub 项目 https://github.com/langchain-ai/langgraph");
      expect(response.status).toBe(200);
      expect((await response.json()).action).toBe("queued");
      await waitFor(() => createMock.mock.calls.length >= 1 && replyMock.mock.calls.length >= 1);

      expectFeishuInteractivePayload(mockCall(createMock, 0), "已收到");
      const replyPayload = expectFeishuInteractivePayload(mockCall(replyMock, 0), "识别完成");
      expect(JSON.stringify(replyPayload)).toContain("只入库");
      expect(JSON.stringify(replyPayload)).toContain("只联想");
      expect(JSON.stringify(replyPayload)).toContain("入库并联想");
    } finally {
      await close();
    }
  });

  it("keeps idea messages conversational, deduplicates repeated message ids, and only saves on explicit save signal", async () => {
    const suffix = uniqueSuffix();
    const written: GeneratedNote[] = [];
    const vault = {
      writeNotes: async (notes: GeneratedNote[]) => {
        written.push(...notes);
        return notes.map((note) => `/tmp/obsidian-test/${note.relativePath}`);
      }
    };
    const ai = {
      developIdeaConversation: async (input: { shouldSaveHint: boolean; messages: Array<{ role: string; content: string }> }) => ({
        readyToSave: input.shouldSaveHint,
        reply: input.shouldSaveHint ? "已经整理为灵感卡。" : "我先帮你聊清楚：目标用户是谁？第一版只做哪个动作？",
        title: "飞书消息入口灵感",
        summary: "把多渠道消息入口变成可持续沉淀的开发灵感系统。",
        clarifiedPoints: input.messages.map((item) => item.content).slice(0, 3),
        openQuestions: ["第一版边界", "触发保存的语义"],
        domains: ["智能体", "知识管理"],
        ideaKind: "product",
        minimalExperiment: "先用飞书对话跑通三轮澄清和显式保存。",
        nextAction: "补齐飞书卡片反馈和去重测试。"
      })
    };
    const service = new IngestService(new PreviewStore(), vault as never, {} as never, {} as never, {} as never, ai as never, repositories);
    const { baseUrl, close } = await startTestServer(service);
    try {
      const first = await postFeishuMessage(baseUrl, `om_idea_a_${suffix}`, "我有个开发点子，想做一个飞书消息入口的智能体");
      const firstBody = await first.json();
      expect({ status: first.status, body: firstBody }).toMatchObject({ status: 200, body: { action: "chat_reply" } });
      expect(written).toHaveLength(0);

      const duplicate = await postFeishuMessage(baseUrl, `om_idea_a_${suffix}`, "我有个开发点子，想做一个飞书消息入口的智能体");
      expect(duplicate.status).toBe(200);
      expect((await duplicate.json()).action).toBe("ignored");
      await tick();
      expect(written).toHaveLength(0);

      const second = await postFeishuMessage(baseUrl, `om_idea_b_${suffix}`, "第一版先做飞书和网页 API，别保存，先聊清楚");
      expect(second.status).toBe(200);
      expect((await second.json()).action).toBe("chat_reply");
      expect(written).toHaveLength(0);

      const save = await postFeishuMessage(baseUrl, `om_idea_c_${suffix}`, "可以了，确认保存到 Obsidian");
      expect(save.status).toBe(200);
      expect((await save.json()).action).toBe("idea_saved");
      expect(written).toHaveLength(1);
      expect(written[0]?.type).toBe("idea");
      expect(written[0]?.relativePath).toContain("4_想法");
    } finally {
      await close();
    }
  });

  it("handles Feishu card confirm, ideate, and confirm-plus-ideate actions with user-visible feedback", async () => {
    const suffix = uniqueSuffix();
    const preview = makeStoredPreview(`pv_card_flow_${suffix}`);
    const incoming = repositories.createIncomingMessage({
      source: "feishu",
      senderId: "ou_test",
      chatId: "oc_test",
      messageId: `om_card_seed_${suffix}`,
      text: "seed",
      normalizedPayload: { text: "seed" }
    });
    const job = repositories.createJob({
      messageRecordId: incoming.record.id,
      source: "feishu",
      senderId: "ou_test",
      chatId: "oc_test",
      status: "waiting_user",
      intentType: "new_ingest"
    });
    const run = repositories.createRun({ jobId: job.id, status: "preview_generated", inputState: { text: "seed" } });
    repositories.savePreview(preview, job.id, run.id, "# markdown");
    repositories.markIncomingMessageProcessed(incoming.record.id, job.id);
    repositories.updateJob(job.id, { previewId: preview.previewId });

    const service = {
      confirm: vi.fn(async () => ({ previewId: preview.previewId, status: "confirmed" as const, writtenFiles: ["/tmp/main.md"] })),
      activity: () => [],
      recentPreviews: () => []
    };
    const { baseUrl, close } = await startTestServer(service);
    try {
      const ideate = await postFeishuCard(baseUrl, preview.previewId, "ideate", false);
      expect(ideate.status).toBe(200);
      const ideateBody = JSON.stringify(await ideate.json());
      expect(ideateBody).toContain("操作完成");
      expect(ideateBody).toContain("联想分析");

      const confirm = await postFeishuCard(baseUrl, preview.previewId, "confirm", false);
      expect(confirm.status).toBe(200);
      expect(JSON.stringify(await confirm.json())).toContain("操作完成");
      expect(service.confirm).toHaveBeenCalledWith(expect.objectContaining({ previewId: preview.previewId, decision: "confirm" }));

      const confirmIdeate = await postFeishuCard(baseUrl, preview.previewId, "confirm_ideate", false);
      expect(confirmIdeate.status).toBe(200);
      const confirmIdeateBody = JSON.stringify(await confirmIdeate.json());
      expect(confirmIdeateBody).toContain("操作完成");
      expect(confirmIdeateBody).toContain("联想分析");
    } finally {
      await close();
    }
  });
});

async function startTestServer(service: unknown) {
  const app = createApp(
    (typeof (service as { enqueueAgentMessage?: unknown }).enqueueAgentMessage === "function"
      ? service
      : {
          activity: () => [],
          recentPreviews: () => [],
          ...(service as Record<string, unknown>)
        }) as never,
    { exists: async () => true } as never
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server failed to bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

function postFeishuMessage(baseUrl: string, messageId: string, text: string) {
  return fetch(`${baseUrl}/connectors/feishu/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema: "2.0",
      token: "vt_test",
      header: { event_id: `evt_${messageId}`, event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_test" } },
        message: {
          message_id: messageId,
          chat_id: "oc_test",
          message_type: "text",
          content: JSON.stringify({ text })
        }
      }
    })
  });
}

function postFeishuCard(baseUrl: string, previewId: string, decision: string, withChatId = true) {
  return fetch(`${baseUrl}/connectors/feishu/card`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "vt_test",
      action: { value: { obsidianlink: true, previewId, decision, ...(withChatId ? { chatId: "oc_test" } : {}) } },
      ...(withChatId ? { context: { open_chat_id: "oc_test", open_message_id: "om_card" } } : {}),
      operator: { open_id: "ou_test" }
    })
  });
}

function makePreview(previewId: string): IngestPreview {
  return {
    previewId,
    summary: "LangGraph 是用于构建状态化智能体流程的开源项目。",
    detectedProjects: [
      {
        name: "LangGraph",
        githubRepo: "langchain-ai/langgraph",
        githubUrl: "https://github.com/langchain-ai/langgraph",
        description: "状态化智能体工作流框架",
        confidence: 0.93,
        evidence: ["GitHub URL"]
      }
    ],
    notesToWrite: [
      {
        title: "langchain-ai-langgraph",
        path: "1_项目/0_开源项目/langchain-ai-langgraph.md",
        type: "project",
        operation: "create",
        reason: "识别到明确 GitHub 仓库",
        confidence: 0.93
      }
    ],
    knowledge: [],
    ideas: [
      {
        title: "多入口智能体编排台",
        combinedWith: ["ObsidianLink"],
        productConcept: "把飞书、Telegram、网页入口统一编排为本地知识智能体。",
        softwarePossibility: "LangGraph 节点化处理消息。",
        hardwarePossibility: "可部署在本地小主机。",
        userScenario: "随手转发技术信息，稍后统一入库。",
        minimalExperiment: "先跑通飞书一条消息到预览卡片。",
        nextAction: "补齐按钮回调和幂等测试。"
      }
    ],
    warnings: []
  };
}

function makeStoredPreview(previewId: string): StoredPreview {
  return {
    ...makePreview(previewId),
    request: { text: "seed", source: "feishu", senderId: "ou_test", messageId: `om_card_seed_${uniqueSuffix()}` },
    parsedInput: {
      rawText: "seed",
      urls: [],
      githubRepos: [],
      douyinUrls: [],
      candidateQuery: "seed"
    },
    douyin: [],
    ocr: [],
    githubRepos: [],
    createdAt: new Date().toISOString(),
    status: "pending"
  };
}

function expectFeishuInteractivePayload(callPayload: unknown, expectedTitle: string): Record<string, unknown> {
  expect(callPayload).toBeTruthy();
  const data = (callPayload as { data?: { msg_type?: string; content?: string } }).data;
  expect(data?.msg_type).toBe("interactive");
  const content = JSON.parse(String(data?.content ?? "{}")) as Record<string, unknown>;
  expect(JSON.stringify(content)).toContain(expectedTitle);
  return content;
}

function mockCall(mock: typeof replyMock, index: number): unknown {
  return (mock.mock.calls as unknown[][])[index]?.[0];
}

function mockLastCall(mock: typeof replyMock): unknown {
  return (mock.mock.calls as unknown[][]).at(-1)?.[0];
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitFor(assertion: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (assertion()) return;
    await tick();
  }
  throw new Error("Timed out waiting for Feishu async side effect");
}

function uniqueSuffix(): string {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
