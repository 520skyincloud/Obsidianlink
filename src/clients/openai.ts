import { config } from "../config.js";
import { DetectedProject, GitHubRepo, IdeaCard, KnowledgeCard } from "../types.js";
import {
  contentKindNames,
  contentKindPrompt,
  domainPrompt,
  ideaKindNames,
  inferDomains,
  normalizeContentKind,
  normalizeDomains,
  normalizeIdeaKind,
  normalizeSourceType
} from "../knowledgeTaxonomy.js";
import { extractJsonObject, truncate } from "../utils.js";
import { z } from "zod";

const analysisSchema = z.object({
  summary: z.string(),
  detectedProjects: z.array(
    z.object({
      name: z.string(),
      noteTitle: z.string().optional(),
      note_title: z.string().optional(),
      githubRepo: z.string().optional(),
      githubUrl: z.string().optional(),
      description: z.string(),
      confidence: z.number().min(0).max(1),
      evidence: z.array(z.string()).default([])
    })
  ),
  tags: z.array(z.string()).default([]),
  knowledge: z.array(
    z.object({
      title: z.string(),
      category: z.string().default(""),
      content_kind: z.string().optional(),
      contentKind: z.string().optional(),
      domains: z.array(z.string()).default([]),
      source_type: z.string().optional(),
      sourceType: z.string().optional(),
      entities: z.array(z.string()).default([]),
      summary: z.string(),
      keyPoints: z.array(z.string()).default([]),
      sourceInsights: z.array(z.string()).default([]),
      relatedConcepts: z.array(z.string()).default([]),
      applicationIdeas: z.array(z.string()).default([]),
      nextActions: z.array(z.string()).default([])
    })
  ).default([]),
  ideas: z.array(
    z.object({
      title: z.string(),
      idea_kind: z.string().optional(),
      ideaKind: z.string().optional(),
      combinedWith: z.array(z.string()).default([]),
      productConcept: z.string(),
      softwarePossibility: z.string(),
      hardwarePossibility: z.string(),
      userScenario: z.string(),
      minimalExperiment: z.string(),
      nextAction: z.string()
    })
  )
});

const ideaConversationSchema = z.object({
  readyToSave: z.boolean().default(false),
  reply: z.string(),
  title: z.string().default("未命名想法"),
  summary: z.string().default(""),
  clarifiedPoints: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  idea_kind: z.string().optional(),
  ideaKind: z.string().optional(),
  minimalExperiment: z.string().default(""),
  nextAction: z.string().default("")
});

export interface AnalysisResult {
  summary: string;
  detectedProjects: DetectedProject[];
  tags: string[];
  knowledge: KnowledgeCard[];
  ideas: IdeaCard[];
}

export interface IdeaConversationResult {
  readyToSave: boolean;
  reply: string;
  title: string;
  summary: string;
  clarifiedPoints: string[];
  openQuestions: string[];
  domains: string[];
  ideaKind: ReturnType<typeof normalizeIdeaKind>;
  minimalExperiment: string;
  nextAction: string;
}

export class OpenAIClient {
  async analyze(input: {
    rawText: string;
    douyinText: string;
    ocrText: string;
    webpageText?: string;
    repos: GitHubRepo[];
    existingIndex: string;
  }): Promise<AnalysisResult> {
    this.assertConfigured();
    const repoContext = input.repos
      .map(
        (repo) => `Repo: ${repo.fullName}
URL: ${repo.htmlUrl}
Description: ${repo.description ?? ""}
Stars: ${repo.stars}
Topics: ${repo.topics.join(", ")}
Language: ${repo.language ?? ""}
README:
${truncate(repo.readme, 3500)}`
      )
      .join("\n\n---\n\n");

    const allowedContentKinds = contentKindNames().join("|");
    const allowedIdeaKinds = ideaKindNames().join("|");
const prompt = `你是 ObsidianLink，一个个人技术知识库助理。请基于输入识别技术项目，也要提取视频/文本里的一般知识、教程步骤、观点、方法论和可复用经验。即使没有 GitHub 项目，也必须生成 knowledge 卡片和 3-5 个天马行空但可执行的组合创意。回答要精炼。

标题规则非常重要：
- knowledge.title、ideas.title、detectedProjects.noteTitle 都必须优先使用中文。
- 标题要像 Obsidian 文件名，概括内容价值，不要直接复制 URL、owner/repo、英文项目名或一句很长的原文。
- 标题长度建议 8-24 个汉字；可以保留必要英文技术名，但要加中文说明，例如“LangGraph 状态化智能体工作流”。
- GitHub 项目的 detectedProjects.name 保留项目/仓库名称，detectedProjects.noteTitle 写中文项目卡标题。
- 标题不要出现“知识整理”“未命名”“Inbox”“测试”这类空泛词，除非内容确实无法判断。

目录分类只能看内容形态 content_kind，不要用 AI/编程/产品/商业这类主题决定目录：
${contentKindPrompt()}

主题领域只放 domains，可多选 1-5 个：
${domainPrompt()}

必须只返回 JSON，不要 Markdown。字段：
{
  "summary": "整体摘要",
  "detectedProjects": [{"name":"","noteTitle":"中文项目卡标题","githubRepo":"","githubUrl":"","description":"","confidence":0.0,"evidence":[]}],
  "tags": ["ai","github"],
  "knowledge": [{"title":"","content_kind":"${allowedContentKinds}","domains":[],"entities":[],"category":"兼容字段，可写主要主题","summary":"","keyPoints":[],"sourceInsights":[],"relatedConcepts":[],"applicationIdeas":[],"nextActions":[]}],
  "ideas": [{"title":"","idea_kind":"${allowedIdeaKinds}","combinedWith":[],"productConcept":"","softwarePossibility":"","hardwarePossibility":"","userScenario":"","minimalExperiment":"","nextAction":""}]
}

用户原始输入：
${input.rawText}

抖音解析文本：
${input.douyinText || "(none)"}

视频/图文 OCR 文本：
${input.ocrText || "(none)"}

网页正文抽取：
${input.webpageText || "(none)"}

GitHub 研究结果：
${repoContext || "(none)"}

已有 Obsidian 项目索引：
		${input.existingIndex || "(none)"}`;
	
	    const content = await this.chat(prompt);
    const parsed = analysisSchema.parse(extractJsonObject(content));
    return {
      summary: parsed.summary,
      detectedProjects: parsed.detectedProjects.map((item) => ({
        ...item,
        noteTitle: item.noteTitle ?? item.note_title
      })),
      tags: parsed.tags,
      knowledge: parsed.knowledge.slice(0, 3).map((item) => ({
        ...item,
        contentKind: normalizeContentKind(item.contentKind ?? item.content_kind),
        domains: normalizeDomains(item.domains, `${item.category} ${item.summary} ${item.keyPoints.join(" ")}`),
        entities: item.entities,
        sourceType: normalizeSourceType(item.sourceType ?? item.source_type)
      })),
      ideas: parsed.ideas.slice(0, 5).map((item) => ({
        ...item,
        ideaKind: normalizeIdeaKind(item.ideaKind ?? item.idea_kind)
	      }))
	    };
	  }

  async developIdeaConversation(input: { messages: { role: "user" | "assistant"; content: string }[]; shouldSaveHint: boolean }): Promise<IdeaConversationResult> {
    this.assertConfigured();
    const transcript = input.messages.map((message) => `${message.role === "user" ? "用户" : "智能体"}：${message.content}`).join("\n");
    const prompt = `你是 ObsidianLink 的想法澄清智能体。用户不是在丢链接入库，而是在聊一个开发/产品/自动化点子。

你的目标：
1. 像正常聊天一样帮用户把想法聊清楚，不要每次都弹确认卡片。
2. 如果想法还模糊，回答要短，先复述你理解的方向，再问 1-3 个关键问题。
3. 如果用户明确说“记下来/入库/保存/整理一下/就这样”，或当前想法已经包含目标用户、问题、方案、最小实验中的至少 3 项，则 readyToSave=true。
4. readyToSave=true 时，输出一份可以写入 Obsidian 的灵感卡信息，同时 reply 要告诉用户已经准备沉淀/已沉淀，不要再追问一堆问题。
5. title 必须优先中文，概括这个想法的价值和场景，8-24 个汉字左右；不要直接复制用户第一句话，不要写“未命名想法/开发想法灵感/测试”。

只返回 JSON，不要 Markdown。字段：
{
  "readyToSave": false,
  "reply": "给用户的自然聊天回复",
  "title": "适合做 Obsidian 文件名的中文短标题",
  "summary": "这个想法的一句话总结",
  "clarifiedPoints": ["已经明确的点"],
  "openQuestions": ["还没明确的问题"],
  "domains": ["AI智能体","开发工程","自动化","产品体验"],
  "idea_kind": "product|automation|hardware|content|combo|unvalidated",
  "minimalExperiment": "最小实验",
  "nextAction": "下一步行动"
}

当前是否有明确保存信号：${input.shouldSaveHint ? "是" : "否"}

对话：
${transcript}`;

    const content = await this.chat(prompt);
    const parsed = ideaConversationSchema.parse(extractJsonObject(content));
    return {
      readyToSave: parsed.readyToSave,
      reply: parsed.reply,
      title: parsed.title,
      summary: parsed.summary,
      clarifiedPoints: parsed.clarifiedPoints,
      openQuestions: parsed.openQuestions,
      domains: normalizeDomains(parsed.domains, `${parsed.title} ${parsed.summary} ${parsed.clarifiedPoints.join(" ")}`),
      ideaKind: normalizeIdeaKind(parsed.ideaKind ?? parsed.idea_kind),
      minimalExperiment: parsed.minimalExperiment,
      nextAction: parsed.nextAction
    };
  }
	
	  private async chat(prompt: string): Promise<string> {
    let response: Response;
    const endpoint = `${config.OPENAI_BASE_URL.replace(/\/$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.OPENAI_TIMEOUT_MS);
    try {
      response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: config.OPENAI_MODEL,
          messages: [
            {
              role: "system",
              content: "You produce strict JSON for a Chinese personal knowledge base ingestion system."
            },
            { role: "user", content: prompt }
          ],
          temperature: 0.55,
          max_tokens: 4096,
          thinking: { type: "disabled" },
          response_format: { type: "json_object" }
        })
      });
    } catch (error) {
      throw new Error(`OpenAI-compatible fetch failed for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(`OpenAI-compatible request failed: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI-compatible response had no message content");
    return content;
  }

  private assertConfigured(): void {
    if (!config.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required for AI analysis");
    }
  }
}
