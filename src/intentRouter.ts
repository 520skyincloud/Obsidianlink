export type MessageIntentKind =
  | "casual_chat"
  | "help"
  | "status"
  | "confirm_preview"
  | "cancel_preview"
  | "supplement_preview"
  | "source_ingest"
  | "knowledge_ingest"
  | "idea_chat";

export interface MessageIntentResult {
  kind: MessageIntentKind;
  confidence: number;
  reason: string;
  extraText?: string;
  sourceHint?: "douyin" | "github" | "web" | "plain";
}

export interface MessageIntentContext {
  hasOpenIdeaSession?: boolean;
  hasPendingPreview?: boolean;
}

export function classifyMessageIntent(text: string, context: MessageIntentContext = {}): MessageIntentResult {
  const clean = text.trim();
  if (!clean) return intent("casual_chat", 1, "empty");

  const sourceHint = detectHardSource(clean);
  if (sourceHint) return intent("source_ingest", 0.98, `hard_source:${sourceHint}`, { sourceHint });

  const supplement = clean.match(/^(补充|追加|修改|更正|说明|再补充)\s*[:：]?\s*(.+)$/i);
  if (supplement?.[2]) return intent("supplement_preview", 0.96, "explicit_supplement", { extraText: supplement[2].trim() });

  if (/^(状态|进度|status|待确认|pending)$/i.test(clean)) return intent("status", 0.98, "explicit_status");
  if (/^(取消|丢弃|不要了|算了|cancel|no|n)$/i.test(clean)) return intent("cancel_preview", 0.98, "explicit_cancel");

  if (/^(确认|确认写入|写入|保存|入库|ok|yes|y|可以|可以了|就这样|先这样)$/i.test(clean)) {
    if (context.hasOpenIdeaSession) return intent("idea_chat", 0.97, "save_open_idea_session");
    return intent("confirm_preview", 0.96, "explicit_confirm");
  }

  if (/^(hi|hello|你好|在吗|帮助|help)$/i.test(clean)) {
    return intent(/帮助|help/i.test(clean) ? "help" : "casual_chat", 0.99, "greeting_or_help");
  }

  if (looksLikeConcreteProjectQuery(clean)) {
    return intent("source_ingest", 0.86, "github_project_lookup", { sourceHint: "github" });
  }

  if (context.hasOpenIdeaSession) {
    return intent("idea_chat", 0.9, "continue_open_idea_session");
  }

  if (isLowInformation(clean)) return intent("casual_chat", 0.9, "low_information");
  if (looksLikeIdeaConversation(clean)) return intent("idea_chat", 0.82, "idea_keywords");
  if (looksLikeKnowledgeCapture(clean)) return intent("knowledge_ingest", 0.72, "long_knowledge_capture", { sourceHint: "plain" });

  return intent("casual_chat", 0.66, "default_chat");
}

export function isHardSourceText(text: string): boolean {
  return Boolean(detectHardSource(text.trim()));
}

export function hasIdeaSaveSignal(text: string): boolean {
  const clean = text.trim();
  if (/不要保存|别保存|先别保存|不要入库|别入库|先别入库|不保存|不入库|不要写|别写|先别写/i.test(clean)) return false;
  return /确认保存|确认入库|记下来|保存|入库|写进\s*obsidian|写到\s*obsidian|放进\s*obsidian|沉淀|归档|整理一下|就这样|先这样|可以了/i.test(clean);
}

export function isLowInformation(text: string): boolean {
  const clean = text.trim();
  if (/^(测试|test|随便|无聊|可是无聊\d*)$/i.test(clean)) return true;
  if (clean.length <= 8 && !/(项目|想法|点子|开发|功能|需求|保存|入库|抖音|github)/i.test(clean)) return true;
  return false;
}

function detectHardSource(text: string): MessageIntentResult["sourceHint"] | undefined {
  if (/v\.douyin\.com|douyin\.com|iesdouyin\.com|复制打开抖音|打开抖音/i.test(text)) return "douyin";
  if (/https?:\/\/github\.com\/[^/\s]+\/[^/\s#?]+/i.test(text)) return "github";
  if (/https?:\/\/\S+/i.test(text)) return "web";
  return undefined;
}

function looksLikeIdeaConversation(text: string): boolean {
  if (looksLikeConcreteProjectQuery(text)) return false;
  return /想法|点子|灵感|脑洞|做个|做一个|开发|功能|需求|产品|工具|自动化|智能体|工作流|插件|页面|系统|能不能|可不可以|有没有办法|我想|我希望|如果把|要不要/i.test(text);
}

function looksLikeConcreteProjectQuery(text: string): boolean {
  if (looksLikeProductBuildIdea(text) && !hasProjectLookupVerb(text)) return false;
  if (!/github|git\s*hub|开源项目|仓库|repo|repository/i.test(text)) return false;
  if (/知识库|已有项目|项目研究|github项目研究|联动分析/i.test(text) && !/叫|名为|项目是|研究一下|看看|搜索|repo/i.test(text)) return false;
  if (/(项目名|项目名称|项目名字|仓库名|仓库名称|仓库名字|repo\s*name|repository\s*name)\s*(是|叫|为|:|：)?\s*[A-Za-z0-9_. -]{2,}/i.test(text)) return true;
  if (/(叫|名为|名字是|名称是)\s*[A-Za-z][A-Za-z0-9_. -]{2,}/i.test(text) && /github|git\s*hub|开源项目|仓库|repo|repository/i.test(text)) return true;
  if (hasProjectLookupVerb(text)) return true;
  return /github\s*项目|git\s*hub\s*项目|开源项目\s+\S+|\S+\s*(这个)?\s*(github|git\s*hub)\s*(项目|仓库|repo)/i.test(text);
}

function hasProjectLookupVerb(text: string): boolean {
  if (/搜索工具|搜索系统|搜索网站|搜索平台|搜索插件|搜索功能/i.test(text)) return false;
  return /研究一下|研究|看看|看一下|搜索|搜一下|搜|找到|找一下|找|查一下|查找|定位|帮我找|帮我搜|帮我查/i.test(text);
}

function looksLikeProductBuildIdea(text: string): boolean {
  return /(我想|我希望|想做|做个|做一个|开发|搭一个|搞一个|设计一个).*(工具|系统|网站|平台|插件|智能体|工作流|产品|功能)/i.test(text);
}

function looksLikeKnowledgeCapture(text: string): boolean {
  if (text.length < 20) return false;
  if (/^(为什么|怎么|如何|能不能|可不可以).*[？?]$/.test(text) && !/记录|保存|入库|沉淀|整理/.test(text)) return false;
  return /记录|保存|入库|沉淀|整理|知识|教程|方法|经验|观点|案例|坑|技术分享|今天刷到|看到一个|学到/i.test(text) || text.length >= 60;
}

function intent(kind: MessageIntentKind, confidence: number, reason: string, patch: Partial<MessageIntentResult> = {}): MessageIntentResult {
  return { kind, confidence, reason, ...patch };
}
