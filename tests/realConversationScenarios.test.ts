import { describe, expect, it } from "vitest";
import { IngestService } from "../src/ingestService.js";
import { PreviewStore } from "../src/previewStore.js";
import { repositories } from "../src/database/repositories.js";
import { GeneratedNote, GitHubRepo, StoredPreview } from "../src/types.js";

describe("real conversation scenarios", () => {
  it("answers knowledge questions from the local vault index without creating ingestion jobs", async () => {
    const suffix = uniqueSuffix();
    repositories.registerVaultFile({
      noteId: `qa-${suffix}`,
      title: `多渠道真实对话测试 ${suffix}`,
      path: `2_知识/0_概念/多渠道真实对话测试-${suffix}.md`,
      type: "knowledge",
      entities: ["飞书", "真实对话"],
      domains: ["知识管理"]
    });
    const service = makeService();

    const response = await service.enqueueAgentMessage({
      text: `知识库里有没有多渠道真实对话测试 ${suffix}？`,
      source: "feishu",
      senderId: `qa-user-${suffix}`,
      chatId: `qa-chat-${suffix}`,
      messageId: `qa-msg-${suffix}`
    });

    expect(response.action).toBe("chat_reply");
    expect(response.reply).toContain(`多渠道真实对话测试 ${suffix}`);
    expect(response.reply).toContain(`2_知识/0_概念/多渠道真实对话测试-${suffix}.md`);
    expect(response.writtenFiles).toEqual([]);
  });

  it("looks up a GitHub project by natural language name and returns a preview", async () => {
    const suffix = uniqueSuffix();
    const searches: string[] = [];
    const repo = makeRepo("opendatalab/MinerU", "Document parsing tool");
    const github = {
      getRepo: async (fullName: string) => makeRepo(fullName, "Repo by full name"),
      searchRepo: async (query: string) => {
        searches.push(query);
        return repo;
      }
    };
    const service = makeService({ github });
    const completed = new Promise<Awaited<ReturnType<IngestService["enqueueAgentMessage"]>>>((resolve) => {
      void service.enqueueAgentMessage(
        {
          text: "去 GitHub 找 MinerU 这个项目",
          source: "feishu",
          senderId: `github-user-${suffix}`,
          chatId: `github-chat-${suffix}`,
          messageId: `github-msg-${suffix}`
        },
        (response) => resolve(response)
      ).then((queued) => {
        expect(queued.action).toBe("queued");
      });
    });

    const response = await completed;
    expect(searches).toEqual(["MinerU"]);
    expect(response.action).toBe("preview_generated");
    expect(response.preview?.detectedProjects[0]?.githubRepo).toBe("opendatalab/MinerU");
    expect(response.preview?.notesToWrite[0]?.type).toBe("project");
  });

  it("keeps idea discussion conversational and saves the whole thread only on explicit save", async () => {
    const suffix = uniqueSuffix();
    const written: GeneratedNote[] = [];
    const service = makeService({
      vault: makeVault(written),
      ai: {
        analyze: async () => makeAnalysis([]),
        developIdeaConversation: async (input: { shouldSaveHint: boolean; messages: Array<{ role: string; content: string }> }) => ({
          readyToSave: input.shouldSaveHint,
          reply: input.shouldSaveHint ? "已经沉淀。" : "我先帮你继续问清楚目标用户和第一版动作。",
          title: "PDF RAG 自动复测工具",
          summary: "把 PDF RAG 的评测、回归和报告自动化。",
          clarifiedPoints: input.messages.map((item) => item.content),
          openQuestions: ["数据集怎么选？"],
          domains: ["AI智能体", "自动化"],
          ideaKind: "automation",
          minimalExperiment: "先用 10 个 PDF 问答样例跑回归。",
          nextAction: "定义评测指标。"
        })
      }
    });
    const base = {
      source: "feishu" as const,
      senderId: `idea-user-${suffix}`,
      chatId: `idea-chat-${suffix}`
    };

    const first = await service.enqueueAgentMessage({
      ...base,
      text: "我有个开发想法，想做 PDF RAG 自动复测工具",
      messageId: `idea-1-${suffix}`
    });
    expect(first.action).toBe("chat_reply");
    expect(written).toHaveLength(0);

    const second = await service.enqueueAgentMessage({
      ...base,
      text: "第一版先做上传 PDF、生成测试问题、跑多模型对比，先别保存",
      messageId: `idea-2-${suffix}`
    });
    expect(second.action).toBe("chat_reply");
    expect(written).toHaveLength(0);

    const saved = await service.enqueueAgentMessage({
      ...base,
      text: "保存刚才这个",
      messageId: `idea-3-${suffix}`
    });
    expect(saved.action).toBe("idea_saved");
    expect(written).toHaveLength(1);
    expect(written[0]?.content).toContain("PDF RAG 自动复测工具");
    expect(written[0]?.content).toContain("跑多模型对比");
  });

  it("returns application ideas from a pending preview without writing files", async () => {
    const suffix = uniqueSuffix();
    const store = new PreviewStore();
    const preview = makeStoredPreview(`pv-real-${suffix}`, `preview-user-${suffix}`);
    store.set(preview);
    const written: GeneratedNote[] = [];
    const service = makeService({ store, vault: makeVault(written) });

    const response = await service.enqueueAgentMessage({
      text: "生成应用想法",
      source: "feishu",
      senderId: `preview-user-${suffix}`,
      chatId: `preview-chat-${suffix}`,
      messageId: `preview-idea-${suffix}`
    });

    expect(response.action).toBe("chat_reply");
    expect(response.reply).toContain("应用想法");
    expect(response.reply).toContain("短视频知识采集工作流");
    expect(written).toHaveLength(0);
  });
});

function makeService(overrides: Partial<{ store: PreviewStore; vault: unknown; github: unknown; ai: unknown }> = {}) {
  return new IngestService(
    overrides.store ?? new PreviewStore(),
    (overrides.vault ?? makeVault([])) as never,
    { parse: async () => ({ sourceUrl: "", desc: "", images: [] }) } as never,
    (overrides.github ?? { getRepo: async (fullName: string) => makeRepo(fullName), searchRepo: async () => null }) as never,
    { analyzeVideo: async () => ({ text: "", framesAnalyzed: 0, available: true }), analyzeImages: async () => ({ text: "", framesAnalyzed: 0, available: true }) } as never,
    (overrides.ai ?? { analyze: async (input: { repos: GitHubRepo[] }) => makeAnalysis(input.repos), developIdeaConversation: async () => ({ readyToSave: false, reply: "继续聊聊。", title: "想法", summary: "", clarifiedPoints: [], openQuestions: [], domains: [], ideaKind: "product", minimalExperiment: "", nextAction: "" }) }) as never,
    repositories,
    { extract: async () => ({ url: "", status: 200, excerpt: "", text: "" }) } as never
  );
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
      return notes.map((note) => `/tmp/obsidianlink-real/${note.relativePath}`);
    }
  };
}

function makeRepo(fullName: string, description = "GitHub project"): GitHubRepo {
  return {
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    description,
    stars: 1234,
    topics: ["ai", "documents"],
    license: "MIT",
    updatedAt: "2026-05-01T00:00:00Z",
    language: "Python",
    readme: "# Quick start\npip install mineru\n"
  };
}

function makeAnalysis(repos: GitHubRepo[]) {
  return {
    summary: repos.length ? `${repos[0].fullName} 是一个文档解析项目。` : "知识内容摘要。",
    detectedProjects: repos.map((repo) => ({
      name: repo.fullName.split("/")[1],
      noteTitle: `${repo.fullName.split("/")[1]} - 文档解析工具`,
      githubRepo: repo.fullName,
      githubUrl: repo.htmlUrl,
      description: repo.description ?? "GitHub project",
      confidence: 0.9,
      evidence: ["GitHub Search"]
    })),
    tags: ["ai"],
    knowledge: [
      {
        title: repos.length ? `${repos[0].fullName.split("/")[1]} 文档解析能力` : "知识内容摘要",
        category: "AI 与自动化",
        contentKind: "tool" as const,
        domains: ["AI智能体"],
        entities: repos.map((repo) => repo.fullName),
        summary: "把非结构化文档转成可处理文本。",
        keyPoints: ["文档解析", "自动化处理"],
        sourceInsights: ["适合接入知识库流水线"],
        relatedConcepts: ["RAG"],
        applicationIdeas: ["作为知识摄入预处理"],
        nextActions: ["试跑样例"]
      }
    ],
    ideas: [
      {
        title: "短视频知识采集工作流",
        ideaKind: "automation" as const,
        combinedWith: repos.map((repo) => repo.fullName),
        productConcept: "把来源内容自动研究后给出入库确认。",
        softwarePossibility: "飞书 + LangGraph + Obsidian。",
        hardwarePossibility: "可接快捷按钮。",
        userScenario: "刷到内容后直接发给 Bot。",
        minimalExperiment: "先跑一条内容。",
        nextAction: "确认写入策略。"
      }
    ]
  };
}

function makeStoredPreview(previewId: string, senderId: string): StoredPreview {
  return {
    previewId,
    summary: "短视频知识采集工作流预览。",
    detectedProjects: [],
    notesToWrite: [{ title: "低摩擦知识采集方法", path: "2_知识/2_方法/低摩擦知识采集方法.md", type: "knowledge" }],
    knowledge: makeAnalysis([]).knowledge,
    ideas: makeAnalysis([]).ideas,
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

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
