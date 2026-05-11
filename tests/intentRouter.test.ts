import { describe, expect, it } from "vitest";
import { classifyMessageIntent } from "../src/intentRouter.js";

describe("message intent router", () => {
  it("keeps greetings and low information messages out of ingestion", () => {
    expect(classifyMessageIntent("你好").kind).toBe("casual_chat");
    expect(classifyMessageIntent("测试").kind).toBe("casual_chat");
    expect(classifyMessageIntent("可是无聊11").kind).toBe("casual_chat");
  });

  it("routes hard sources to ingestion", () => {
    expect(classifyMessageIntent("复制打开抖音 https://v.douyin.com/abc/").kind).toBe("source_ingest");
    expect(classifyMessageIntent("https://github.com/langchain-ai/langgraph").kind).toBe("source_ingest");
    expect(classifyMessageIntent("https://example.com/article").kind).toBe("source_ingest");
  });

  it("routes GitHub project-name lookup requests into ingestion", () => {
    expect(classifyMessageIntent("去 GitHub 帮我找到 LangGraph 这个项目")).toMatchObject({
      kind: "source_ingest",
      sourceHint: "github"
    });
    expect(classifyMessageIntent("项目名叫 Agent Reach，去 github 研究一下")).toMatchObject({
      kind: "source_ingest",
      sourceHint: "github"
    });
    expect(classifyMessageIntent("你知道 LangGraph 吗，去 GitHub 查一下这个项目")).toMatchObject({
      kind: "source_ingest",
      sourceHint: "github"
    });
    expect(classifyMessageIntent("已经在聊想法了，但现在帮我去 GitHub 找一下 openclaw-qqbot", { hasOpenIdeaSession: true })).toMatchObject({
      kind: "source_ingest",
      sourceHint: "github"
    });
  });

  it("routes development ideas to conversational clarification", () => {
    expect(classifyMessageIntent("我有个开发点子，想做一个自动整理需求的飞书机器人").kind).toBe("idea_chat");
    expect(classifyMessageIntent("我想做一个 GitHub 项目搜索工具").kind).toBe("idea_chat");
    expect(classifyMessageIntent("第一版先做飞书入口", { hasOpenIdeaSession: true }).kind).toBe("idea_chat");
    expect(classifyMessageIntent("确认", { hasOpenIdeaSession: true }).kind).toBe("idea_chat");
  });

  it("keeps explicit preview commands as commands when no idea session is open", () => {
    expect(classifyMessageIntent("确认").kind).toBe("confirm_preview");
    expect(classifyMessageIntent("取消").kind).toBe("cancel_preview");
    expect(classifyMessageIntent("状态").kind).toBe("status");
  });

  it("routes long knowledge-like text to plain knowledge ingestion", () => {
    expect(classifyMessageIntent("今天刷到一个技术分享，说用本地知识库配合机器人入口可以把碎片信息沉淀成长期资产。").kind).toBe("knowledge_ingest");
  });
});
