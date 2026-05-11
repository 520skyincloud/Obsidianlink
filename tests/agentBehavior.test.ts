import { describe, expect, it } from "vitest";
import { runAgentGraph } from "../src/agentGraph.js";
import { isImmediateChatIntent, shouldSearchGitHub } from "../src/ingestService.js";
import { parseInput } from "../src/inputParser.js";

describe("agent behavior assumptions", () => {
  it("plain knowledge text does not contain github intent by default", () => {
    const parsed = parseInput("这个视频讲如何把刷到的技术灵感扔给QQ机器人，再自动分类到Obsidian。");

    expect(parsed.githubRepos).toEqual([]);
    expect(parsed.douyinUrls).toEqual([]);
  });

  it("does not trigger broad GitHub search from generic agent workflow wording", () => {
    const parsed = parseInput(
      "今天刷到一个视频讲如何把短视频里的知识点自动整理成Obsidian笔记，最好还能联想到我的QQ机器人入口、GitHub项目研究和本地知识库分类。"
    );

    expect(shouldSearchGitHub(parsed.rawText, parsed.candidateQuery)).toBe(false);
  });

  it("does trigger GitHub search when a concrete project name is mentioned", () => {
    const parsed = parseInput("帮我研究一下 LangGraph 这个 GitHub 项目");

    expect(shouldSearchGitHub(parsed.rawText, parsed.candidateQuery)).toBe(true);
    expect(parsed.candidateQuery).toBe("LangGraph");
  });

  it("searches GitHub from a project name without requiring a URL", () => {
    const parsed = parseInput("去 GitHub 帮我找到 Agent Reach 这个项目");

    expect(parsed.githubRepos).toEqual([]);
    expect(parsed.candidateQuery).toBe("Agent Reach");
    expect(shouldSearchGitHub(parsed.rawText, parsed.candidateQuery)).toBe(true);
  });

  it("does not treat ordinary URL paths as owner/repo shorthands", () => {
    const parsed = parseInput("记录这篇文章 http://127.0.0.1:38721/article");

    expect(parsed.githubRepos).toEqual([]);
  });

  it("does not treat dates as owner/repo shorthands", () => {
    const parsed = parseInput("11/05 刷到一个抖音开源项目");

    expect(parsed.githubRepos).toEqual([]);
  });

  it("routes greetings as immediate chat instead of background ingestion", () => {
    expect(isImmediateChatIntent("你好")).toBe(true);
    expect(isImmediateChatIntent("help")).toBe(true);
  });

  it("confirms the latest pending preview from chat", async () => {
    const response = await runAgentGraph(
      {
        preview: async () => {
          throw new Error("preview should not run for confirm");
        },
        confirm: async (request) => ({
          previewId: request.previewId,
          status: "confirmed",
          writtenFiles: ["/tmp/example.md"]
        }),
        findPendingPreview: () => ({ previewId: "pv_pending", summary: "pending preview" })
      },
      { text: "确认", source: "qq", senderId: "u1", messageId: "m1", autoWrite: false }
    );

    expect(response.action).toBe("confirmed");
    expect(response.previewId).toBe("pv_pending");
    expect(response.writtenFiles).toHaveLength(1);
  });

  it("reports missing pending preview for chat decisions", async () => {
    const response = await runAgentGraph(
      {
        preview: async () => {
          throw new Error("preview should not run for cancel");
        },
        confirm: async () => {
          throw new Error("confirm should not run without pending preview");
        },
        findPendingPreview: () => undefined
      },
      { text: "取消", source: "feishu", senderId: "u2", messageId: "m2", autoWrite: false }
    );

    expect(response.ok).toBe(false);
    expect(response.reply).toContain("没有找到待确认的预览");
  });
});
