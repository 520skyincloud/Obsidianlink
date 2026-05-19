import { describe, expect, it } from "vitest";
import { buildNotes } from "../src/obsidian/markdown.js";
import { StoredPreview } from "../src/types.js";

describe("buildNotes", () => {
  it("builds only one detailed project note when a GitHub repo is identified", () => {
    const preview: StoredPreview = {
      previewId: "pv_test",
      summary: "一个 LangGraph 智能体编排项目。",
      detectedProjects: [
        {
          name: "langgraph",
          githubRepo: "langchain-ai/langgraph",
          githubUrl: "https://github.com/langchain-ai/langgraph",
          description: "Stateful agent orchestration",
          confidence: 0.9,
          evidence: ["github url"]
        }
      ],
      notesToWrite: [],
      knowledge: [
        {
          title: "LangGraph 状态化智能体工作流",
          category: "自动化流程与效率工具",
          contentKind: "method",
          domains: ["自动化", "知识管理"],
          entities: ["Obsidian", "Bot"],
          summary: "把聊天入口变成个人知识库摄入管道。",
          keyPoints: ["消息入口降低记录摩擦"],
          sourceInsights: ["LangGraph 适合作为本地智能体流程编排层"],
          relatedConcepts: ["Obsidian", "Bot"],
          applicationIdeas: ["用确认流程避免误写入"],
          nextActions: ["连接 preview/confirm"]
        }
      ],
      ideas: [
        {
          title: "知识入口智能体编排台",
          ideaKind: "automation",
          combinedWith: ["Obsidian"],
          productConcept: "把聊天想法沉淀成知识卡片。",
          softwarePossibility: "飞书 + 本地 API + LangGraph。",
          hardwarePossibility: "可接入快捷键设备。",
          userScenario: "刷到项目后发给 Bot。",
          minimalExperiment: "先做确认写入。",
          nextAction: "跑通 preview/confirm。"
        }
      ],
      warnings: [],
      request: {
        text: "保存这个项目",
        source: "web",
        senderId: "u1",
        messageId: "m1"
      },
      parsedInput: {
        rawText: "保存这个项目",
        urls: ["https://github.com/langchain-ai/langgraph"],
        githubRepos: ["langchain-ai/langgraph"],
        douyinUrls: [],
        candidateQuery: "保存这个项目"
      },
      douyin: [
        {
          sourceUrl: "https://v.douyin.com/demo/",
          awemeId: "123",
          desc: "demo",
          nickname: "sky"
        }
      ],
      ocr: [],
      githubRepos: [
        {
          fullName: "langchain-ai/langgraph",
          htmlUrl: "https://github.com/langchain-ai/langgraph",
          description: "Stateful agent orchestration",
          stars: 1500,
          topics: ["agents", "workflow"],
          license: "MIT",
          updatedAt: "2026-01-01T00:00:00Z",
          language: "TypeScript",
          readme:
            "# README\n\n![logo](./images/logo.png)\n[![GitHub Code License](https://img.shields.io/github/license/langchain-ai/langgraph)](LICENSE)\n中文 | [English](./README_en.md)\n\n## Quick start\nnpm install\n"
        }
      ],
      createdAt: "2026-05-10T00:00:00.000Z",
      status: "pending"
    };

    const notes = buildNotes(preview);

    expect(notes.map((note) => note.type)).toEqual(["project"]);
    expect(notes[0].title).toBe("langgraph - 状态化智能体工作流");
    expect(notes[0].relativePath).toBe("1_项目/0_开源项目/langgraph-状态化智能体工作流.md");
    expect(notes[0].content).toContain("## 与我的知识库可能怎么联动");
    expect(notes[0].content).toContain("知识入口智能体编排台");
    expect(notes[0].content).toContain("source_authors:");
    expect(notes[0].content).toContain("## GitHub 信息");
    expect(notes[0].content).toContain("Quick start");
    expect(notes[0].content).not.toContain("![logo]");
    expect(notes[0].content).not.toContain("(./images/logo.png)");
    expect(notes[0].content).not.toContain("(LICENSE)");
    expect(notes[0].content).not.toContain("(./README_en.md)");
  });

  it("writes only knowledge by default for non-project Douyin knowledge", () => {
    const preview = baseKnowledgePreview();
    preview.knowledge.push({
      title: "第二张不该默认写出的知识卡",
      category: "知识管理",
      contentKind: "concept",
      domains: ["知识管理"],
      entities: [],
      summary: "用于确认默认只写一个主知识卡。",
      keyPoints: ["不要拆太碎"],
      sourceInsights: [],
      relatedConcepts: [],
      applicationIdeas: [],
      nextActions: []
    });

    const notes = buildNotes(preview);

    expect(notes.map((note) => note.type)).toEqual(["knowledge"]);
    expect(notes[0].relativePath).toContain("2_知识");
    expect(notes[0].title).toBe("低摩擦知识采集方法");
    expect(notes[0].content).toContain("仅作联想摘要，未创建想法文件");
    expect(notes[0].content).not.toContain("[[4_想法");
  });

  it("keeps generated ideas out of Obsidian writes for non-project knowledge", () => {
    const preview = baseKnowledgePreview();
    preview.knowledge.push({
      title: "第二张不该写出的知识卡",
      category: "知识管理",
      contentKind: "concept",
      domains: ["知识管理"],
      entities: [],
      summary: "用于确认联想不会额外写入想法卡。",
      keyPoints: ["不要拆太碎"],
      sourceInsights: [],
      relatedConcepts: [],
      applicationIdeas: [],
      nextActions: []
    });

    const notes = buildNotes(preview);

    expect(notes.map((note) => note.type)).toEqual(["knowledge"]);
    expect(notes.filter((note) => note.type === "knowledge")).toHaveLength(1);
    expect(notes[0].content).toContain("仅作联想摘要，未创建想法文件");
    expect(notes[0].content).not.toContain("[[4_想法");
  });

  it("builds one project candidate note when a video contains a project clue but no confirmed repo", () => {
    const preview = baseKnowledgePreview();
    preview.summary = "视频展示了 Prompt Optimizer 的 GitHub 项目界面，但没有识别到完整仓库 URL。";
    preview.detectedProjects = [
      {
        name: "Prompt Optimizer",
        noteTitle: "提示词优化器项目线索",
        description: "把自然语言需求改写成结构化 Prompt 的项目候选。",
        confidence: 0.68,
        evidence: ["OCR: GitHub project page", "OCR: Prompt Optimizer"]
      }
    ];

    const notes = buildNotes(preview);

    expect(notes).toHaveLength(1);
    expect(notes[0].type).toBe("project");
    expect(notes[0].title).toBe("提示词优化器项目线索");
    expect(notes[0].relativePath).toBe("1_项目/0_开源项目/提示词优化器项目线索.md");
    expect(notes[0].content).toContain("项目候选");
    expect(notes[0].content).toContain("当前还没有确认到稳定 GitHub 仓库");
  });
});

function baseKnowledgePreview(): StoredPreview {
  return {
    previewId: "pv_knowledge",
    summary: "视频讲了一个知识管理方法，没有提到具体 GitHub 项目。",
    detectedProjects: [],
    notesToWrite: [],
    knowledge: [
      {
        title: "低摩擦知识采集方法",
        category: "知识管理",
        contentKind: "method",
        domains: ["知识管理", "自动化"],
        entities: ["Obsidian"],
        summary: "把刷到的内容先收集，再通过确认流程沉淀。",
        keyPoints: ["降低记录摩擦"],
        sourceInsights: ["短视频也可以变成知识来源"],
        relatedConcepts: ["收件箱", "双链"],
        applicationIdeas: ["接入聊天入口"],
        nextActions: ["测试一条抖音知识视频"]
      }
    ],
    ideas: [
      {
        title: "短视频知识采集工作流",
        ideaKind: "automation",
        combinedWith: ["Obsidian"],
        productConcept: "把短视频知识自动转成可确认卡片。",
        softwarePossibility: "解析接口 + OCR + Obsidian。",
        hardwarePossibility: "可接快捷按钮。",
        userScenario: "刷视频时随手转发。",
        minimalExperiment: "跑通一条知识视频。",
        nextAction: "补充分类规则。"
      }
    ],
    warnings: [],
    request: {
      text: "抖音知识视频",
      source: "feishu",
      senderId: "u1",
      messageId: "m1"
    },
    parsedInput: {
      rawText: "抖音知识视频",
      urls: ["https://v.douyin.com/demo/"],
      githubRepos: [],
      douyinUrls: ["https://v.douyin.com/demo/"],
      candidateQuery: "抖音知识视频"
    },
    douyin: [
      {
        sourceUrl: "https://v.douyin.com/demo/",
        awemeId: "douyin-knowledge",
        desc: "知识管理方法",
        nickname: "creator"
      }
    ],
    ocr: [],
    githubRepos: [],
    createdAt: "2026-05-10T00:00:00.000Z",
    status: "pending"
  };
}
