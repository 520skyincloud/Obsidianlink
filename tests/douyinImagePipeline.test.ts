import { describe, expect, it } from "vitest";
import { runPreviewAgentGraph } from "../src/agent/previewGraph.js";
import { GeneratedNote } from "../src/types.js";

describe("douyin image-text pipeline", () => {
  it("uses image OCR instead of video frame extraction for Douyin image posts", async () => {
    let analyzeImagesInput: string[] = [];
    let analyzeVideoCalled = false;
    let ocrTextSeen = "";
    let douyinTextSeen = "";
    const toolCalls: Array<{ toolName: string; status: string }> = [];

    const preview = await runPreviewAgentGraph({
      request: { text: "记录这个抖音图文 https://v.douyin.com/image-demo/", source: "web", senderId: "tester", messageId: "douyin-image-1" },
      tracking: { jobId: "job_douyin_image", runId: "run_douyin_image" },
      douyin: {
        parse: async () => ({
          type: "image",
          sourceUrl: "https://v.douyin.com/image-demo/",
          nickname: "图文作者",
          desc: "图文教程：三张图讲清楚提示词优化",
          awemeId: "aweme-image-1",
          images: ["https://example.com/one.webp", "https://example.com/two.webp"]
        })
      } as never,
      github: {
        getRepo: async () => {
          throw new Error("repo should not be requested for this image-only post");
        },
        searchRepo: async () => undefined
      } as never,
      ocr: {
        analyzeImages: async (images: string[]) => {
          analyzeImagesInput = images;
          return {
            text: "图片1：把模糊需求改写成角色、目标、约束、输出格式\\n图片2：保存常用提示词模板并做版本对比",
            framesAnalyzed: images.length,
            available: true,
            sourceImages: images,
            imageTexts: ["图片1：把模糊需求改写成结构化 Prompt", "图片2：提示词模板版本管理"],
            tempCleaned: true
          };
        },
        analyzeVideo: async () => {
          analyzeVideoCalled = true;
          throw new Error("video OCR should not run for image posts");
        }
      } as never,
      webpage: {
        extract: async () => {
          throw new Error("douyin url should not be extracted as a webpage");
        }
      } as never,
      ai: {
        analyze: async (input: { douyinText: string; ocrText: string }) => {
          douyinTextSeen = input.douyinText;
          ocrTextSeen = input.ocrText;
          return {
            summary: "这条抖音图文讲提示词优化方法。",
            detectedProjects: [],
            tags: ["douyin", "prompt"],
            knowledge: [
              {
                title: "提示词优化图文方法",
                category: "提示词工程",
                contentKind: "method",
                domains: ["AI智能体", "效率工作流"],
                entities: ["Prompt"],
                summary: "把口语化需求改成结构化提示词，并沉淀模板。",
                keyPoints: ["角色、目标、约束、输出格式", "模板版本管理"],
                sourceInsights: ["图文 OCR 来自图片内容"],
                relatedConcepts: ["提示词模板"],
                applicationIdeas: ["做 Obsidian 提示词模板库"],
                nextActions: ["整理一套常用模板"]
              }
            ],
            ideas: [
              {
                title: "提示词模板炼金台",
                ideaKind: "automation",
                combinedWith: ["Obsidian", "Prompt"],
                productConcept: "把图文里的提示词方法变成模板管理工具。",
                softwarePossibility: "OCR + 模型整理 + Obsidian 模板。",
                hardwarePossibility: "无需硬件。",
                userScenario: "刷到提示词图文后发给机器人。",
                minimalExperiment: "先保存一条图文知识卡。",
                nextAction: "测试确认写入。"
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
        addToolCall: (input: { toolName: string; status: string }) => toolCalls.push(input)
      } as never
    });

    expect(analyzeVideoCalled).toBe(false);
    expect(analyzeImagesInput).toEqual(["https://example.com/one.webp", "https://example.com/two.webp"]);
    expect(douyinTextSeen).toContain("images=https://example.com/one.webp");
    expect(ocrTextSeen).toContain("图片1");
    expect(preview.douyin[0].images).toHaveLength(2);
    expect(preview.ocr[0].sourceImages).toHaveLength(2);
    expect(preview.knowledge[0].title).toBe("提示词优化图文方法");
    expect(toolCalls.some((call) => call.toolName === "image_downloader+ocr_reader" && call.status === "success")).toBe(true);
  });
});
