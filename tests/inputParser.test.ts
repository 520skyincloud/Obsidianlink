import { describe, expect, it } from "vitest";
import { parseInput } from "../src/inputParser.js";

describe("parseInput", () => {
  it("extracts GitHub repos and Douyin URLs", () => {
    const parsed = parseInput(
      "看看这个 https://v.douyin.com/ZedjlY4D5YQ/ 里面提到 https://github.com/langchain-ai/langgraph 很适合接入"
    );

    expect(parsed.douyinUrls).toEqual(["https://v.douyin.com/ZedjlY4D5YQ/"]);
    expect(parsed.githubRepos).toContain("langchain-ai/langgraph");
    expect(parsed.candidateQuery).toContain("看看这个");
  });

  it("extracts owner/repo shorthand", () => {
    const parsed = parseInput("研究一下 langchain-ai/langgraph 能不能和我的知识库结合");

    expect(parsed.githubRepos).toContain("langchain-ai/langgraph");
  });

  it("does not treat github.com/owner as a shorthand repo", () => {
    const parsed = parseInput("研究 https://github.com/langchain-ai/langgraph");

    expect(parsed.githubRepos).toEqual(["langchain-ai/langgraph"]);
  });

  it("does not treat local file paths as GitHub repo shorthands", () => {
    const parsed = parseInput("本地视频 /tmp/obsidianlink-ocr-test.mp4 里有字幕");

    expect(parsed.githubRepos).toEqual([]);
  });

  it("does not treat GitHub documentation paths as repo shorthands", () => {
    const parsed = parseInput("OCR 里出现 github/workflows 和 REST API endpoints for repositories");

    expect(parsed.githubRepos).toEqual([]);
  });

  it("cleans natural language GitHub project-name searches into a useful query", () => {
    expect(parseInput("去 GitHub 帮我找到 LangGraph 这个项目").candidateQuery).toBe("LangGraph");
    expect(parseInput("帮我搜一下 github 上的 CopilotKit 仓库").candidateQuery).toBe("CopilotKit");
    expect(parseInput("项目名叫 Agent Reach，去 github 研究一下").candidateQuery).toBe("Agent Reach");
    expect(parseInput("去 GitHub 找 MinerU 这个项目").candidateQuery).toBe("MinerU");
  });
});
