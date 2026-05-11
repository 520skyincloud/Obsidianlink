import { describe, expect, it } from "vitest";
import { isIdeaConversationCandidate } from "../src/ideaConversation.js";

describe("idea conversation routing", () => {
  it("routes development ideas into conversational mode", () => {
    expect(isIdeaConversationCandidate("我有个开发点子，想做一个自动整理需求的飞书机器人")).toBe(true);
    expect(isIdeaConversationCandidate("能不能做个插件，把我平时的功能想法先聊清楚再入库")).toBe(true);
  });

  it("keeps hard sources on the ingestion pipeline", () => {
    expect(isIdeaConversationCandidate("https://github.com/langchain-ai/langgraph")).toBe(false);
    expect(isIdeaConversationCandidate("复制打开抖音 https://v.douyin.com/abc/")).toBe(false);
  });

  it("keeps an open idea session conversational until a hard source appears", () => {
    expect(isIdeaConversationCandidate("第一版先做飞书入口", true)).toBe(true);
    expect(isIdeaConversationCandidate("确认", true)).toBe(true);
    expect(isIdeaConversationCandidate("https://github.com/example/repo", true)).toBe(false);
  });
});
