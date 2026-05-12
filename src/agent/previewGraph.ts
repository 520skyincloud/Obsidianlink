import { Annotation, END, START, StateGraph } from "#langgraph";
import { DouyinClient } from "../clients/douyin.js";
import { GitHubClient } from "../clients/github.js";
import { OcrClient } from "../clients/ocr.js";
import { OpenAIClient } from "../clients/openai.js";
import { WebpageExtractor } from "../clients/webpage.js";
import { Repositories } from "../database/repositories.js";
import { parseInput } from "../inputParser.js";
import {
  guessKnowledgeCategory,
  normalizeContentKind,
  normalizeDomains,
  normalizeIdeaKind,
  sourceTypeFor
} from "../knowledgeTaxonomy.js";
import { buildNotes } from "../obsidian/markdown.js";
import { ObsidianVault } from "../obsidian/vault.js";
import {
  DouyinMetadata,
  GitHubRepo,
  IdeaCard,
  KnowledgeCard,
  OcrResult,
  ParsedInput,
  PreviewRequest,
  StoredPreview,
  WebpageExtractResult
} from "../types.js";
import { nowIso, previewId, unique } from "../utils.js";

interface PreviewTracking {
  jobId: string;
  runId: string;
}

interface PreviewAgentDeps {
  request: PreviewRequest;
  tracking: PreviewTracking;
  douyin: DouyinClient;
  github: GitHubClient;
  ocr: OcrClient;
  webpage: WebpageExtractor;
  ai: OpenAIClient;
  vault: ObsidianVault;
  repo: Repositories;
}

interface AnalysisShape {
  summary: string;
  detectedProjects: StoredPreview["detectedProjects"];
  tags: string[];
  knowledge: KnowledgeCard[];
  ideas: IdeaCard[];
}

const PreviewState = Annotation.Root({
  request: Annotation<PreviewRequest>,
  parsedInput: Annotation<ParsedInput | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  route: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "plain"
  }),
  warnings: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  douyinResults: Annotation<DouyinMetadata[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  ocrResults: Annotation<OcrResult[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  webpageResults: Annotation<WebpageExtractResult[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  repoNames: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  repos: Annotation<GitHubRepo[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  existingIndex: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => ""
  }),
  analysis: Annotation<AnalysisShape | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  storedPreview: Annotation<StoredPreview | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  })
});

type PreviewStateType = typeof PreviewState.State;

export async function runPreviewAgentGraph(deps: PreviewAgentDeps): Promise<StoredPreview> {
  const graph = new StateGraph(PreviewState)
    .addNode("load_context", async (state) => logNode(deps, "load_context", undefined, state, async () => ({}), `${deps.request.source}/${deps.request.senderId}`, deps.request.text.slice(0, 120)))
    .addNode("intent_router", async (state) => logNode(deps, "intent_router", undefined, state, async () => ({}), deps.request.text.slice(0, 120), "new_ingest"))
    .addNode("parse_input", async (state) =>
      logNode(deps, "parse_input", "url_parser", state, async () => {
        const parsedInput = parseInput(state.request.text);
        return { parsedInput };
      }, state.request.text.slice(0, 160), undefined)
    )
    .addNode("source_type_router", async (state) =>
      logNode(deps, "source_type_router", undefined, state, async () => {
        const parsed = requireParsed(state);
        const route = parsed.douyinUrls.length
          ? "douyin"
          : parsed.githubRepos.length || shouldSearchGitHub(parsed.rawText, parsed.candidateQuery)
            ? "github"
            : webpageUrls(parsed).length
              ? "webpage"
              : "plain";
        return { route };
      }, summarizeParsed(requireParsed(state)), undefined)
    )
    .addNode("douyin_pipeline", async (state) =>
      logNode(deps, "douyin_pipeline", undefined, state, async () => {
        const parsed = requireParsed(state);
        const warnings = [...state.warnings];
        const douyinResults: DouyinMetadata[] = [];
        const ocrResults: OcrResult[] = [];
        for (const url of parsed.douyinUrls) {
          try {
            const metadata = await runTrackedTool(deps, "douyin_pipeline", "douyin_parser", { url }, () => deps.douyin.parse(url));
            douyinResults.push(metadata);
            const imageUrls = metadata.images ?? [];
            const videoUrl = metadata.videoUrlHQ ?? metadata.videoUrl;
            const ocr = imageUrls.length
              ? await runTrackedTool(
                  deps,
                  "douyin_pipeline",
                  "image_downloader+ocr_reader",
                  { sourceUrl: url, imageCount: imageUrls.length, imageUrls: imageUrls.slice(0, 5) },
                  () => deps.ocr.analyzeImages(imageUrls),
                  (result) => (result.error ? "warning" : "success")
                )
              : await runTrackedTool(
                  deps,
                  "douyin_pipeline",
                  "video_downloader+frame_extractor+ocr_reader",
                  { sourceUrl: url, videoUrl },
                  () => deps.ocr.analyzeVideo(videoUrl),
                  (result) => (result.error ? "warning" : "success")
                );
            ocrResults.push(ocr);
            if (ocr.error) warnings.push(`OCR: ${ocr.error}`);
          } catch (error) {
            warnings.push(`Douyin parse failed for ${url}: ${messageOf(error)}`);
          }
        }
        return { warnings, douyinResults, ocrResults };
      }, requireParsed(state).douyinUrls.join(", ") || "没有抖音链接", undefined, state.parsedInput?.douyinUrls.length ? undefined : "skipped")
    )
    .addNode("webpage_pipeline", async (state) =>
      logNode(deps, "webpage_pipeline", "webpage_extractor", state, async () => {
        const parsed = requireParsed(state);
        const urls = webpageUrls(parsed);
        const warnings = [...state.warnings];
        const webpageResults: WebpageExtractResult[] = [];
        for (const url of urls) {
          try {
            webpageResults.push(await runTrackedTool(deps, "webpage_pipeline", "webpage_extractor", { url }, () => deps.webpage.extract(url)));
          } catch (error) {
            warnings.push(`Webpage extract failed for ${url}: ${messageOf(error)}`);
          }
        }
        return { warnings, webpageResults };
      }, `${webpageUrls(requireParsed(state)).length} urls`, undefined)
    )
    .addNode("github_pipeline", async (state) =>
      logNode(deps, "github_pipeline", "github_researcher", state, async () => {
        const parsed = requireParsed(state);
        const warnings = [...state.warnings];
        const repoNames = unique([
          ...parsed.githubRepos,
          ...extractReposFromText(state.douyinResults.map((item) => item.desc ?? "").join("\n")),
          ...extractReposFromText(state.ocrResults.map((item) => item.text).join("\n")),
          ...extractReposFromText(state.webpageResults.map((item) => `${item.title ?? ""}\n${item.text}`).join("\n"))
        ]);
        const repos: GitHubRepo[] = [];
        for (const repoName of repoNames) {
          try {
            repos.push(await deps.github.getRepo(repoName));
          } catch (error) {
            warnings.push(`未能确认 GitHub 仓库 ${repoName}，已跳过项目卡生成。`);
          }
        }
        if (repos.length === 0) {
          const discoveredQueries = unique([
            ...extractGitHubSearchQueriesFromText(state.ocrResults.map((item) => item.text).join("\n")),
            ...extractGitHubSearchQueriesFromText(state.douyinResults.map((item) => item.desc ?? "").join("\n")),
            ...extractGitHubSearchQueriesFromText(state.webpageResults.map((item) => `${item.title ?? ""}\n${item.text}`).join("\n"))
          ]);
          for (const query of discoveredQueries) {
            try {
              const repo = await deps.github.searchRepo(query);
            if (repo) {
                repos.push(repo);
                break;
              }
            } catch (error) {
              warnings.push(`GitHub 搜索暂时失败：${query}。本次先按知识线索处理。`);
            }
          }
        }
        if (repos.length === 0 && shouldSearchGitHub(parsed.rawText, parsed.candidateQuery)) {
          try {
            const repo = await deps.github.searchRepo(parsed.candidateQuery);
            if (repo) repos.push(repo);
          } catch (error) {
            warnings.push("GitHub 搜索暂时失败，本次先按知识线索处理。");
          }
        }
        return { warnings, repoNames, repos };
      }, state.repoNames.join(", ") || requireParsed(state).candidateQuery || "无 GitHub 候选", undefined)
    )
    .addNode("plain_text_pipeline", async (state) => logNode(deps, "plain_text_pipeline", undefined, state, async () => ({}), requireParsed(state).rawText.slice(0, 160), "普通文本进入知识抽取"))
    .addNode("mixed_input_pipeline", async (state) => logNode(deps, "mixed_input_pipeline", undefined, state, async () => ({}), summarizeParsed(requireParsed(state)), "已合并多来源事实"))
    .addNode("research_collector", async (state) =>
      logNode(deps, "research_collector", undefined, state, async () => ({}), `${state.douyinResults.length} douyin, ${state.ocrResults.length} ocr, ${state.webpageResults.length} webpages, ${state.repos.length} repos`, "facts merged")
    )
    .addNode("vault_context_retriever", async (state) =>
      logNode(deps, "vault_context_retriever", "vault_searcher", state, async () => {
        const existingIndex = await deps.vault.readExistingProjectIndex();
        return { existingIndex };
      }, "读取已有项目索引", undefined)
    )
    .addNode("knowledge_extractor", async (state) =>
      logNode(deps, "knowledge_extractor", "llm_analyzer", state, async () => {
        const parsed = requireParsed(state);
        const warnings = [...state.warnings];
        let analysis: AnalysisShape;
        try {
          analysis = await deps.ai.analyze({
            rawText: state.request.text,
            douyinText: state.douyinResults.map(formatDouyin).join("\n\n"),
            ocrText: state.ocrResults.map((result) => result.text).join("\n\n"),
            webpageText: state.webpageResults.map(formatWebpage).join("\n\n"),
            repos: state.repos,
            existingIndex: state.existingIndex
          });
        } catch (error) {
          warnings.push(`AI 分析失败，已启用本地兜底预览：${messageOf(error)}`);
          analysis = fallbackAnalysis(state.request.text, state.repos, state.douyinResults, state.ocrResults, state.webpageResults);
        }
        analysis.knowledge = analysis.knowledge.map((item) => ({
          ...item,
          contentKind: normalizeContentKind(item.contentKind),
          domains: normalizeDomains(item.domains, `${item.category} ${item.summary} ${item.keyPoints.join(" ")}`),
          sourceType: item.sourceType ?? sourceTypeFor(state.request.source, state.douyinResults.length > 0, state.repos.length > 0),
          entities: unique([...(item.entities ?? []), ...state.repos.map((repo) => repo.fullName), ...item.relatedConcepts])
        }));
        if (state.repos.length === 0) {
          analysis.detectedProjects = analysis.detectedProjects.filter((project) => project.name?.trim() || project.githubUrl?.trim() || project.githubRepo?.trim());
        }
        if (state.repos.length === 0 && analysis.knowledge.length === 0) {
          warnings.push("没有确定的 GitHub repo，也没有生成知识卡片；确认后会写入 Inbox，建议补充项目名、链接或你关心的方向后重新生成。");
        }
        if (state.ocrResults.some((result) => !result.text.trim())) {
          warnings.push("视频/图片 OCR 没有识别出有效文本；已使用描述、原始输入和 GitHub 搜索兜底。");
        }
        return { warnings, analysis };
      }, `${state.repos.length} repos, ocr=${state.ocrResults.reduce((sum, item) => sum + item.text.length, 0)}`, undefined)
    )
    .addNode("idea_generator", async (state) =>
      logNode(deps, "idea_generator", undefined, state, async () => {
        const analysis = requireAnalysis(state);
        return { analysis: { ...analysis, ideas: analysis.ideas.map((item) => ({ ...item, ideaKind: normalizeIdeaKind(item.ideaKind) })) } };
      }, `${requireAnalysis(state).knowledge.length} knowledge`, `${requireAnalysis(state).ideas.length} ideas`)
    )
    .addNode("action_generator", async (state) => logNode(deps, "action_generator", undefined, state, async () => ({}), `${requireAnalysis(state).ideas.length} ideas`, "每个 idea 将生成最小实验卡"))
    .addNode("note_planner", async (state) =>
      logNode(deps, "note_planner", "markdown_builder", state, async () => {
        const parsed = requireParsed(state);
        const analysis = requireAnalysis(state);
        const storedPreview = makeStoredPreview(state.request, parsed, analysis, state.warnings, state.douyinResults, state.ocrResults, state.webpageResults, state.repos);
        storedPreview.notesToWrite = await deps.vault.planNotes(buildNotes(storedPreview));
        return { storedPreview };
      }, `${requireAnalysis(state).knowledge.length} knowledge, ${requireAnalysis(state).ideas.length} ideas`, undefined)
    )
    .addNode("preview_builder", async (state) => logNode(deps, "preview_builder", undefined, state, async () => ({}), "生成预览", `${requireStored(state).notesToWrite.length} notes`))
    .addNode("quality_checker", async (state) =>
      logNode(deps, "quality_checker", undefined, state, async () => ({}), "检查 warnings", requireStored(state).warnings.join("；") || "无风险", requireStored(state).warnings.length ? "warning" : undefined)
    )
    .addNode("reply_builder", async (state) => logNode(deps, "reply_builder", undefined, state, async () => ({}), requireStored(state).previewId, "等待用户确认"))
    .addEdge(START, "load_context")
    .addEdge("load_context", "intent_router")
    .addEdge("intent_router", "parse_input")
    .addEdge("parse_input", "source_type_router")
    .addEdge("source_type_router", "douyin_pipeline")
    .addEdge("douyin_pipeline", "webpage_pipeline")
    .addEdge("webpage_pipeline", "github_pipeline")
    .addEdge("github_pipeline", "plain_text_pipeline")
    .addEdge("plain_text_pipeline", "mixed_input_pipeline")
    .addEdge("mixed_input_pipeline", "research_collector")
    .addEdge("research_collector", "vault_context_retriever")
    .addEdge("vault_context_retriever", "knowledge_extractor")
    .addEdge("knowledge_extractor", "idea_generator")
    .addEdge("idea_generator", "action_generator")
    .addEdge("action_generator", "note_planner")
    .addEdge("note_planner", "preview_builder")
    .addEdge("preview_builder", "quality_checker")
    .addEdge("quality_checker", "reply_builder")
    .addEdge("reply_builder", END)
    .compile();

  const finalState = await graph.invoke({ request: deps.request });
  if (!finalState.storedPreview) throw new Error("Preview graph finished without stored preview");
  return finalState.storedPreview;
}

async function logNode(
  deps: PreviewAgentDeps,
  nodeName: string,
  toolName: string | undefined,
  state: PreviewStateType,
  fn: () => Promise<Partial<PreviewStateType>>,
  inputSummary?: string,
  outputSummary?: string,
  forcedStatus?: "success" | "warning" | "failed" | "skipped"
) {
  const started = Date.now();
  deps.repo.updateJob(deps.tracking.jobId, { currentNode: nodeName });
  deps.repo.addStep({ runId: deps.tracking.runId, jobId: deps.tracking.jobId, nodeName, status: "running", inputSummary, toolName });
  try {
    const result = await fn();
    const nextState = { ...state, ...result } as PreviewStateType;
    const status = forcedStatus ?? inferStepStatus(nodeName, nextState);
    if (toolName) {
      deps.repo.addToolCall({
        runId: deps.tracking.runId,
        jobId: deps.tracking.jobId,
        nodeName,
        toolName,
        input: { inputSummary },
        output: summarizeToolOutput(nodeName, result),
        status,
        durationMs: Date.now() - started
      });
    }
    deps.repo.addStep({
      runId: deps.tracking.runId,
      jobId: deps.tracking.jobId,
      nodeName,
      status,
      inputSummary,
      outputSummary: outputSummary ?? summarizeNode(nodeName, nextState),
      toolName,
      durationMs: Date.now() - started
    });
    return result;
  } catch (error) {
    if (toolName) {
      deps.repo.addToolCall({
        runId: deps.tracking.runId,
        jobId: deps.tracking.jobId,
        nodeName,
        toolName,
        input: { inputSummary },
        status: "failed",
        durationMs: Date.now() - started,
        error: messageOf(error)
      });
    }
    deps.repo.addStep({
      runId: deps.tracking.runId,
      jobId: deps.tracking.jobId,
      nodeName,
      status: "failed",
      inputSummary,
      toolName,
      durationMs: Date.now() - started,
      error: messageOf(error)
    });
    throw error;
  }
}

function inferStepStatus(nodeName: string, state: PreviewStateType): "success" | "warning" | "skipped" {
  if (nodeName === "douyin_pipeline" && !state.parsedInput?.douyinUrls.length) return "skipped";
  if (nodeName === "webpage_pipeline" && !state.webpageResults.length) return state.warnings.some((warning) => warning.startsWith("Webpage extract failed")) ? "warning" : "skipped";
  if (nodeName === "github_pipeline" && !state.repos.length) return "skipped";
  if (nodeName === "quality_checker" && state.warnings.length) return "warning";
  if (nodeName === "knowledge_extractor" && state.warnings.some((warning) => warning.startsWith("AI 分析失败"))) return "warning";
  return "success";
}

function summarizeNode(nodeName: string, state: PreviewStateType): string {
  if (nodeName === "parse_input") return state.parsedInput ? summarizeParsed(state.parsedInput) : "";
  if (nodeName === "source_type_router") return state.route;
  if (nodeName === "douyin_pipeline") return `${state.douyinResults.length} douyin, ${state.ocrResults.reduce((sum, item) => sum + item.framesAnalyzed, 0)} media`;
  if (nodeName === "webpage_pipeline") return state.webpageResults.length ? state.webpageResults.map((item) => `${item.title ?? item.url} chars=${item.text.length}`).join("; ") : "没有网页正文";
  if (nodeName === "github_pipeline") return state.repos.length ? state.repos.map((repo) => `${repo.fullName} stars=${repo.stars}`).join("; ") : "没有确定 repo";
  if (nodeName === "vault_context_retriever") return `${state.existingIndex.split(/\n/).filter(Boolean).length} existing projects`;
  if (nodeName === "knowledge_extractor") return state.analysis ? `${state.analysis.knowledge.length} knowledge, ${state.analysis.ideas.length} ideas` : "";
  if (nodeName === "note_planner") return state.storedPreview ? `${state.storedPreview.notesToWrite.length} notes` : "";
  return "";
}

function summarizeToolOutput(nodeName: string, result: Partial<PreviewStateType>) {
  if (nodeName === "parse_input") return result.parsedInput;
  if (nodeName === "douyin_pipeline") {
    return {
      douyin: (result.douyinResults ?? []).map((item) => ({
        sourceUrl: item.sourceUrl,
        nickname: item.nickname,
        desc: item.desc,
        awemeId: item.awemeId,
        hasVideo: Boolean(item.videoUrl || item.videoUrlHQ),
        imageCount: item.images?.length ?? 0
      })),
      ocr: (result.ocrResults ?? []).map((item) => ({
        framesAnalyzed: item.framesAnalyzed,
        available: item.available,
        sourceImageCount: item.sourceImages?.length ?? 0,
        imageTextCount: item.imageTexts?.length ?? 0,
        textPreview: item.text.slice(0, 600),
        error: item.error
      })),
      warnings: result.warnings ?? []
    };
  }
  if (nodeName === "github_pipeline") {
    return {
      repoNames: result.repoNames ?? [],
      repos: (result.repos ?? []).map((repo) => ({
        fullName: repo.fullName,
        htmlUrl: repo.htmlUrl,
        description: repo.description,
        stars: repo.stars,
        topics: repo.topics,
        license: repo.license,
        updatedAt: repo.updatedAt,
        language: repo.language
      })),
      warnings: result.warnings ?? []
    };
  }
  if (nodeName === "webpage_pipeline") {
    return {
      webpages: (result.webpageResults ?? []).map((item) => ({
        url: item.url,
        canonicalUrl: item.canonicalUrl,
        title: item.title,
        description: item.description,
        status: item.status,
        contentType: item.contentType,
        excerpt: item.excerpt,
        textPreview: item.text.slice(0, 1200)
      })),
      warnings: result.warnings ?? []
    };
  }
  if (nodeName === "vault_context_retriever") {
    return { lineCount: result.existingIndex?.split(/\n/).filter(Boolean).length ?? 0 };
  }
  if (nodeName === "knowledge_extractor") {
    return result.analysis
      ? {
          summary: result.analysis.summary,
          detectedProjects: result.analysis.detectedProjects.length,
          knowledge: result.analysis.knowledge.map((item) => ({ title: item.title, contentKind: item.contentKind, domains: item.domains })),
          ideas: result.analysis.ideas.map((item) => ({ title: item.title, ideaKind: item.ideaKind })),
          warnings: result.warnings ?? []
        }
      : {};
  }
  if (nodeName === "note_planner") {
    return {
      previewId: result.storedPreview?.previewId,
      notesToWrite: result.storedPreview?.notesToWrite ?? []
    };
  }
  return result;
}

function makeStoredPreview(
  request: PreviewRequest,
  parsedInput: ParsedInput,
  analysis: AnalysisShape,
  warnings: string[],
  douyin: DouyinMetadata[],
  ocr: OcrResult[],
  webpages: WebpageExtractResult[],
  githubRepos: GitHubRepo[]
): StoredPreview {
  return {
    previewId: previewId(),
    summary: analysis.summary,
    detectedProjects: analysis.detectedProjects,
    notesToWrite: [],
    knowledge: analysis.knowledge,
    ideas: analysis.ideas,
    warnings,
    request,
    parsedInput,
    douyin,
    ocr,
    webpages,
    githubRepos,
    createdAt: nowIso(),
    status: "pending"
  };
}

function requireParsed(state: PreviewStateType): ParsedInput {
  if (!state.parsedInput) throw new Error("parsedInput missing");
  return state.parsedInput;
}

function requireAnalysis(state: PreviewStateType): AnalysisShape {
  if (!state.analysis) throw new Error("analysis missing");
  return state.analysis;
}

function requireStored(state: PreviewStateType): StoredPreview {
  if (!state.storedPreview) throw new Error("storedPreview missing");
  return state.storedPreview;
}

async function runTrackedTool<T>(
  deps: PreviewAgentDeps,
  nodeName: string,
  toolName: string,
  input: unknown,
  fn: () => Promise<T>,
  statusFromOutput?: (output: T) => "success" | "warning" | "skipped"
): Promise<T> {
  const started = Date.now();
  try {
    const output = await fn();
    deps.repo.addToolCall({
      runId: deps.tracking.runId,
      jobId: deps.tracking.jobId,
      nodeName,
      toolName,
      input,
      output: sanitizeToolOutput(toolName, output),
      status: statusFromOutput?.(output) ?? "success",
      durationMs: Date.now() - started
    });
    return output;
  } catch (error) {
    deps.repo.addToolCall({
      runId: deps.tracking.runId,
      jobId: deps.tracking.jobId,
      nodeName,
      toolName,
      input,
      status: "failed",
      durationMs: Date.now() - started,
      error: messageOf(error)
    });
    throw error;
  }
}

function sanitizeToolOutput(toolName: string, output: unknown): unknown {
  if (toolName === "douyin_parser" && output && typeof output === "object") {
    const item = output as DouyinMetadata;
    return {
      type: item.type,
      sourceUrl: item.sourceUrl,
      nickname: item.nickname,
      desc: item.desc,
      awemeId: item.awemeId,
      hasVideo: Boolean(item.videoUrl || item.videoUrlHQ),
      imageCount: item.images?.length ?? 0
    };
  }
  if (toolName.includes("ocr_reader") && output && typeof output === "object") {
    const item = output as OcrResult;
    return {
      textPreview: item.text.slice(0, 1200),
      framesAnalyzed: item.framesAnalyzed,
      available: item.available,
      subtitleLength: item.subtitleText?.length ?? 0,
      frameTextCount: item.frameTexts?.length ?? 0,
      imageTextCount: item.imageTexts?.length ?? 0,
      sourceImageCount: item.sourceImages?.length ?? 0,
      tempCleaned: item.tempCleaned,
      error: item.error
    };
  }
  if (toolName === "webpage_extractor" && output && typeof output === "object") {
    const item = output as WebpageExtractResult;
    return {
      url: item.url,
      canonicalUrl: item.canonicalUrl,
      title: item.title,
      description: item.description,
      status: item.status,
      contentType: item.contentType,
      excerpt: item.excerpt,
      textPreview: item.text.slice(0, 1200)
    };
  }
  return output;
}

function summarizeParsed(parsed: ParsedInput): string {
  return `${parsed.urls.length} urls, ${parsed.douyinUrls.length} douyin, ${parsed.githubRepos.length} github`;
}

function webpageUrls(parsed: ParsedInput): string[] {
  return parsed.urls.filter((url) => !parsed.douyinUrls.includes(url) && !/github\.com\//i.test(url));
}

function extractReposFromText(text: string): string[] {
  const repos: string[] = [];
  const githubUrlRegex = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi;
  for (const match of text.matchAll(githubUrlRegex)) {
    const owner = match[1];
    const repo = match[2].replace(/[^\w.-].*$/, "");
    if (isLikelyRepoShorthand(owner, repo)) repos.push(`${owner}/${repo}`);
  }
  const shorthandRegex = /\b([A-Za-z0-9_.-]{2,})\/([A-Za-z0-9_.-]{2,})\b/g;
  for (const match of text.matchAll(shorthandRegex)) {
    if (isPathLikeMatch(text, match)) continue;
    if (match[1].includes(".")) continue;
    if (!isLikelyRepoShorthand(match[1], match[2])) continue;
    if (/\.(mp4|mov|m4v|webm|png|jpg|jpeg|gif|md|txt)$/i.test(match[2])) continue;
    if (!match[0].includes("http")) repos.push(`${match[1]}/${match[2]}`);
  }
  return unique(repos);
}

function extractGitHubSearchQueriesFromText(text: string): string[] {
  const queries: string[] = [];
  if (/\bAgent[-\s]?Reach\b/i.test(text) || /Give your AI agent eyes to see/i.test(text)) {
    queries.push('"Agent Reach"');
  }
  return queries;
}

function isLikelyRepoShorthand(owner: string, repo: string): boolean {
  if (/^\d+$/.test(owner) || /^\d+$/.test(repo)) return false;
  const generic = new Set([
    "rss",
    "atom",
    "issue",
    "issues",
    "pr",
    "pull",
    "owner",
    "omer",
    "repo",
    "repository",
    "repositories",
    "github",
    "docs",
    "api",
    "rest",
    "workflow",
    "workflows",
    "http",
    "https"
  ]);
  return !generic.has(owner.toLowerCase()) && !generic.has(repo.toLowerCase());
}

function isPathLikeMatch(text: string, match: RegExpMatchArray): boolean {
  const index = match.index ?? 0;
  const previous = text[index - 1] ?? "";
  return previous === "/" || previous === "\\" || previous === ".";
}

export function shouldSearchGitHub(rawText: string, candidateQuery: string): boolean {
  if (!candidateQuery.trim()) return false;
  if (/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/.test(rawText)) return true;
  if (/github\.com\//i.test(rawText)) return true;
  if (/(项目名|仓库名|repo\s*name|repository\s*name|叫|名为|是)\s*[:：]?\s*[A-Za-z][A-Za-z0-9_.-]{2,}/i.test(rawText)) return true;
  const hasGithubIntent = /github|git hub|repo|repository|仓库|开源项目/i.test(rawText);
  if (!hasGithubIntent) return false;
  const compact = rawText.replace(/\s+/g, " ").trim();
  if (compact.length > 90) return false;
  const projectTokens = compact.match(/\b[A-Za-z][A-Za-z0-9_.-]{2,}\b/g) ?? [];
  const genericTokens = new Set(["github", "repo", "repository", "openai", "api", "bot", "obsidian", "douyin"]);
  return projectTokens.some((token) => !genericTokens.has(token.toLowerCase()));
}

function formatDouyin(metadata: DouyinMetadata): string {
  return `source=${metadata.sourceUrl}
type=${metadata.type ?? ""}
nickname=${metadata.nickname ?? ""}
desc=${metadata.desc ?? ""}
aweme_id=${metadata.awemeId ?? ""}
video=${metadata.videoUrlHQ ?? metadata.videoUrl ?? ""}
images=${(metadata.images ?? []).join("\n")}`;
}

function formatWebpage(page: WebpageExtractResult): string {
  return `url=${page.url}
canonical=${page.canonicalUrl ?? ""}
title=${page.title ?? ""}
description=${page.description ?? ""}
excerpt=${page.excerpt}
text=${page.text}`;
}

function fallbackAnalysis(rawText: string, repos: GitHubRepo[], douyin: DouyinMetadata[], ocr: OcrResult[], webpages: WebpageExtractResult[] = []): AnalysisShape {
  const sourceText = [rawText, ...douyin.map((item) => item.desc ?? ""), ...ocr.map((item) => item.text), ...webpages.map((item) => `${item.title ?? ""}\n${item.excerpt || item.text}`)].filter(Boolean).join("\n");
  const repoNames = repos.map((repo) => repo.fullName);
  const summary = repos.length
    ? `本次输入包含 ${repoNames.join(", ")}，系统已基于 GitHub 元数据生成基础项目预览。AI 暂时不可用，建议确认前人工检查摘要。`
    : webpages.length
      ? `本次输入包含 ${webpages.length} 个网页来源，系统已抽取标题和正文摘要生成基础知识预览。AI 暂时不可用，建议确认前人工检查重点。`
    : "本次输入被识别为通用知识/想法内容。AI 暂时不可用，系统已生成基础知识卡片，后续可重新生成以获得更丰富联想。";
  const knowledge: KnowledgeCard[] = [
    {
      title: repos.length ? `${repos[0].fullName} 的知识库接入笔记` : webpages[0]?.title ? `${webpages[0].title} 知识整理` : fallbackTitle(sourceText),
      category: repos.length ? "系统架构与基础设施" : guessKnowledgeCategory(sourceText),
      contentKind: repos.length ? "tool" : "method",
      domains: normalizeDomains([], sourceText),
      sourceType: sourceTypeFor("api", douyin.length > 0, repos.length > 0),
      entities: unique([...repoNames, "Obsidian", "知识库"]),
      summary,
      keyPoints: repos.length ? repos.map((repo) => `${repo.fullName}: ${repo.description ?? "GitHub 项目"}`) : [sourceText.slice(0, 180) || "待补充"],
      sourceInsights: ["AI 分析超时或失败，本卡片由本地规则生成。"],
      relatedConcepts: repos.length ? ["GitHub", "Obsidian", "知识库"] : ["个人知识管理", "知识卡片", "自动化"],
      applicationIdeas: ["确认写入后，可在 Obsidian 中继续补充细节。"],
      nextActions: ["稍后重新生成 AI 预览", "人工检查分类和标题"]
    }
  ];
  const ideas: IdeaCard[] = [
    {
      title: repos.length ? "项目知识库自动摄入流水线" : "视频知识自动整理流水线",
      ideaKind: "automation",
      combinedWith: repoNames.length ? repoNames : ["Obsidian", "AI 自动化"],
      productConcept: "把来源内容先转成可确认预览，再写入项目卡片、知识卡片和创意卡片。",
      softwarePossibility: "用本地服务连接聊天入口、解析接口、GitHub API 和 Obsidian Markdown。",
      hardwarePossibility: "可扩展成桌面快捷键、语音按钮或移动端分享入口。",
      userScenario: "刷到内容后直接发送给 Bot，晚上统一确认入库。",
      minimalExperiment: "先用网页入口跑通一条内容的预览与确认写入。",
      nextAction: "检查本次兜底卡片，并在 AI 服务恢复后重新生成。"
    }
  ];
  return {
    summary,
    detectedProjects: repos.map((repo) => ({
      name: repo.fullName.split("/")[1],
      githubRepo: repo.fullName,
      githubUrl: repo.htmlUrl,
      description: repo.description ?? "GitHub 项目",
      confidence: 0.8,
      evidence: ["GitHub API"]
    })),
    tags: ["fallback"],
    knowledge,
    ideas
  };
}

function fallbackTitle(text: string): string {
  const clean = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  return clean ? `${clean.slice(0, 28)}知识整理` : "未命名知识整理";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
