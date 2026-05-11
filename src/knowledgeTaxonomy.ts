import { ContentKind, IdeaKind, SourceKind } from "./types.js";

export interface DomainRule {
  name: string;
  description: string;
  keywords: RegExp;
}

export const inboxDir = "0_收件箱/0_待处理";
export const needsMoreInboxDir = "0_收件箱/1_需补充";
export const failedInboxDir = "0_收件箱/2_处理失败";
export const quickNoteDir = "0_收件箱/3_随手记";

export const projectDirs = {
  openSource: "1_项目/0_开源项目",
  software: "1_项目/1_工具软件",
  product: "1_项目/2_产品服务",
  hardware: "1_项目/3_硬件设备",
  api: "1_项目/4_API与平台",
  mine: "1_项目/5_我的项目"
} as const;

export const contentKindDirs: Record<ContentKind, string> = {
  concept: "2_知识/0_概念",
  method: "2_知识/2_方法",
  tutorial: "2_知识/3_教程",
  opinion: "2_知识/7_观点",
  tool: "2_知识/3_教程",
  pitfall: "2_知识/5_坑点",
  case: "2_知识/6_案例",
  unknown: needsMoreInboxDir
};

export const knowledgeDirs = {
  principle: "2_知识/1_原理",
  experience: "2_知识/4_经验"
} as const;

export const abilityDirs = {
  ai: "3_能力/0_AI能力",
  automation: "3_能力/1_自动化能力",
  data: "3_能力/2_数据能力",
  interaction: "3_能力/3_交互能力",
  hardware: "3_能力/4_硬件能力",
  content: "3_能力/5_内容能力",
  engineering: "3_能力/6_工程能力"
} as const;

export const ideaKindDirs: Record<IdeaKind, string> = {
  product: "4_想法/0_产品想法",
  automation: "4_想法/2_自动化想法",
  hardware: "4_想法/3_硬件想法",
  content: "4_想法/4_内容想法",
  combo: "4_想法/5_组合想法",
  unvalidated: "4_想法/5_组合想法"
};

export const ideaExtraDirs = {
  tool: "4_想法/1_工具想法"
} as const;

export const actionDirs = {
  experiment: "5_实验/0_最小实验",
  prototype: "5_实验/1_原型",
  research: "5_实验/2_调研",
  decision: "5_实验/3_决策",
  review: "5_实验/4_复盘",
  abandoned: "5_实验/5_废弃"
} as const;

export const outputDirs = {
  productDoc: "6_作品/0_产品文档",
  techPlan: "6_作品/1_技术方案",
  prompt: "6_作品/2_提示词",
  script: "6_作品/3_文章脚本",
  code: "6_作品/4_代码片段",
  publish: "6_作品/5_发布素材"
} as const;

export const mapDirs = {
  overview: "7_地图/0_总览",
  topics: "7_地图/1_主题地图",
  projects: "7_地图/2_项目地图",
  abilities: "7_地图/3_能力地图",
  ideas: "7_地图/4_想法地图",
  roadmap: "7_地图/5_路线图"
} as const;

export const archiveDirs = {
  oldProjects: "8_归档/0_旧项目",
  oldIdeas: "8_归档/1_旧想法",
  oldExperiments: "8_归档/2_旧实验",
  oldMaterials: "8_归档/3_旧资料"
} as const;

export const systemDirs = {
  templates: "9_系统/0_模板",
  rules: "9_系统/1_规则",
  logs: "9_系统/2_日志",
  config: "9_系统/3_配置"
} as const;

export const fullVaultDirs = [
  "0_收件箱",
  "0_收件箱/0_待处理",
  "0_收件箱/1_需补充",
  "0_收件箱/2_处理失败",
  "0_收件箱/3_随手记",
  "1_项目",
  "1_项目/0_开源项目",
  "1_项目/1_工具软件",
  "1_项目/2_产品服务",
  "1_项目/3_硬件设备",
  "1_项目/4_API与平台",
  "1_项目/5_我的项目",
  "2_知识",
  "2_知识/0_概念",
  "2_知识/1_原理",
  "2_知识/2_方法",
  "2_知识/3_教程",
  "2_知识/4_经验",
  "2_知识/5_坑点",
  "2_知识/6_案例",
  "2_知识/7_观点",
  "3_能力",
  "3_能力/0_AI能力",
  "3_能力/1_自动化能力",
  "3_能力/2_数据能力",
  "3_能力/3_交互能力",
  "3_能力/4_硬件能力",
  "3_能力/5_内容能力",
  "3_能力/6_工程能力",
  "4_想法",
  "4_想法/0_产品想法",
  "4_想法/1_工具想法",
  "4_想法/2_自动化想法",
  "4_想法/3_硬件想法",
  "4_想法/4_内容想法",
  "4_想法/5_组合想法",
  "5_实验",
  "5_实验/0_最小实验",
  "5_实验/1_原型",
  "5_实验/2_调研",
  "5_实验/3_决策",
  "5_实验/4_复盘",
  "5_实验/5_废弃",
  "6_作品",
  "6_作品/0_产品文档",
  "6_作品/1_技术方案",
  "6_作品/2_提示词",
  "6_作品/3_文章脚本",
  "6_作品/4_代码片段",
  "6_作品/5_发布素材",
  "7_地图",
  "7_地图/0_总览",
  "7_地图/1_主题地图",
  "7_地图/2_项目地图",
  "7_地图/3_能力地图",
  "7_地图/4_想法地图",
  "7_地图/5_路线图",
  "8_归档",
  "8_归档/0_旧项目",
  "8_归档/1_旧想法",
  "8_归档/2_旧实验",
  "8_归档/3_旧资料",
  "9_系统",
  "9_系统/0_模板",
  "9_系统/1_规则",
  "9_系统/2_日志",
  "9_系统/3_配置"
] as const;

export const projectRepoDir = projectDirs.openSource;

export const domainRules: DomainRule[] = [
  {
    name: "AI智能体",
    description: "大模型、Agent、RAG、多模态、模型 API、自动推理和 AI 应用架构。",
    keywords: /AI|人工智能|智能体|agent|LLM|大模型|模型|RAG|向量|embedding|prompt|提示词|多模态|OCR|OpenAI|GLM|LangGraph|LangChain/i
  },
  {
    name: "开发工程",
    description: "语言、框架、SDK、API、测试、部署、代码质量、工程效率和开源库使用经验。",
    keywords: /代码|开发|编程|框架|SDK|API|TypeScript|Node|Python|React|Vue|测试|部署|CI|工程|依赖|npm|pnpm|Docker|GitHub/i
  },
  {
    name: "知识管理",
    description: "Obsidian、笔记法、知识库、搜索、索引、数据库、文档处理、信息抽取和知识组织。",
    keywords: /知识库|笔记|Obsidian|Notion|检索|搜索|索引|数据库|文档|Markdown|信息抽取|分类|标签|双链|归档/i
  },
  {
    name: "自动化",
    description: "Bot、工作流、脚本、快捷入口、RPA、低摩擦采集和个人操作系统。",
    keywords: /自动化|工作流|效率|Bot|机器人|飞书|微信|QQ|Telegram|Webhook|脚本|快捷|RPA|同步|提醒|复盘|番茄钟/i
  },
  {
    name: "产品体验",
    description: "产品功能、交互、界面、用户场景、需求判断、原型和体验优化。",
    keywords: /产品|用户|交互|界面|UI|UX|体验|原型|需求|场景|设计|可用性|转化|留存/i
  },
  {
    name: "系统架构",
    description: "服务架构、消息系统、队列、缓存、网络、安全、权限、存储、可观测和稳定性。",
    keywords: /架构|服务|队列|缓存|网络|安全|权限|鉴权|签名|存储|日志|监控|可观测|稳定性|高可用|网关/i
  },
  {
    name: "硬件物联",
    description: "硬件、传感器、物联网、机器人、嵌入式、树莓派、Arduino、智能家居和实体设备。",
    keywords: /硬件|传感器|树莓派|Arduino|ESP32|物联网|IoT|机器人|嵌入式|电机|摄像头|智能家居|设备/i
  },
  {
    name: "内容媒体",
    description: "视频、音频、直播、字幕、剪辑、素材、内容生产、媒体处理和传播表达。",
    keywords: /视频|抖音|B站|字幕|音频|剪辑|直播|媒体|内容|素材|创作|传播|脚本|文案|录屏|ffmpeg/i
  },
  {
    name: "商业增长",
    description: "商业模式、获客、销售、增长、定价、运营、市场、成本收益和可变现路径。",
    keywords: /商业|变现|赚钱|获客|销售|增长|运营|市场|定价|成本|收益|客户|渠道|SaaS|订阅/i
  },
  {
    name: "生活通识",
    description: "非技术但值得沉淀的生活经验、学习方法、健康、消费、心理、时间管理和通识观点。",
    keywords: /生活|学习|健康|消费|心理|时间管理|习惯|通识|读书|教育|沟通|决策/i
  }
];

export function contentKindNames(): ContentKind[] {
  return Object.keys(contentKindDirs) as ContentKind[];
}

export function ideaKindNames(): IdeaKind[] {
  return Object.keys(ideaKindDirs) as IdeaKind[];
}

export function domainPrompt(): string {
  return domainRules.map((domain) => `- ${domain.name}：${domain.description}`).join("\n");
}

export function contentKindPrompt(): string {
  return [
    "- concept：概念定义、术语解释、原理框架",
    "- method：方法论、策略、可复用做法",
    "- tutorial：教程步骤、操作指南、配置过程",
    "- opinion：观点判断、趋势分析、取舍评价",
    "- tool：工具用法、软件能力、项目使用方式",
    "- pitfall：坑点、限制、故障、风险和反模式",
    "- case：案例、产品拆解、实践记录",
    "- unknown：信息不足，需要补充判断"
  ].join("\n");
}

export function normalizeContentKind(value: string | undefined): ContentKind {
  const clean = value?.trim() as ContentKind | undefined;
  if (clean && clean in contentKindDirs) return clean;
  const legacy = normalizeLegacyCategory(value ?? "");
  if (legacy === "开发工程") return "tool";
  if (legacy === "系统架构" || legacy === "自动化") return "method";
  if (legacy === "产品体验" || legacy === "商业增长") return "case";
  return "unknown";
}

export function normalizeIdeaKind(value: string | undefined): IdeaKind {
  const clean = value?.trim() as IdeaKind | undefined;
  if (clean && clean in ideaKindDirs) return clean;
  return "product";
}

export function knowledgeCardDir(contentKind: string | undefined): string {
  return contentKindDirs[normalizeContentKind(contentKind)];
}

export function ideaCardDir(ideaKind: string | undefined): string {
  return ideaKindDirs[normalizeIdeaKind(ideaKind)];
}

export function sourceTypeFor(source: SourceKind, hasDouyin = false, hasGithub = false): SourceKind | "douyin" | "github" | "manual" {
  if (hasDouyin) return "douyin";
  if (hasGithub) return "github";
  if (source === "cli") return "manual";
  return source;
}

export function normalizeSourceType(value: string | undefined): SourceKind | "douyin" | "github" | "manual" | undefined {
  const allowed = new Set(["qq", "feishu", "wechat", "wecom", "dingtalk", "telegram", "cli", "web", "api", "douyin", "github", "manual"]);
  const clean = value?.trim();
  return clean && allowed.has(clean) ? (clean as SourceKind | "douyin" | "github" | "manual") : undefined;
}

export function inferDomains(text: string, explicit: string[] = []): string[] {
  const domains = new Set(explicit.map((item) => normalizeLegacyCategory(item)).filter(Boolean));
  for (const rule of domainRules) {
    if (rule.keywords.test(text)) domains.add(rule.name);
  }
  if (!domains.size) domains.add("知识管理");
  return [...domains].slice(0, 5);
}

export function normalizeDomains(values: string[] | undefined, fallbackText: string): string[] {
  return inferDomains(fallbackText, values ?? []);
}

export function normalizeLegacyCategory(category: string): string {
  const clean = category.trim();
  const legacy: Record<string, string> = {
    AI与自动化: "AI智能体",
    AI智能体与模型: "AI智能体",
    编程开发: "开发工程",
    开发框架与工程实践: "开发工程",
    数据检索与知识管理: "知识管理",
    硬件与物联网: "硬件物联",
    硬件物联与具身设备: "硬件物联",
    产品设计: "产品体验",
    产品设计与用户体验: "产品体验",
    效率工作流: "自动化",
    自动化流程与效率工具: "自动化",
    系统架构: "系统架构",
    系统架构与基础设施: "系统架构",
    媒体与内容: "内容媒体",
    内容创作与媒体技术: "内容媒体",
    商业洞察: "商业增长",
    商业运营与变现: "商业增长",
    生活知识: "生活通识",
    生活决策与通识: "生活通识",
    未分类: "知识管理",
    待判断: "知识管理"
  };
  if (legacy[clean]) return legacy[clean];
  if (domainRules.some((rule) => rule.name === clean)) return clean;
  return clean;
}

export function guessKnowledgeCategory(text: string): string {
  return inferDomains(text)[0] ?? "知识管理";
}
