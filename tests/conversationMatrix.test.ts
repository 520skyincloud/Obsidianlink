import { describe, expect, it } from "vitest";
import { IngestService } from "../src/ingestService.js";
import { PreviewStore } from "../src/previewStore.js";
import { repositories } from "../src/database/repositories.js";
import { GeneratedNote, GitHubRepo, StoredPreview } from "../src/types.js";

describe("10x5 real conversation matrix", () => {
  it("1. casual chat stays chat for five turns and never writes", async () => {
    const ctx = makeContext("casual");
    const turns = await sendTurns(ctx, ["你好", "测试", "你是谁", "在吗", "帮助"]);

    expect(turns.map((turn) => turn.action)).toEqual(["chat_reply", "chat_reply", "chat_reply", "chat_reply", "chat_reply"]);
    expect(ctx.written).toHaveLength(0);
    expect(ctx.githubSearches).toHaveLength(0);
  });

  it("2. knowledge questions search the index for five turns and never ingest", async () => {
    const ctx = makeContext("qa");
    repositories.registerVaultFile({
      noteId: `qa-matrix-${ctx.suffix}`,
      title: `飞书长连接部署 ${ctx.suffix}`,
      path: `2_知识/2_方法/飞书长连接部署-${ctx.suffix}.md`,
      type: "knowledge",
      entities: ["飞书", "长连接"],
      domains: ["自动化"]
    });
    const turns = await sendTurns(ctx, [
      `知识库里有没有飞书长连接部署 ${ctx.suffix}？`,
      `我之前存过飞书长连接部署 ${ctx.suffix} 吗？`,
      `查一下飞书长连接部署 ${ctx.suffix}`,
      `有没有和长连接 ${ctx.suffix} 相关的笔记？`,
      `总结一下飞书长连接部署 ${ctx.suffix} 的资料？`
    ]);

    expect(turns.every((turn) => turn.action === "chat_reply")).toBe(true);
    expect(turns.map((turn) => turn.reply).join("\n")).toContain(`飞书长连接部署 ${ctx.suffix}`);
    expect(ctx.written).toHaveLength(0);
  });

  it("3. idea discussion cancels one thread and saves a later explicit thread", async () => {
    const ctx = makeContext("idea-cancel-save");
    const turns = await sendTurns(ctx, [
      "我有个开发想法，想做一个需求整理机器人",
      "第一版先做飞书消息聚合，先别保存",
      "取消",
      "我有个新想法，做一个 PDF RAG 自动复测工具",
      "保存刚才这个"
    ]);

    expect(turns.map((turn) => turn.action)).toEqual(["chat_reply", "chat_reply", "chat_reply", "chat_reply", "idea_saved"]);
    expect(turns[2]?.reply).toContain("没有写入");
    expect(ctx.written).toHaveLength(1);
    expect(ctx.written[0]?.content).toContain("PDF RAG 自动复测工具");
  });

  it("4. GitHub project lookup previews, ideates, commits once, reports status", async () => {
    const ctx = makeContext("github-flow");
    const first = await sendAndMaybeComplete(ctx, "去 GitHub 找 MinerU 这个项目");
    const turns = [
      first.completed ?? first.initial,
      await ctx.send("生成应用想法"),
      await ctx.send("入库"),
      await ctx.send("状态"),
      await ctx.send("入库知识")
    ];

    expect(ctx.githubSearches).toEqual(["MinerU"]);
    expect(turns.map((turn) => turn.action)).toEqual(["preview_generated", "chat_reply", "confirmed", "chat_reply", "chat_reply"]);
    expect(turns[4]?.reply).toContain("当前没有待确认");
    expect(ctx.written).toHaveLength(1);
    expect(ctx.written[0]?.type).toBe("project");
  });

  it("5. Douyin knowledge link creates preview, can ideate, cancel, and then chat normally", async () => {
    const ctx = makeContext("douyin-cancel");
    const first = await sendAndMaybeComplete(ctx, `这个抖音讲知识管理 https://v.douyin.com/${ctx.suffix}/`);
    const turns = [
      first.completed ?? first.initial,
      await ctx.send("生成应用想法"),
      await ctx.send("取消"),
      await ctx.send("你好"),
      await ctx.send("状态")
    ];

    expect(turns.map((turn) => turn.action)).toEqual(["preview_generated", "chat_reply", "cancelled", "chat_reply", "chat_reply"]);
    expect(ctx.douyinCalls).toBe(1);
    expect(ctx.written).toHaveLength(0);
  });

  it("6. web article source can be previewed, ideated, committed, then queried", async () => {
    const ctx = makeContext("web-commit");
    const first = await sendAndMaybeComplete(ctx, `记录这篇文章 https://example.com/${ctx.suffix}/agent-notes`);
    const turns = [
      first.completed ?? first.initial,
      await ctx.send("只联想"),
      await ctx.send("入库知识"),
      await ctx.send("状态"),
      await ctx.send(`知识库里有没有网页知识 ${ctx.suffix}？`)
    ];

    expect(turns.map((turn) => turn.action)).toEqual(["preview_generated", "chat_reply", "confirmed", "chat_reply", "chat_reply"]);
    expect(ctx.webpageCalls).toBe(1);
    expect(ctx.written).toHaveLength(1);
    expect(ctx.written[0]?.type).toBe("knowledge");
  });

  it("7. plain knowledge capture needs explicit preview confirmation before writing", async () => {
    const ctx = makeContext("plain-knowledge");
    const first = await sendAndMaybeComplete(ctx, "记录一个知识：真实聊天和知识入库必须分开判断，闲聊不应该写库。");
    const turns = [
      first.completed ?? first.initial,
      await ctx.send("生成应用想法"),
      await ctx.send("入库知识"),
      await ctx.send("入库知识"),
      await ctx.send("你好")
    ];

    expect(turns.map((turn) => turn.action)).toEqual(["preview_generated", "chat_reply", "confirmed", "chat_reply", "chat_reply"]);
    expect(turns[3]?.reply).toContain("当前没有待确认");
    expect(ctx.written).toHaveLength(1);
  });

  it("8. seeded preview card commands obey no-write ideation and single-write confirm", async () => {
    const ctx = makeContext("seeded-card");
    ctx.store.set(makeStoredPreview(`pv-seeded-${ctx.suffix}`, ctx.senderId));
    const turns = await sendTurns(ctx, ["只联想", "生成应用想法", "入库并联想", "入库知识", "测试"]);

    expect(turns.map((turn) => turn.action)).toEqual(["chat_reply", "chat_reply", "confirmed", "chat_reply", "chat_reply"]);
    expect(ctx.written).toHaveLength(1);
    expect(turns[3]?.reply).toContain("当前没有待确认");
  });

  it("9. duplicate source message id does not process the same source twice", async () => {
    const ctx = makeContext("duplicate-source");
    const first = await sendAndMaybeComplete(ctx, "去 GitHub 找 LangGraph 这个项目", "same-message-id");
    const duplicate = await ctx.send("去 GitHub 找 LangGraph 这个项目", "same-message-id");
    const turns = [
      first.completed ?? first.initial,
      duplicate,
      await ctx.send("生成应用想法"),
      await ctx.send("入库"),
      await ctx.send("状态")
    ];

    expect(turns[0]?.action).toBe("preview_generated");
    expect(turns[1]?.action).toBe("preview_generated");
    expect(ctx.githubSearches).toEqual(["LangGraph"]);
    expect(ctx.written).toHaveLength(1);
  });

  it("10. Douyin parser failure still returns a readable preview and can be cancelled", async () => {
    const ctx = makeContext("douyin-failure", { douyinFails: true });
    const first = await sendAndMaybeComplete(ctx, `这个抖音解析会失败 https://v.douyin.com/fail-${ctx.suffix}/`);
    const turns = [
      first.completed ?? first.initial,
      await ctx.send("生成应用想法"),
      await ctx.send("取消"),
      await ctx.send("入库知识"),
      await ctx.send("你好")
    ];

    expect(turns[0]?.action).toBe("preview_generated");
    expect(turns[0]?.warnings.join("\n")).toContain("Douyin parse failed");
    expect(turns.map((turn) => turn.action)).toEqual(["preview_generated", "chat_reply", "cancelled", "chat_reply", "chat_reply"]);
    expect(ctx.written).toHaveLength(0);
  });
});

interface MatrixContext {
  suffix: string;
  senderId: string;
  chatId: string;
  store: PreviewStore;
  service: IngestService;
  written: GeneratedNote[];
  githubSearches: string[];
  douyinCalls: number;
  webpageCalls: number;
  send: (text: string, messageId?: string) => Promise<ConversationTurnResult>;
}

interface ConversationTurnResult {
  action: string;
  reply: string;
  writtenFiles: string[];
  warnings: string[];
  previewId?: string;
  preview?: unknown;
}

function makeContext(label: string, options: { douyinFails?: boolean } = {}): MatrixContext {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const written: GeneratedNote[] = [];
  const githubSearches: string[] = [];
  const store = new PreviewStore();
  let douyinCalls = 0;
  let webpageCalls = 0;
  const ctx = {} as MatrixContext;
  const service = new IngestService(
    store,
    makeVault(written) as never,
    {
      parse: async (url: string) => {
        douyinCalls += 1;
        if (options.douyinFails) throw new Error("mock parser unavailable");
        return {
          sourceUrl: url,
          desc: `抖音知识 ${suffix}：低摩擦知识采集方法`,
          nickname: "测试作者",
          awemeId: `aweme-${suffix}`,
          videoUrlHQ: "https://example.com/video.mp4"
        };
      }
    } as never,
    {
      getRepo: async (fullName: string) => makeRepo(fullName, `${fullName} project`),
      searchRepo: async (query: string) => {
        githubSearches.push(query);
        return makeRepo(repoForQuery(query), `${query} project`);
      }
    } as never,
    {
      analyzeVideo: async () => ({ text: `OCR ${suffix} Prompt Optimizer 工具用法`, framesAnalyzed: 3, available: true, tempCleaned: true }),
      analyzeImages: async () => ({ text: `图片 OCR ${suffix} 知识点`, framesAnalyzed: 2, available: true, tempCleaned: true })
    } as never,
    makeAi(suffix) as never,
    repositories,
    {
      extract: async (url: string) => {
        webpageCalls += 1;
        return {
          url,
          canonicalUrl: url,
          title: `网页知识 ${suffix}`,
          description: "真实对话功能设计",
          contentType: "text/html",
          status: 200,
          excerpt: "网页讲如何区分聊天和知识入库。",
          text: `网页知识 ${suffix}：真实聊天、知识入库、预览确认。`
        };
      }
    } as never
  );
  ctx.suffix = suffix;
  ctx.senderId = `sender-${suffix}`;
  ctx.chatId = `chat-${suffix}`;
  ctx.store = store;
  ctx.service = service;
  ctx.written = written;
  ctx.githubSearches = githubSearches;
  ctx.send = (text: string, messageId?: string) => sendOne(ctx, text, messageId);
  Object.defineProperty(ctx, "douyinCalls", { get: () => douyinCalls });
  Object.defineProperty(ctx, "webpageCalls", { get: () => webpageCalls });
  return ctx;
}

async function sendTurns(ctx: MatrixContext, texts: string[]): Promise<ConversationTurnResult[]> {
  const results: ConversationTurnResult[] = [];
  for (const text of texts) results.push(await ctx.send(text));
  expect(results).toHaveLength(5);
  return results;
}

async function sendAndMaybeComplete(ctx: MatrixContext, text: string, messageId?: string): Promise<{ initial: ConversationTurnResult; completed?: ConversationTurnResult }> {
  let completed: ConversationTurnResult | undefined;
  const initial = await ctx.service.enqueueAgentMessage(requestFor(ctx, text, messageId), (response) => {
    completed = normalizeResponse(response);
  });
  const normalizedInitial = normalizeResponse(initial);
  if (normalizedInitial.action === "queued") {
    await waitFor(() => Boolean(completed));
  }
  return { initial: normalizedInitial, completed };
}

async function sendOne(ctx: MatrixContext, text: string, messageId?: string): Promise<ConversationTurnResult> {
  const result = await ctx.service.enqueueAgentMessage(requestFor(ctx, text, messageId));
  return normalizeResponse(result);
}

function requestFor(ctx: MatrixContext, text: string, messageId?: string) {
  return {
    text,
    source: "feishu" as const,
    senderId: ctx.senderId,
    chatId: ctx.chatId,
    messageId: messageId ?? `msg-${ctx.suffix}-${Math.random().toString(16).slice(2)}`,
    autoWrite: false
  };
}

function normalizeResponse(response: {
  action: string;
  reply: string;
  writtenFiles?: string[];
  warnings?: string[];
  previewId?: string;
  preview?: unknown;
}): ConversationTurnResult {
  return {
    action: response.action,
    reply: response.reply,
    writtenFiles: response.writtenFiles ?? [],
    warnings: response.warnings ?? [],
    previewId: response.previewId,
    preview: response.preview
  };
}

function makeVault(written: GeneratedNote[]) {
  return {
    readExistingProjectIndex: async () => "",
    planNotes: async (notes: GeneratedNote[]) => notes.map((note) => ({
      title: note.title,
      path: note.relativePath,
      type: note.type,
      operation: note.operation ?? "create",
      reason: note.reason,
      confidence: note.confidence
    })),
    writeNotes: async (notes: GeneratedNote[]) => {
      written.push(...notes);
      return notes.map((note) => `/tmp/obsidianlink-matrix/${note.relativePath}`);
    }
  };
}

function makeAi(suffix: string) {
  return {
    analyze: async (input: { rawText: string; repos: GitHubRepo[]; douyinText?: string; webpageText?: string }) => makeAnalysis(suffix, input),
    developIdeaConversation: async (input: { shouldSaveHint: boolean; messages: Array<{ role: string; content: string }> }) => ({
      readyToSave: input.shouldSaveHint,
      reply: input.shouldSaveHint ? "已经整理成灵感卡。" : "我先不入库，继续帮你把目标用户、第一版动作和验证方式聊清楚。",
      title: input.messages.map((item) => item.content).join(" ").includes("PDF RAG") ? "PDF RAG 自动复测工具" : "需求整理机器人",
      summary: input.messages.map((item) => item.content).join(" / "),
      clarifiedPoints: input.messages.map((item) => item.content),
      openQuestions: ["谁是目标用户？", "第一版只做哪个动作？"],
      domains: ["AI智能体", "自动化"],
      ideaKind: "automation",
      minimalExperiment: "先做一个可点击 Demo 验证核心流程。",
      nextAction: "写清楚输入、处理和输出。"
    })
  };
}

function makeAnalysis(suffix: string, input: { rawText: string; repos: GitHubRepo[]; douyinText?: string; webpageText?: string }) {
  const source = [input.rawText, input.douyinText ?? "", input.webpageText ?? ""].join("\n");
  const repos = input.repos ?? [];
  const sourceTitle = source.includes("网页知识") ? `网页知识 ${suffix}` : source.includes("抖音知识") ? `抖音知识 ${suffix}` : `真实聊天入库判断 ${suffix}`;
  return {
    summary: repos.length ? `${repos[0].fullName} 是一个值得研究的 GitHub 项目。` : `${sourceTitle} 的摘要。`,
    detectedProjects: repos.map((repo) => ({
      name: repo.fullName.split("/")[1],
      noteTitle: `${repo.fullName.split("/")[1]} - 智能体工具`,
      githubRepo: repo.fullName,
      githubUrl: repo.htmlUrl,
      description: repo.description ?? "GitHub project",
      confidence: 0.9,
      evidence: ["GitHub Search"]
    })),
    tags: ["conversation"],
    knowledge: [
      {
        title: repos.length ? `${repos[0].fullName.split("/")[1]} 项目研究` : sourceTitle,
        category: "AI 与自动化",
        contentKind: "method" as const,
        domains: ["知识管理", "自动化"],
        entities: repos.map((repo) => repo.fullName),
        summary: "判断内容应该聊天、预览还是入库。",
        keyPoints: ["真实聊天不直接写库", "明确入库才写入"],
        sourceInsights: ["预览确认能降低误写入"],
        relatedConcepts: ["飞书", "Obsidian"],
        applicationIdeas: ["多轮澄清后保存"],
        nextActions: ["继续测试边界对话"]
      }
    ],
    ideas: [
      {
        title: "真实对话判别器",
        ideaKind: "automation" as const,
        combinedWith: repos.map((repo) => repo.fullName),
        productConcept: "先判断聊天意图，再决定是否生成预览或写库。",
        softwarePossibility: "LangGraph runtime + intent logs + preview policy。",
        hardwarePossibility: "可接快捷入口。",
        userScenario: "用户随手发消息，不用担心误入库。",
        minimalExperiment: "用 10x5 对话矩阵压测。",
        nextAction: "把失败样例加入回归测试。"
      }
    ]
  };
}

function makeRepo(fullName: string, description = "GitHub project"): GitHubRepo {
  return {
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    description,
    stars: 1234,
    topics: ["agent", "automation"],
    license: "MIT",
    updatedAt: "2026-05-01T00:00:00Z",
    language: "TypeScript",
    readme: "# Quick start\nnpm install\n"
  };
}

function repoForQuery(query: string): string {
  if (/mineru/i.test(query)) return "opendatalab/MinerU";
  if (/langgraph/i.test(query)) return "langchain-ai/langgraph";
  return `example/${query.replace(/\s+/g, "-")}`;
}

function makeStoredPreview(previewId: string, senderId: string): StoredPreview {
  return {
    previewId,
    summary: "待确认的知识预览。",
    detectedProjects: [],
    notesToWrite: [{ title: "真实对话判别方法", path: "2_知识/2_方法/真实对话判别方法.md", type: "knowledge" }],
    knowledge: makeAnalysis("seeded", { rawText: "预览种子", repos: [] }).knowledge,
    ideas: makeAnalysis("seeded", { rawText: "预览种子", repos: [] }).ideas,
    warnings: [],
    request: { text: "预览种子", source: "feishu", senderId, messageId: `${previewId}-msg` },
    parsedInput: { rawText: "预览种子", urls: [], githubRepos: [], douyinUrls: [], candidateQuery: "预览种子" },
    douyin: [],
    ocr: [],
    githubRepos: [],
    createdAt: new Date().toISOString(),
    status: "pending"
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for conversation matrix async completion");
}
