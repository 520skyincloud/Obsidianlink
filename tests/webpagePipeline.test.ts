import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { runPreviewAgentGraph } from "../src/agent/previewGraph.js";
import { WebpageExtractor } from "../src/clients/webpage.js";
import { GeneratedNote } from "../src/types.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

describe("webpage extraction pipeline", () => {
  it("extracts title, canonical url and readable body text", async () => {
    const url = await serveHtml(`
      <!doctype html>
      <html>
        <head>
          <title>LangGraph 二开实践</title>
          <link rel="canonical" href="https://example.com/langgraph-agent" />
          <meta name="description" content="把多渠道消息入口汇入智能体的实践。" />
          <style>.hidden{display:none}</style>
        </head>
        <body>
          <h1>多渠道入口到 LangGraph 智能体</h1>
          <script>window.noise = true</script>
          <article>飞书长连接、Telegram webhook 和通用 API 都应该归一化成同一个 AgentMessageRequest。</article>
        </body>
      </html>
    `);

    const page = await new WebpageExtractor().extract(url);

    expect(page.title).toBe("LangGraph 二开实践");
    expect(page.canonicalUrl).toBe("https://example.com/langgraph-agent");
    expect(page.description).toContain("多渠道消息入口");
    expect(page.text).toContain("飞书长连接");
    expect(page.text).not.toContain("window.noise");
  });

  it("feeds webpage text into the LangGraph knowledge extractor", async () => {
    const url = await serveHtml(`
      <html>
        <head><title>多渠道消息入口架构</title></head>
        <body><article>真实平台接入要支持飞书长连接、Telegram webhook、签名校验、消息归一化和异步回发。</article></body>
      </html>
    `);
    let webpageTextSeen = "";
    const toolCalls: Array<{ nodeName: string; toolName: string; status: string }> = [];

    const preview = await runPreviewAgentGraph({
      request: { text: `记录这篇文章 ${url}`, source: "web", senderId: "tester", messageId: "webpage-1" },
      tracking: { jobId: "job_webpage", runId: "run_webpage" },
      douyin: {} as never,
      github: {
        getRepo: async () => {
          throw new Error("repo should not be requested for this webpage-only input");
        },
        searchRepo: async () => undefined
      } as never,
      ocr: {} as never,
      webpage: new WebpageExtractor(),
      ai: {
        analyze: async (input: { webpageText?: string }) => {
          webpageTextSeen = input.webpageText ?? "";
          return {
            summary: "网页讲多渠道消息入口如何汇入智能体。",
            detectedProjects: [],
            tags: ["webpage"],
            knowledge: [
              {
                title: "多渠道消息入口到智能体",
                category: "智能体架构",
                contentKind: "method",
                domains: ["AI智能体", "自动化", "知识管理"],
                entities: ["飞书长连接", "Telegram webhook"],
                summary: "统一消息入口、异步任务和回发通道。",
                keyPoints: ["平台 SDK 只负责协议", "智能体负责理解和写库"],
                sourceInsights: ["网页正文来自 webpage_extractor"],
                relatedConcepts: ["AgentMessageRequest"],
                applicationIdeas: ["用同一套状态机处理所有入口"],
                nextActions: ["补平台验收脚本"]
              }
            ],
            ideas: [
              {
                title: "多平台知识入口控制台",
                ideaKind: "automation",
                combinedWith: ["飞书", "Telegram"],
                productConcept: "把社交消息变成可确认的知识库任务。",
                softwarePossibility: "Connector Adapter -> Job Queue -> LangGraph -> Vault Commit。",
                hardwarePossibility: "可接快捷键或语音入口。",
                userScenario: "刷到文章后转发给机器人。",
                minimalExperiment: "先跑网页链接摄入。",
                nextAction: "做真实平台验收。"
              }
            ]
          };
        }
      } as never,
      vault: {
        readExistingProjectIndex: async () => "",
        planNotes: async (notes: GeneratedNote[]) =>
          notes.map((note) => ({
            title: note.title,
            path: note.relativePath,
            type: note.type,
            operation: "create" as const,
            reason: "test",
            confidence: 1
          }))
      } as never,
      repo: {
        updateJob: () => undefined,
        addStep: () => undefined,
        addToolCall: (input: { nodeName: string; toolName: string; status: string }) => toolCalls.push(input)
      } as never
    });

    expect(webpageTextSeen).toContain("真实平台接入");
    expect(preview.webpages?.[0]?.title).toBe("多渠道消息入口架构");
    expect(preview.knowledge[0].title).toBe("多渠道消息入口到智能体");
    expect(toolCalls.some((call) => call.nodeName === "webpage_pipeline" && call.toolName === "webpage_extractor" && call.status === "success")).toBe(true);
  });
});

async function serveHtml(html: string): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server failed to bind");
  return `http://127.0.0.1:${address.port}/article`;
}
