import { describe, expect, it } from "vitest";
import { runFeishuKnowledgeAgentV2 } from "../src/agent/runtime-v2/feishuKnowledgeAgent.js";
import { classifyAgentIntentV2 } from "../src/agent/runtime-v2/intentRouterV2.js";
import { repositories } from "../src/database/repositories.js";

describe("feishu agent runtime v2", () => {
  it("keeps greetings out of ingestion", () => {
    const intent = classifyAgentIntentV2("你好");
    expect(intent).toMatchObject({
      intent: "casual_chat",
      shouldCreatePreview: false,
      shouldWriteVault: false
    });
  });

  it("recognizes GitHub project-name lookup as a dedicated intent", () => {
    expect(classifyAgentIntentV2("去 GitHub 找 MinerU 这个项目")).toMatchObject({
      intent: "github_project_lookup",
      sourceHint: "github",
      shouldCreatePreview: true
    });
  });

  it("separates idea chat from explicit idea saving", () => {
    expect(classifyAgentIntentV2("我有个想法，想做 PDF RAG 自动复测工具")).toMatchObject({
      intent: "idea_chat",
      shouldCreatePreview: false
    });
    expect(classifyAgentIntentV2("保存刚才这个", { hasOpenIdeaSession: true })).toMatchObject({
      intent: "save_current_idea",
      shouldWriteVault: true
    });
  });

  it("runs a minimal LangGraph smoke path for casual chat", async () => {
    const result = await runFeishuKnowledgeAgentV2({
      repo: repositories,
      request: {
        text: "你好",
        source: "feishu",
        senderId: "user-runtime-v2",
        chatId: "chat-runtime-v2",
        messageId: `msg-${Date.now()}`
      }
    });
    expect(result.intent.intent).toBe("casual_chat");
    expect(result.shouldQueuePreview).toBe(false);
    expect(result.reply).toContain("抖音链接");
  });
});
