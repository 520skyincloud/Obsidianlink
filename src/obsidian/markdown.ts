import { GeneratedNote, GitHubRepo, IdeaCard, KnowledgeCard, StoredPreview } from "../types.js";
import {
  actionDirs,
  failedInboxDir,
  fullVaultDirs,
  ideaCardDir,
  inferDomains,
  knowledgeCardDir,
  normalizeContentKind,
  normalizeDomains,
  normalizeIdeaKind,
  projectRepoDir,
  sourceTypeFor
} from "../knowledgeTaxonomy.js";
import { nowIso, slugify } from "../utils.js";

export const vaultDirs = fullVaultDirs;

export function buildNotes(preview: StoredPreview): GeneratedNote[] {
  const notes: GeneratedNote[] = [];
  const created = nowIso();
  for (const repo of preview.githubRepos.slice(0, 1)) {
    notes.push(buildProjectNote(preview, repo, created));
  }
  if (notes.length > 0) return notes;
  if (preview.detectedProjects.length > 0) {
    return [buildProjectCandidateNote(preview, preview.detectedProjects[0], created)];
  }
  const primaryKnowledge = selectPrimaryKnowledge(preview);
  if (primaryKnowledge) notes.push(buildKnowledgeNote(preview, primaryKnowledge, created));
  if (notes.length === 0) {
    notes.push(buildInboxNote(preview, created));
  }
  return notes;
}

function selectPrimaryKnowledge(preview: StoredPreview): KnowledgeCard | undefined {
  return preview.knowledge.find((item) => normalizeContentKind(item.contentKind) !== "unknown") ?? preview.knowledge[0];
}

function buildProjectCandidateNote(preview: StoredPreview, project: StoredPreview["detectedProjects"][number], created: string): GeneratedNote {
  const title = cleanNoteTitle(project.noteTitle || project.name || preview.knowledge[0]?.title || project.githubRepo || project.githubUrl || "待确认项目线索", "待确认项目线索");
  const relativePath = `${projectRepoDir}/${slugify(title)}.md`;
  const domains = inferDomains(`${title} ${project.description ?? ""} ${preview.summary}`);
  const knowledgePoints = uniqueStrings(preview.knowledge.flatMap((item) => item.keyPoints));
  const sourceInsights = uniqueStrings(preview.knowledge.flatMap((item) => item.sourceInsights));
  const nextActions = uniqueStrings(preview.knowledge.flatMap((item) => item.nextActions));
  const evidence = uniqueStrings([...(project.evidence ?? []), ...preview.ocr.flatMap((item) => item.frameTexts ?? []), ...preview.douyin.map((item) => item.desc ?? "").filter(Boolean)]).slice(0, 12);
  const content = `---
type: project
title: "${escapeYaml(title)}"
source_type: "${sourceTypeFor(preview.request.source, preview.douyin.length > 0, false)}"
domains:
${yamlList(domains)}
entities:
${yamlList(uniqueStrings([title, ...(preview.knowledge.flatMap((item) => item.entities ?? []))]))}
aliases:
${yamlList(uniqueStrings([title, project.githubRepo ?? "", project.githubUrl ?? ""].filter(Boolean)))}
source_urls:
${yamlList(preview.parsedInput.urls)}
source_authors:
${yamlList(preview.douyin.map((item) => item.nickname ?? "").filter(Boolean))}
source_ids:
${yamlList(preview.douyin.map((item) => item.awemeId ?? "").filter(Boolean))}
github_repo: "${escapeYaml(project.githubRepo ?? "")}"
tags:
${yamlList(["project-candidate", "needs-verification", ...domains])}
status: needs_verification
created: "${created}"
updated: "${created}"
---

# ${title}

## 一句话总结
${project.description || preview.summary}

## 项目线索状态
这是一个从视频/OCR/自然语言中识别出的项目候选。当前还没有确认到稳定 GitHub 仓库，因此先只写这一张项目线索卡，不拆成多张知识卡。

## 它可能解决什么问题
${preview.summary}

## 画面与来源证据
${listOrFallback(evidence)}

## 可能的核心能力
${listOrFallback(knowledgePoints)}

## 来源洞察
${listOrFallback(sourceInsights)}

## 与我的知识库可能怎么联动
${preview.ideas
    .slice(0, 5)
    .map(
      (idea) => `### ${idea.title}
- 类型：${normalizeIdeaKind(idea.ideaKind)}
- 产品设想：${idea.productConcept}
- 软件可能性：${idea.softwarePossibility}
- 硬件可能性：${idea.hardwarePossibility}
- 用户场景：${idea.userScenario}
- 最小实验：${idea.minimalExperiment}
- 下一步：${idea.nextAction}`
    )
    .join("\n\n") || "暂无联动想法。"}

## 需要补充确认
- 找到准确 GitHub URL 或项目主页。
- 确认项目名称、作者、版本和许可证。
- 如果确认 repo，再把本卡升级为正式开源项目卡。

## 建议下一步
${listOrFallback(nextActions.length ? nextActions : ["补充 GitHub 链接或项目作者名。", "重新发送更清晰的截图/视频片段让 OCR 识别仓库名。"])}

## 来源
${sourceLines(preview)}

## 我的原始输入
${preview.request.text}
`;

  return {
    title,
    relativePath,
    content,
    type: "project",
    operation: "create",
    reason: "识别到项目线索但未确认 GitHub repo，生成单一项目候选卡",
    confidence: project.confidence ?? 0.62,
    githubRepo: project.githubRepo,
    sourceUrls: preview.parsedInput.urls,
    sourceIds: preview.douyin.map((item) => item.awemeId ?? "").filter(Boolean),
    entities: [title],
    domains
  };
}

function buildKnowledgeNote(preview: StoredPreview, knowledge: KnowledgeCard, created: string): GeneratedNote {
  const title = cleanNoteTitle(knowledge.title, fallbackKnowledgeTitle(preview));
  const contentKind = normalizeContentKind(knowledge.contentKind);
  const categoryPath = knowledgeCardDir(contentKind);
  const relativePath = `${categoryPath}/${slugify(title)}.md`;
  const projectLinks = preview.githubRepos.map((repo) => `[[${projectRepoDir}/${slugify(repo.fullName)}|${repo.fullName}]]`);
  const ideaLines = preview.ideas.map((idea) => `- ${idea.title}：${idea.productConcept || idea.minimalExperiment}`);
  const domains = normalizeDomains(knowledge.domains, `${knowledge.category} ${knowledge.summary} ${knowledge.keyPoints.join(" ")}`);
  const sourceType = knowledge.sourceType ?? sourceTypeFor(preview.request.source, preview.douyin.length > 0, preview.githubRepos.length > 0);
  const entities = uniqueStrings([...(knowledge.entities ?? []), ...preview.githubRepos.map((repo) => repo.fullName), ...knowledge.relatedConcepts]);

  const content = `---
type: knowledge
title: "${escapeYaml(title)}"
content_kind: "${contentKind}"
source_type: "${sourceType}"
domains:
${yamlList(domains)}
entities:
${yamlList(entities)}
category: "${escapeYaml(knowledge.category)}"
source_urls:
${yamlList(preview.parsedInput.urls)}
source_authors:
${yamlList(preview.douyin.map((item) => item.nickname ?? "").filter(Boolean))}
source_ids:
${yamlList(preview.douyin.map((item) => item.awemeId ?? "").filter(Boolean))}
tags:
${yamlList(["knowledge", contentKind, ...domains])}
status: active
created: "${created}"
updated: "${created}"
---

# ${title}

## 摘要
${knowledge.summary}

## 关键知识点
${listOrFallback(knowledge.keyPoints)}

## 视频/来源里的洞察
${listOrFallback(knowledge.sourceInsights)}

## 相关概念
${listOrFallback(knowledge.relatedConcepts)}

## 可以怎么用
${listOrFallback(knowledge.applicationIdeas)}

## 下一步行动
${listOrFallback(knowledge.nextActions)}

## 关联项目
${projectLinks.map((link) => `- ${link}`).join("\n") || "- 暂无"}

## 来源
${sourceLines(preview)}

## 关联创意
仅作联想摘要，未创建想法文件：
${ideaLines.join("\n") || "- 暂无"}

## 原始输入
${preview.request.text}
`;

  return {
    title,
    relativePath,
    content,
    type: "knowledge",
    operation: "create",
    reason: `按 content_kind=${contentKind} 写入知识卡`,
    confidence: 0.82,
    sourceUrls: preview.parsedInput.urls,
    sourceIds: preview.douyin.map((item) => item.awemeId ?? "").filter(Boolean),
    entities,
    domains
  };
}

function buildProjectNote(preview: StoredPreview, repo: GitHubRepo, created: string): GeneratedNote {
  const detected = preview.detectedProjects.find((project) => project.githubRepo === repo.fullName);
  const title = projectNoteTitle(preview, repo, detected);
  const tags = yamlList(["github-project", ...repo.topics.slice(0, 8)]);
  const sourceUrls = yamlList([repo.htmlUrl, ...preview.parsedInput.urls]);
  const aliases = yamlList(uniqueStrings([title, repo.fullName, repo.fullName.split("/")[1]]));
  const relativePath = `${projectRepoDir}/${slugify(title)}.md`;
  const domains = inferDomains(`${repo.fullName} ${repo.description ?? ""} ${repo.topics.join(" ")} ${preview.summary}`);
  const projectName = repo.fullName.split("/")[1];
  const evidence = detected?.evidence ?? [];
  const knowledgePoints = uniqueStrings(preview.knowledge.flatMap((item) => item.keyPoints));
  const sourceInsights = uniqueStrings(preview.knowledge.flatMap((item) => item.sourceInsights));
  const nextActions = uniqueStrings(preview.knowledge.flatMap((item) => item.nextActions));

  const content = `---
type: project
title: "${escapeYaml(title)}"
source_type: "github"
domains:
${yamlList(domains)}
entities:
${yamlList([repo.fullName, repo.fullName.split("/")[1]])}
aliases:
${aliases}
source_urls:
${sourceUrls}
source_authors:
${yamlList(preview.douyin.map((item) => item.nickname ?? "").filter(Boolean))}
source_ids:
${yamlList(preview.douyin.map((item) => item.awemeId ?? "").filter(Boolean))}
github_repo: "${escapeYaml(repo.fullName)}"
tags:
${tags}
status: active
created: "${created}"
updated: "${created}"
---

# ${title}

## 一句话总结
${detected?.description || repo.description || preview.summary}

## 项目定位
${projectName} 是一个 GitHub 开源项目。本次来源把它描述为一个值得关注的技术项目；系统已结合来源内容、OCR 文本和 GitHub 仓库信息做了基础研究。

${preview.summary}

## 它解决什么问题
${preview.summary}

## 关键能力
${listOrFallback(knowledgePoints.length ? knowledgePoints : [
    repo.description ?? `${projectName} 的核心能力需要结合 README 和实际试用继续补充。`
  ])}

## GitHub 信息
- 仓库：${repo.htmlUrl}
- Stars：${repo.stars}
- 主要语言：${repo.language ?? "Unknown"}
- License：${repo.license ?? "Unknown"}
- 最近更新：${repo.updatedAt}
- Topics：${repo.topics.join(", ") || "None"}

## 来源证据
${listOrFallback(evidence)}

## 来源洞察
${listOrFallback(sourceInsights)}

## 适用场景
${preview.ideas.map((idea) => `- ${idea.userScenario}`).join("\n") || "- 待补充"}

## 安装与使用线索
${extractReadmeSection(repo.readme)}

## 限制与风险
- 需要实际安装试用，确认 README 与当前版本是否一致。
- 需要检查依赖、权限、账号认证、Cookie/API Key 等敏感配置。
- 需要确认 License、数据安全、平台风控和长期维护状态。
- 最近更新：${repo.updatedAt}

## 与我的知识库可能怎么联动
${preview.ideas
    .map(
      (idea) => `### ${idea.title}
- 类型：${normalizeIdeaKind(idea.ideaKind)}
- 产品设想：${idea.productConcept}
- 软件可能性：${idea.softwarePossibility}
- 硬件可能性：${idea.hardwarePossibility}
- 用户场景：${idea.userScenario}
- 最小实验：${idea.minimalExperiment}
- 下一步：${idea.nextAction}`
    )
    .join("\n\n") || "暂无联动想法。"}

## 建议下一步
${listOrFallback(nextActions)}

## 相关项目
${preview.githubRepos
  .filter((item) => item.fullName !== repo.fullName)
    .map((item) => `- [[${projectRepoDir}/${slugify(item.fullName)}|${item.fullName}]]`)
  .join("\n") || "- 暂无"}

## 来源
${sourceLines(preview)}

## 我的原始输入
${preview.request.text}

## README 摘要素材
${readmeSummaryLines(repo.readme)}
`;

  return {
    title,
    relativePath,
    content,
    type: "project",
    operation: "create",
    reason: "识别到 GitHub repo，生成或更新项目卡",
    confidence: detected?.confidence ?? 0.9,
    githubRepo: repo.fullName,
    sourceUrls: [repo.htmlUrl, ...preview.parsedInput.urls],
    sourceIds: preview.douyin.map((item) => item.awemeId ?? "").filter(Boolean),
    entities: [repo.fullName, repo.fullName.split("/")[1]],
    domains
  };
}

function extractReadmeSection(readme: string): string {
  if (!readme.trim()) return "- README 暂无，建议打开仓库补充安装和使用方式。";
  const lines = readme
    .split(/\r?\n/)
    .map((line) => sanitizeReadmeLine(line))
    .filter(Boolean);
  const interesting = lines.filter((line) => /install|quick|start|usage|使用|安装|快速|配置|pip |npm |uv |docker|agent-reach/i.test(line));
  return listOrFallback(interesting.slice(0, 12));
}

function readmeSummaryLines(readme: string): string {
  if (!readme.trim()) return "暂无 README。";
  const lines = readme
    .split(/\r?\n/)
    .map((line) => sanitizeReadmeLine(line))
    .filter(Boolean)
    .filter((line) => !/^[-=]{3,}$/.test(line))
    .filter((line) => !/^<\/?(div|p|table|tr|td|img|a|h\d|summary|details)/i.test(line))
    .slice(0, 28);
  return listOrFallback(lines);
}

function sanitizeReadmeLine(line: string): string {
  return line
    .replace(/^\s*\[[^\]]+]:\s+\S+.*$/g, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\((?:\.{1,2}\/)?[^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`|]+/g, " ")
    .replace(/\((?:\.{1,2}\/)?(?:assets|images|docs|src|public)\/[^)]+\)/gi, "")
    .replace(/^\s*-\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildIdeaNote(preview: StoredPreview, idea: IdeaCard, projectLinks: string[], created: string): GeneratedNote {
  const title = cleanNoteTitle(idea.title, "未验证产品想法");
  const ideaKind = normalizeIdeaKind(idea.ideaKind);
  const relativePath = `${ideaCardDir(ideaKind)}/${slugify(title)}.md`;
  const domains = inferDomains(`${idea.title} ${idea.productConcept} ${idea.softwarePossibility} ${idea.hardwarePossibility}`, idea.combinedWith);
  const sourceType = sourceTypeFor(preview.request.source, preview.douyin.length > 0, preview.githubRepos.length > 0);
  const content = `---
type: idea
title: "${escapeYaml(title)}"
idea_kind: "${ideaKind}"
source_type: "${sourceType}"
domains:
${yamlList(domains)}
entities:
${yamlList(uniqueStrings(idea.combinedWith))}
tags:
${yamlList(["idea", ideaKind, ...domains])}
source_urls:
${yamlList(preview.parsedInput.urls)}
source_authors:
${yamlList(preview.douyin.map((item) => item.nickname ?? "").filter(Boolean))}
source_ids:
${yamlList(preview.douyin.map((item) => item.awemeId ?? "").filter(Boolean))}
status: seed
created: "${created}"
updated: "${created}"
---

# ${title}

## 组合对象
${projectLinks.map((link) => `- ${link}`).join("\n") || idea.combinedWith.map((item) => `- ${item}`).join("\n") || "- 待补充"}

## 产品设想
${idea.productConcept}

## 软件可能性
${idea.softwarePossibility}

## 硬件可能性
${idea.hardwarePossibility}

## 用户场景
${idea.userScenario}

## 最小实验
${idea.minimalExperiment}

## 下一步行动
${idea.nextAction}
`;
  return {
    title,
    relativePath,
    content,
    type: "idea",
    operation: "create",
    reason: `按 idea_kind=${ideaKind} 写入想法卡`,
    confidence: 0.76,
    sourceUrls: preview.parsedInput.urls,
    sourceIds: preview.douyin.map((item) => item.awemeId ?? "").filter(Boolean),
    entities: uniqueStrings(idea.combinedWith),
    domains
  };
}

function buildActionNote(preview: StoredPreview, idea: IdeaCard, projectLinks: string[], created: string): GeneratedNote {
  const title = cleanNoteTitle(`实验-${idea.title}`, "最小验证实验");
  const relativePath = `${actionDirs.experiment}/${slugify(title)}.md`;
  const domains = inferDomains(`${idea.title} ${idea.minimalExperiment} ${idea.nextAction}`, idea.combinedWith);
  const sourceType = sourceTypeFor(preview.request.source, preview.douyin.length > 0, preview.githubRepos.length > 0);
  const content = `---
type: action
title: "${escapeYaml(title)}"
action_kind: "experiment"
source_type: "${sourceType}"
domains:
${yamlList(domains)}
entities:
${yamlList(uniqueStrings(idea.combinedWith))}
tags:
${yamlList(["action", "experiment", ...domains])}
source_urls:
${yamlList(preview.parsedInput.urls)}
source_authors:
${yamlList(preview.douyin.map((item) => item.nickname ?? "").filter(Boolean))}
source_ids:
${yamlList(preview.douyin.map((item) => item.awemeId ?? "").filter(Boolean))}
status: todo
created: "${created}"
updated: "${created}"
---

# ${title}

## 关联创意
- [[${ideaCardDir(idea.ideaKind)}/${slugify(idea.title)}|${idea.title}]]

## 关联项目
${projectLinks.map((link) => `- ${link}`).join("\n") || "- 暂无"}

## 最小实验
${idea.minimalExperiment}

## 下一步
${idea.nextAction}
`;
  return {
    title,
    relativePath,
    content,
    type: "action",
    operation: "create",
    reason: "由想法卡生成最小实验",
    confidence: 0.72,
    sourceUrls: preview.parsedInput.urls,
    sourceIds: preview.douyin.map((item) => item.awemeId ?? "").filter(Boolean),
    entities: uniqueStrings(idea.combinedWith),
    domains
  };
}

function buildInboxNote(preview: StoredPreview, created: string): GeneratedNote {
  const title = cleanNoteTitle(fallbackKnowledgeTitle(preview), `待补充-${preview.previewId.slice(-8)}`);
  const relativePath = `${failedInboxDir}/${slugify(title)}.md`;
  const content = `---
type: inbox
title: "${title}"
source_type: "${sourceTypeFor(preview.request.source, preview.douyin.length > 0, preview.githubRepos.length > 0)}"
tags:
${yamlList(["inbox", "needs-review"])}
status: needs-review
created: "${created}"
updated: "${created}"
---

# ${title}

## 摘要
${preview.summary}

## 原始输入
${preview.request.text}

## 警告
${preview.warnings.map((warning) => `- ${warning}`).join("\n") || "- 无"}
`;
  return {
    title,
    relativePath,
    content,
    type: "inbox",
    operation: "create",
    reason: "没有生成正式卡片，进入失败待补充",
    confidence: 0.3,
    sourceUrls: preview.parsedInput.urls,
    sourceIds: preview.douyin.map((item) => item.awemeId ?? "").filter(Boolean)
  };
}

function listOrFallback(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- 待补充";
}

function yamlList(items: string[]): string {
  if (items.length === 0) return "  []";
  return items.map((item) => `  - "${escapeYaml(item)}"`).join("\n");
}

function escapeYaml(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))].slice(0, 12);
}

function sourceLines(preview: StoredPreview): string {
  const douyin = preview.douyin.map((item) =>
    `- 抖音：${item.sourceUrl}${item.nickname ? ` / 作者：${item.nickname}` : ""}${item.awemeId ? ` / aweme_id：${item.awemeId}` : ""}`
  );
  const webpages = (preview.webpages ?? []).map((item) => `- 网页：${item.title ? `${item.title} / ` : ""}${item.canonicalUrl ?? item.url}`);
  const urls = preview.parsedInput.urls
    .filter((url) => !preview.douyin.some((item) => item.sourceUrl === url))
    .filter((url) => !(preview.webpages ?? []).some((item) => item.url === url || item.canonicalUrl === url))
    .map((url) => `- ${url}`);
  return [...douyin, ...webpages, ...urls].join("\n") || "- 暂无";
}

function projectNoteTitle(preview: StoredPreview, repo: GitHubRepo, detected?: StoredPreview["detectedProjects"][number]): string {
  const projectName = repo.fullName.split("/")[1];
  const candidates = [
    detected?.noteTitle,
    preview.knowledge.find((item) => item.entities?.includes(repo.fullName) || item.title.includes(repo.fullName.split("/")[1]))?.title,
    preview.knowledge[0]?.title,
    repo.description ? compactChineseSummary(repo.description) : ""
  ];
  const chineseSummary = candidates
    .map((item) => cleanProjectSummary(item ?? "", projectName))
    .find((item) => containsChinese(item)) || "开源项目研究";
  return cleanNoteTitle(`${projectName} - ${chineseSummary}`, `${projectName} - 开源项目研究`);
}

function fallbackKnowledgeTitle(preview: StoredPreview): string {
  const webpageTitle = preview.webpages?.find((item) => item.title?.trim())?.title;
  const douyinDesc = preview.douyin.find((item) => item.desc?.trim())?.desc;
  const raw = webpageTitle || douyinDesc || preview.summary || preview.request.text || "待补充内容";
  return cleanNoteTitle(compactChineseSummary(raw), "待补充内容");
}

function compactChineseSummary(input: string): string {
  const clean = input
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#*_`~>\[\]{}()（）"'“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  const phrase = clean
    .replace(/^这个(视频|项目|内容|文章)?(主要)?(介绍|讲|说)?/i, "")
    .replace(/^(本次输入|该抖音内容|该视频|这个项目|该项目)/, "")
    .trim();
  return phrase.length > 34 ? phrase.slice(0, 34) : phrase;
}

function cleanProjectSummary(input: string, projectName: string): string {
  const escapedName = projectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return compactChineseSummary(input)
    .replace(new RegExp(`^${escapedName}\\s*[-:：]*\\s*`, "i"), "")
    .replace(/^开源项目\s*[-:：]*\s*/, "")
    .trim();
}

function containsChinese(input: string): boolean {
  return /[\u3400-\u9fff]/.test(input);
}

function cleanNoteTitle(input: string, fallback: string): string {
  const normalized = input
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title = normalized || fallback;
  const compact = title.length > 42 ? title.slice(0, 42) : title;
  return compact || "未命名卡片";
}
