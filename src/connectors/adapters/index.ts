import crypto from "node:crypto";
import { Request } from "express";
import { getFeishuLongConnectionStatus, sendFeishuReply } from "../feishuLongConnection.js";
import { AgentMessageResponse, SourceKind } from "../../types.js";
import {
  ChallengeResult,
  ConnectorAdapter,
  ConnectorConfigField,
  ConnectorReplyTarget,
  ConnectorRuntimeConfig,
  ConnectorSetupStatus,
  ConnectorTestResult,
  commonTextPayloadSchema,
  contentText,
  firstNonEmpty,
  readPath,
  requireEnabled,
  setupStatus
} from "./types.js";

const okChallenge: ChallengeResult = { handled: false };

async function unsupportedReply(label: string): Promise<ConnectorTestResult> {
  return { ok: false, message: `${label} 暂未实现主动异步回复；HTTP 调用方可直接使用接口响应。` };
}

function toAgentResponse(reply: { text: string; jobId?: string; runId?: string; previewId?: string; preview?: AgentMessageResponse["preview"]; action?: string; warnings?: string[] }): AgentMessageResponse {
  const action = isAgentAction(reply.action) ? reply.action : "chat_reply";
  return {
    ok: action !== "error",
    action,
    jobId: reply.jobId,
    runId: reply.runId,
    previewId: reply.previewId,
    preview: reply.preview,
    reply: reply.text,
    writtenFiles: [],
    warnings: reply.warnings ?? []
  };
}

function isAgentAction(action: string | undefined): action is AgentMessageResponse["action"] {
  return Boolean(action && [
    "auto_written",
    "preview_only",
    "ignored",
    "error",
    "queued",
    "preview_generated",
    "confirmed",
    "cancelled",
    "regenerated",
    "chat_reply",
    "idea_saved"
  ].includes(action));
}

function targetRaw(target: ConnectorReplyTarget): Record<string, unknown> {
  return target.raw ?? {
    senderId: target.senderId,
    chatId: target.chatId,
    messageId: target.messageId
  };
}

function field(key: string, envKey: string, label: string, options: Partial<ConnectorConfigField> = {}): ConnectorConfigField {
  return { key, envKey, label, ...options };
}

function genericFields(): ConnectorConfigField[] {
  return [field("apiToken", "GENERIC_WEBHOOK_TOKEN", "调用 Token", { secret: true, placeholder: "可选" })];
}

function simpleTextMessage(source: SourceKind, payload: unknown) {
  const body = commonTextPayloadSchema.parse(payload ?? {});
  const text = firstNonEmpty([
    body.text,
    contentText(body.content),
    body.message,
    body.rawText,
    contentText(readPath(payload, ["event", "message", "content"])),
    readPath(payload, ["event", "message", "text"]),
    contentText(readPath(payload, ["text", "content"])),
    readPath(payload, ["xml", "Content"])
  ]);
  if (!text) throw new Error("消息里没有可处理的文本内容");
  return {
    text,
    source,
    senderId:
      firstNonEmpty([
        body.senderId,
        body.userId,
        body.openId,
        body.chatId,
        readPath(payload, ["event", "sender", "sender_id", "open_id"]),
        readPath(payload, ["event", "sender", "sender_id", "user_id"]),
        readPath(payload, ["event", "message", "chat_id"]),
        readPath(payload, ["xml", "FromUserName"]),
        readPath(payload, ["sender", "id"])
      ]) ?? `${source}-unknown`,
    messageId:
      firstNonEmpty([
        body.messageId,
        body.msgId,
        body.message_id,
        readPath(payload, ["event", "message", "message_id"]),
        readPath(payload, ["header", "event_id"]),
        readPath(payload, ["event", "event_id"]),
        readPath(payload, ["xml", "MsgId"]),
        readPath(payload, ["message", "id"])
      ]) ?? `${source}-${Date.now()}`,
    chatId: firstNonEmpty([body.chatId, readPath(payload, ["event", "message", "chat_id"]), readPath(payload, ["message", "chat", "id"])]),
    autoWrite: body.autoWrite ?? false,
    raw: payload && typeof payload === "object" ? (payload as Record<string, unknown>) : { value: payload }
  };
}

function bearerOrHeaderToken(req: Request): string | undefined {
  const auth = req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.header("x-obsidianlink-token") ?? undefined;
}

function sha1Hex(values: string[]): string {
  return crypto.createHash("sha1").update(values.sort().join("")).digest("hex");
}

function timingSafeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseXmlText(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /<([A-Za-z0-9_:-]+)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) {
    const key = match[1].includes(":") ? match[1].split(":").pop() ?? match[1] : match[1];
    const value = (match[2] ?? match[3] ?? "").trim();
    if (key.toLowerCase() === "xml") Object.assign(result, parseXmlText(value));
    else result[key] = value;
  }
  return result;
}

function requestBody(req: Request): unknown {
  if (typeof req.body === "string") {
    if (req.is("*/xml") || req.body.trim().startsWith("<")) return { xml: parseXmlText(req.body) };
    try {
      return JSON.parse(req.body) as unknown;
    } catch {
      return { text: req.body };
    }
  }
  return req.body;
}

function decryptFeishuBody(body: unknown, encryptKey: string): unknown {
  const encrypt = readPath(body, ["encrypt"]);
  if (typeof encrypt !== "string" || !encrypt.trim()) return body;
  if (!encryptKey) throw new Error("飞书推送了加密事件，但 FEISHU_ENCRYPT_KEY 未配置");
  const encrypted = Buffer.from(encrypt, "base64");
  if (encrypted.length <= 16) throw new Error("飞书加密事件格式无效");
  const iv = encrypted.subarray(0, 16);
  const content = encrypted.subarray(16);
  const key = crypto.createHash("sha256").update(encryptKey, "utf8").digest();
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(content), decipher.final()]).toString("utf8");
  try {
    return JSON.parse(decrypted) as unknown;
  } catch {
    throw new Error("飞书加密事件解密成功，但解密内容不是合法 JSON");
  }
}

function feishuBody(req: Request, config: ConnectorRuntimeConfig): unknown {
  return decryptFeishuBody(requestBody(req), config.values.encryptKey);
}

function makeStatus(fields: ConnectorConfigField[], config: ConnectorRuntimeConfig, capabilities: string[], notes: string[] = []): ConnectorSetupStatus {
  return setupStatus(fields, config, capabilities, notes);
}

function isPublicHttps(config: ConnectorRuntimeConfig): boolean {
  return /^https:\/\//i.test(config.publicBaseUrl) && !/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(config.publicBaseUrl);
}

function publicUrlNote(config: ConnectorRuntimeConfig, platform: string): string {
  return isPublicHttps(config)
    ? `${platform} 可使用当前 HTTPS 公网回调地址。`
    : `${platform} 真实平台回调需要 HTTPS 公网地址；当前本机地址只能做本地模拟或内网穿透后再测试。`;
}

const feishuFields = [
  field("appId", "FEISHU_APP_ID", "App ID", { required: true, placeholder: "cli_xxx" }),
  field("appSecret", "FEISHU_APP_SECRET", "App Secret", { required: true, secret: true, placeholder: "留空则不修改" }),
  field("verificationToken", "FEISHU_VERIFICATION_TOKEN", "Verification Token", { required: true, secret: true, placeholder: "飞书事件订阅 Verification Token" }),
  field("encryptKey", "FEISHU_ENCRYPT_KEY", "Encrypt Key", { secret: true, placeholder: "可选；配置后自动解密 encrypt 事件" }),
  field("longConnection", "FEISHU_LONG_CONNECTION_ENABLED", "长连接模式", { placeholder: "true 开启；本机无需公网回调" })
];

const feishuAdapter: ConnectorAdapter = {
  source: "feishu",
  adapter: "feishu-events",
  label: "飞书",
  endpoint: "/connectors/feishu/message",
  description: "飞书机器人长连接优先：消息和卡片按钮都可由 WSClient 接收；HTTP 回调只作为备用。",
  mode: "protocol",
  getConfigSchema: () => feishuFields,
  getSetupStatus: (config) => {
    const runtime = getFeishuLongConnectionStatus();
    return makeStatus(
      feishuFields,
      config,
      ["飞书长连接 WSClient", "文本消息事件解析", "卡片按钮事件 card.action.trigger", "Webhook URL verification 备用", "Verification Token 校验", "AES-256-CBC 加密事件解密"],
      [
        config.values.encryptKey ? "已配置 Encrypt Key；会自动解密飞书 encrypt 事件。" : "未配置 Encrypt Key；Webhook 加密推送需填写 Encrypt Key。",
        runtime.note,
        runtime.lastEventAt ? `最近长连接事件：${runtime.lastEventAt}` : "",
        runtime.lastReplyAt ? `最近长连接回复：${runtime.lastReplyAt}` : "",
        runtime.lastError ? `长连接错误：${runtime.lastError}` : ""
      ].filter(Boolean)
    );
  },
  handleChallenge: async (req, config) => {
    const body = feishuBody(req, config) as Record<string, unknown>;
    if (body?.type !== "url_verification") return okChallenge;
    if (config.values.verificationToken && body.token !== config.values.verificationToken) throw new Error("飞书 Verification Token 校验失败");
    return { handled: true, status: 200, body: { challenge: body.challenge } };
  },
  verifyRequest: async (req, config) => {
    requireEnabled(config, "飞书");
    const body = feishuBody(req, config) as Record<string, unknown>;
    const token = firstNonEmpty([body.token, readPath(body, ["header", "token"])]);
    if (config.values.verificationToken && token && token !== config.values.verificationToken) throw new Error("飞书 Verification Token 校验失败");
  },
  normalizeMessage: async (req, config) => {
    const body = feishuBody(req, config);
    const text = firstNonEmpty([contentText(readPath(body, ["event", "message", "content"])), readPath(body, ["event", "message", "text"]), contentText(readPath(body, ["message", "content"])), readPath(body, ["text"])]);
    if (!text) throw new Error(`飞书事件中没有文本消息内容：${JSON.stringify(feishuPayloadSummary(body))}`);
    return {
      text,
      source: "feishu",
      senderId:
        firstNonEmpty([
          readPath(body, ["event", "sender", "sender_id", "open_id"]),
          readPath(body, ["event", "sender", "sender_id", "user_id"]),
          readPath(body, ["sender", "sender_id", "open_id"])
        ]) ?? "feishu-unknown",
      messageId:
        firstNonEmpty([
          readPath(body, ["event", "message", "message_id"]),
          readPath(body, ["header", "event_id"]),
          readPath(body, ["event", "event_id"])
        ]) ?? `feishu-${Date.now()}`,
      chatId: firstNonEmpty([readPath(body, ["event", "message", "chat_id"]), readPath(body, ["message", "chat_id"])]),
      autoWrite: false,
      raw: body && typeof body === "object" ? (body as Record<string, unknown>) : { value: body }
    };
  },
  sendReply: async (target, reply) => {
    await sendFeishuReply(targetRaw(target), reply.text, toAgentResponse(reply));
    return { ok: true, message: "飞书回复已提交；若事件缺少 message_id 则会自动跳过。" };
  },
  sendTestMessage: async (config) => ({
    ok: makeStatus(feishuFields, config, []).configured && config.enabled,
    message: makeStatus(feishuFields, config, []).configured
      ? config.values.longConnection === "true"
        ? "飞书配置字段完整；长连接可接收普通消息和卡片按钮事件，不需要公网 webhook。"
        : "飞书回调配置字段完整；Webhook 模式请在飞书后台用回调 URL 完成订阅校验。"
      : "飞书配置未完整，至少需要 App ID、App Secret、Verification Token。"
  })
};

function feishuPayloadSummary(body: unknown): Record<string, unknown> {
  const content = readPath(body, ["event", "message", "content"]) ?? readPath(body, ["message", "content"]);
  const parsedContent = typeof content === "string" ? contentText(content) : contentText(content);
  return {
    schema: readPath(body, ["schema"]),
    type: readPath(body, ["type"]),
    eventType: readPath(body, ["header", "event_type"]) ?? readPath(body, ["event_type"]),
    messageType: readPath(body, ["event", "message", "message_type"]) ?? readPath(body, ["message", "message_type"]),
    hasEncrypt: typeof readPath(body, ["encrypt"]) === "string",
    hasEventMessage: Boolean(readPath(body, ["event", "message"])),
    hasTopMessage: Boolean(readPath(body, ["message"])),
    contentSample: typeof content === "string" ? content.slice(0, 160) : undefined,
    parsedContentSample: parsedContent?.slice(0, 160),
    topKeys: body && typeof body === "object" ? Object.keys(body as Record<string, unknown>).slice(0, 12) : []
  };
}

const wechatFields = [
  field("appId", "WECHAT_APP_ID", "App ID", { placeholder: "公众号/服务号 AppID" }),
  field("appSecret", "WECHAT_APP_SECRET", "App Secret", { secret: true, placeholder: "留空则不修改" }),
  field("token", "WECHAT_TOKEN", "Token", { required: true, secret: true, placeholder: "服务器配置 Token" }),
  field("encodingAesKey", "WECHAT_ENCODING_AES_KEY", "EncodingAESKey", { secret: true, placeholder: "可选，明文模式可留空" })
];

function wechatChallenge(req: Request, config: ConnectorRuntimeConfig): ChallengeResult {
  const signature = String(req.query.signature ?? "");
  const timestamp = String(req.query.timestamp ?? "");
  const nonce = String(req.query.nonce ?? "");
  const echostr = String(req.query.echostr ?? "");
  if (!echostr) return okChallenge;
  if (!config.values.token) throw new Error("微信 Token 未配置，无法完成服务器校验");
  const expected = sha1Hex([config.values.token, timestamp, nonce]);
  if (!signature || !timingSafeEqualText(expected, signature)) throw new Error("微信 Token 签名校验失败");
  return { handled: true, status: 200, body: echostr, contentType: "text/plain" };
}

const wechatAdapter: ConnectorAdapter = {
  source: "wechat",
  adapter: "wechat-official",
  label: "微信公众号/服务号",
  endpoint: "/connectors/wechat/message",
  description: "微信公众号/服务号服务器配置入口：支持 GET 校验、Token 签名和 XML 文本消息。",
  mode: "protocol",
  getConfigSchema: () => wechatFields,
  getSetupStatus: (config) =>
    makeStatus(wechatFields, config, ["服务器配置 GET 校验", "Token 签名校验", "XML 文本消息解析"], [
      publicUrlNote(config, "微信公众号/服务号"),
      config.values.encodingAesKey ? "已配置 EncodingAESKey；加密 XML 解密会在后续版本补上。" : "当前按明文模式处理；如公众号后台启用安全模式，需要后续补 AES 解密。"
    ]),
  handleChallenge: async (req, config) => wechatChallenge(req, config),
  verifyRequest: async (req, config) => {
    requireEnabled(config, "微信公众号");
    if (!config.values.token) throw new Error("微信 Token 未配置");
    const signature = String(req.query.signature ?? "");
    const timestamp = String(req.query.timestamp ?? "");
    const nonce = String(req.query.nonce ?? "");
    if (signature) {
      const expected = sha1Hex([config.values.token, timestamp, nonce]);
      if (!timingSafeEqualText(expected, signature)) throw new Error("微信 Token 签名校验失败");
    }
  },
  normalizeMessage: async (req) => simpleTextMessage("wechat", requestBody(req)),
  sendReply: async () => unsupportedReply("微信公众号/服务号"),
  sendTestMessage: async (config) => {
    if (!config.enabled) return { ok: false, message: "微信公众号/服务号入口已停用。" };
    if (!config.values.token) return { ok: false, message: "微信 Token 未配置，无法完成服务器配置 GET 校验。" };
    if (!isPublicHttps(config)) return { ok: false, message: `微信 Token 已配置，但真实平台无法访问当前回调地址。${publicUrlNote(config, "微信公众号/服务号")}` };
    return { ok: true, message: "微信 Token 与 HTTPS 回调地址已具备；请在公众号后台发起服务器配置校验。" };
  }
};

const wecomFields = [
  field("corpId", "WECOM_CORP_ID", "Corp ID", { required: true, placeholder: "ww_xxx" }),
  field("agentId", "WECOM_AGENT_ID", "Agent ID", { required: true, placeholder: "应用 AgentId" }),
  field("secret", "WECOM_SECRET", "Secret", { required: true, secret: true, placeholder: "留空则不修改" }),
  field("token", "WECOM_TOKEN", "Token", { required: true, secret: true, placeholder: "回调 Token" }),
  field("encodingAesKey", "WECOM_ENCODING_AES_KEY", "EncodingAESKey", { secret: true, placeholder: "可选" })
];

const wecomAdapter: ConnectorAdapter = {
  source: "wecom",
  adapter: "wecom-app",
  label: "企业微信",
  endpoint: "/connectors/wecom/message",
  description: "企业微信应用回调入口：支持 URL verification、Token 校验和文本消息归一化。",
  mode: "protocol",
  getConfigSchema: () => wecomFields,
  getSetupStatus: (config) =>
    makeStatus(wecomFields, config, ["URL verification", "Token 签名校验", "应用消息解析", "应用凭证状态检查"], [
      publicUrlNote(config, "企业微信"),
      config.values.encodingAesKey ? "已配置 EncodingAESKey。" : "企业微信官方回调常用加密模式；未配置 EncodingAESKey 时只适合明文/桥接测试。"
    ]),
  handleChallenge: async (req, config) => {
    const echostr = String(req.query.echostr ?? "");
    if (!echostr) return okChallenge;
    if (!config.values.token) throw new Error("企业微信 Token 未配置");
    const msgSignature = String(req.query.msg_signature ?? req.query.signature ?? "");
    const timestamp = String(req.query.timestamp ?? "");
    const nonce = String(req.query.nonce ?? "");
    if (msgSignature) {
      const expected = sha1Hex([config.values.token, timestamp, nonce, echostr]);
      if (!timingSafeEqualText(expected, msgSignature)) throw new Error("企业微信 URL verification 签名校验失败");
    }
    return { handled: true, status: 200, body: echostr, contentType: "text/plain" };
  },
  verifyRequest: async (_req, config) => {
    requireEnabled(config, "企业微信");
  },
  normalizeMessage: async (req) => simpleTextMessage("wecom", requestBody(req)),
  sendReply: async () => unsupportedReply("企业微信"),
  sendTestMessage: async (config) => {
    const setup = makeStatus(wecomFields, config, []);
    if (!config.enabled) return { ok: false, message: "企业微信入口已停用。" };
    if (!setup.configured) return { ok: false, message: `企业微信配置不完整，缺少：${setup.missing.join("、")}。` };
    if (!isPublicHttps(config)) return { ok: false, message: `企业微信应用凭证已配置，但真实平台无法访问当前回调地址。${publicUrlNote(config, "企业微信")}` };
    return { ok: true, message: "企业微信应用凭证和 HTTPS 回调地址已具备；请在企业微信后台完成 URL verification。" };
  }
};

const dingtalkFields = [
  field("appKey", "DINGTALK_APP_KEY", "App Key", { placeholder: "dingxxx" }),
  field("appSecret", "DINGTALK_APP_SECRET", "App Secret", { secret: true, placeholder: "留空则不修改" }),
  field("signSecret", "DINGTALK_SIGN_SECRET", "机器人签名密钥", { required: true, secret: true, placeholder: "钉钉机器人安全设置里的加签密钥" })
];

const dingtalkAdapter: ConnectorAdapter = {
  source: "dingtalk",
  adapter: "dingtalk-robot",
  label: "钉钉",
  endpoint: "/connectors/dingtalk/message",
  description: "钉钉机器人/事件回调入口：支持机器人签名校验和文本消息解析。",
  mode: "protocol",
  getConfigSchema: () => dingtalkFields,
  getSetupStatus: (config) => makeStatus(dingtalkFields, config, ["机器人签名校验", "文本消息解析"], [publicUrlNote(config, "钉钉")]),
  handleChallenge: async () => okChallenge,
  verifyRequest: async (req, config) => {
    requireEnabled(config, "钉钉");
    const secret = config.values.signSecret;
    if (!secret) return;
    const timestamp = String(req.query.timestamp ?? req.header("timestamp") ?? "");
    const sign = decodeURIComponent(String(req.query.sign ?? req.header("sign") ?? ""));
    if (!timestamp || !sign) throw new Error("钉钉签名参数缺失");
    const expected = crypto.createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
    if (!timingSafeEqualText(expected, sign)) throw new Error("钉钉机器人签名校验失败");
  },
  normalizeMessage: async (req) => {
    const body = requestBody(req);
    const text = firstNonEmpty([readPath(body, ["text", "content"]), readPath(body, ["content"]), readPath(body, ["text"])]);
    if (!text) throw new Error("钉钉消息中没有文本内容");
    return {
      text,
      source: "dingtalk",
      senderId: firstNonEmpty([readPath(body, ["senderStaffId"]), readPath(body, ["senderId"]), readPath(body, ["conversationId"])]) ?? "dingtalk-unknown",
      messageId: firstNonEmpty([readPath(body, ["msgId"]), readPath(body, ["createAt"])]) ?? `dingtalk-${Date.now()}`,
      chatId: firstNonEmpty([readPath(body, ["conversationId"])]),
      autoWrite: false,
      raw: body && typeof body === "object" ? (body as Record<string, unknown>) : { value: body }
    };
  },
  sendReply: async () => unsupportedReply("钉钉"),
  sendTestMessage: async (config) => {
    if (!config.enabled) return { ok: false, message: "钉钉入口已停用。" };
    if (!config.values.signSecret) return { ok: false, message: "钉钉机器人签名密钥未配置，无法校验真实平台请求。" };
    if (!isPublicHttps(config)) return { ok: false, message: `钉钉签名密钥已配置，但真实平台无法访问当前回调地址。${publicUrlNote(config, "钉钉")}` };
    return { ok: true, message: "钉钉签名密钥和 HTTPS 回调地址已具备；请在钉钉后台配置回调 URL。" };
  }
};

const telegramFields = [
  field("botToken", "TELEGRAM_BOT_TOKEN", "Bot Token", { required: true, secret: true, placeholder: "123456:ABC..." }),
  field("secretToken", "TELEGRAM_WEBHOOK_SECRET_TOKEN", "Webhook Secret Token", { secret: true, placeholder: "可选，用于 X-Telegram-Bot-Api-Secret-Token" })
];

const telegramAdapter: ConnectorAdapter = {
  source: "telegram",
  adapter: "telegram-bot",
  label: "Telegram",
  endpoint: "/connectors/telegram/message",
  description: "Telegram Bot webhook：支持 secret token 校验、消息解析和 setWebhook 测试。",
  mode: "protocol",
  getConfigSchema: () => telegramFields,
  getSetupStatus: (config) => makeStatus(telegramFields, config, ["Bot Token getMe 校验", "Webhook Secret Token 校验", "文本消息解析", "setWebhook 测试", "sendMessage 主动回复"], [publicUrlNote(config, "Telegram")]),
  handleChallenge: async () => okChallenge,
  verifyRequest: async (req, config) => {
    requireEnabled(config, "Telegram");
    const secret = config.values.secretToken;
    if (secret && req.header("x-telegram-bot-api-secret-token") !== secret) throw new Error("Telegram webhook secret token 校验失败");
  },
  normalizeMessage: async (req) => {
    const body = requestBody(req);
    const text = firstNonEmpty([readPath(body, ["message", "text"]), readPath(body, ["edited_message", "text"])]);
    if (!text) throw new Error("Telegram 更新中没有文本消息");
    return {
      text,
      source: "telegram",
      senderId: String(firstNonEmpty([String(readPath(body, ["message", "chat", "id"]) ?? ""), String(readPath(body, ["message", "from", "id"]) ?? "")]) ?? "telegram-unknown"),
      messageId: String(firstNonEmpty([String(readPath(body, ["message", "message_id"]) ?? ""), String(readPath(body, ["update_id"]) ?? "")]) ?? `telegram-${Date.now()}`),
      chatId: String(firstNonEmpty([String(readPath(body, ["message", "chat", "id"]) ?? "")]) ?? ""),
      autoWrite: false,
      raw: body && typeof body === "object" ? (body as Record<string, unknown>) : { value: body }
    };
  },
  sendReply: async (target, reply, config) => {
    if (!config.values.botToken) return { ok: false, message: "Telegram Bot Token 未配置，无法主动回复。" };
    const chatId = target.chatId || target.senderId;
    if (!chatId) return { ok: false, message: "Telegram 回复缺少 chat_id。" };
    const response = await fetch(`https://api.telegram.org/bot${config.values.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: reply.text.slice(0, 4096) })
    });
    const json = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    return { ok: Boolean(json.ok), message: json.ok ? "Telegram 回复已发送。" : json.description || "Telegram 回复失败。" };
  },
  sendTestMessage: async (config) => {
    if (!config.values.botToken) return { ok: false, message: "Telegram Bot Token 未配置。" };
    const url = `${config.publicBaseUrl}${telegramAdapter.endpoint}`;
    const meResponse = await fetch(`https://api.telegram.org/bot${config.values.botToken}/getMe`);
    const me = (await meResponse.json().catch(() => ({}))) as { ok?: boolean; result?: { username?: string }; description?: string };
    if (!me.ok) return { ok: false, message: `Telegram Bot Token 校验失败：${me.description || meResponse.status}` };
    if (!isPublicHttps(config)) return { ok: false, message: `Telegram Bot Token 有效（${me.result?.username ?? "bot"}），但 setWebhook 需要 HTTPS 公网地址；当前只能做本地消息模拟。` };
    const response = await fetch(`https://api.telegram.org/bot${config.values.botToken}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, secret_token: config.values.secretToken || undefined })
    });
    const json = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    return { ok: Boolean(json.ok), message: json.ok ? "Telegram webhook 已设置。" : json.description || "Telegram setWebhook 失败。" };
  }
};

const webAdapter: ConnectorAdapter = {
  source: "web",
  adapter: "local-web-chat",
  label: "网页聊天",
  endpoint: "/connectors/web/message",
  description: "本机网页聊天模拟入口，直接进入 LangGraph 智能体。",
  mode: "generic",
  getConfigSchema: () => [],
  getSetupStatus: (config) => makeStatus([], config, ["本机聊天模拟", "自动写入/预览切换"], []),
  handleChallenge: async () => okChallenge,
  verifyRequest: async (req, config) => {
    requireEnabled(config, "网页聊天");
  },
  normalizeMessage: async (req) => simpleTextMessage("web", requestBody(req)),
  sendReply: async () => unsupportedReply("网页聊天"),
  sendTestMessage: async (config) => ({ ok: config.enabled, message: config.enabled ? "网页聊天入口可用。" : "网页聊天入口已停用。" })
};

const apiAdapter: ConnectorAdapter = {
  source: "api",
  adapter: "generic-webhook",
  label: "通用 Webhook",
  endpoint: "/connectors/api/message",
  description: "给脚本、自动化工具或未适配平台使用的通用 JSON webhook。",
  mode: "generic",
  getConfigSchema: genericFields,
  getSetupStatus: (config) => makeStatus(genericFields(), config, ["Bearer Token / Header Token 校验", "通用文本消息归一化"], ["Token 可选；配置后请求需携带 Authorization: Bearer 或 x-obsidianlink-token。"]),
  handleChallenge: async () => okChallenge,
  verifyRequest: async (req, config) => {
    requireEnabled(config, "通用 Webhook");
    const token = config.values.apiToken;
    if (token && bearerOrHeaderToken(req) !== token) throw new Error("通用 Webhook Token 校验失败");
  },
  normalizeMessage: async (req) => simpleTextMessage("api", requestBody(req)),
  sendReply: async () => unsupportedReply("通用 Webhook"),
  sendTestMessage: async (config) => ({ ok: config.enabled, message: config.enabled ? "通用 Webhook 本机入口可用。" : "通用 Webhook 已停用。" })
};

export const connectorAdapters: ConnectorAdapter[] = [
  feishuAdapter,
  wechatAdapter,
  wecomAdapter,
  dingtalkAdapter,
  telegramAdapter,
  webAdapter,
  apiAdapter
];

export function getConnectorAdapter(source: SourceKind): ConnectorAdapter {
  const adapter = connectorAdapters.find((item) => item.source === source);
  if (!adapter) throw new Error(`Unknown connector: ${source}`);
  return adapter;
}

export function connectorConfig(adapter: ConnectorAdapter, publicBaseUrl: string): ConnectorRuntimeConfig {
  const enabledValue = process.env[`${adapter.adapter.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ENABLED`];
  const legacyEnabled = process.env[`CONNECTOR_${adapter.source.toUpperCase()}_ENABLED`];
  const enabled = (enabledValue ?? legacyEnabled) !== "false";
  return {
    enabled,
    publicBaseUrl,
    values: Object.fromEntries(
      adapter.getConfigSchema().map((schema) => [
        schema.key,
        process.env[schema.envKey] ?? process.env[`CONNECTOR_${adapter.source.toUpperCase()}_${schema.key.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`] ?? ""
      ])
    )
  };
}

export function connectorEnabledEnvKey(adapter: ConnectorAdapter): string {
  return `${adapter.adapter.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ENABLED`;
}

export function normalizeWithAdapter(source: SourceKind, payload: unknown) {
  const adapter = getConnectorAdapter(source);
  return simpleTextMessage(adapter.source, payload);
}
