import { IngestService } from "../ingestService.js";
import { AgentMessageRequest } from "../types.js";

interface QQBotSdkStatus {
  enabled: boolean;
  running: boolean;
  lastEventAt?: string;
  lastReplyAt?: string;
  lastError?: string;
  note: string;
}

const status: QQBotSdkStatus = {
  enabled: false,
  running: false,
  note: "QQ Bot SDK 未设置自动启动。"
};

let client: QQWebsocketClient | undefined;

interface QQWebsocketClient {
  on: (event: string, handler: (data: unknown) => void) => void;
  disconnect?: () => void;
}

export function getQQBotSdkRuntimeStatus(): QQBotSdkStatus {
  return { ...status };
}

export function stopQQBotSdkAgent(): QQBotSdkStatus {
  client?.disconnect?.();
  client = undefined;
  status.running = false;
  status.note = status.enabled ? "QQ Bot SDK session 已手动停止。" : "QQ Bot SDK 未设置自动启动。";
  return getQQBotSdkRuntimeStatus();
}

export async function startQQBotSdkAgent(service: IngestService): Promise<void> {
  const autoStart = process.env.QQ_BOT_SDK_AUTOSTART === "true";
  status.enabled = autoStart;
  if (!autoStart) {
    status.note = "QQ_BOT_SDK_AUTOSTART 未开启；QQ 可通过开放平台 Bot SDK 外部进程转发到 HTTP 入口，或开启本机 SDK session。";
    return;
  }
  const appID = process.env.QQ_BOT_APP_ID;
  const token = process.env.QQ_BOT_TOKEN;
  if (!appID || !token) {
    status.lastError = "QQ_BOT_APP_ID 或 QQ_BOT_TOKEN 未配置";
    status.note = "QQ Bot SDK 自动启动失败：缺少 AppID/Token。";
    return;
  }
  if (client) {
    status.running = true;
    status.note = "QQ Bot SDK session 已经在运行。";
    return;
  }

  try {
    const sdk = (await import("qq-guild-bot")) as unknown as {
      createWebsocket: (config: {
        appID: string;
        token: string;
        sandbox?: boolean;
        intents?: string[];
      }) => QQWebsocketClient;
      AvailableIntentsEventsEnum?: Record<string, string>;
      SessionEvents?: Record<string, string>;
    };
    const intents = [
      sdk.AvailableIntentsEventsEnum?.GUILD_MESSAGES ?? "GUILD_MESSAGES",
      sdk.AvailableIntentsEventsEnum?.DIRECT_MESSAGE ?? "DIRECT_MESSAGE",
      sdk.AvailableIntentsEventsEnum?.PUBLIC_GUILD_MESSAGES ?? "PUBLIC_GUILD_MESSAGES"
    ];
    client = sdk.createWebsocket({
      appID,
      token,
      sandbox: process.env.QQ_BOT_SANDBOX === "true",
      intents
    });
    const handle = async (event: unknown) => {
      try {
        const message = normalizeQQSdkEvent(event);
        status.lastEventAt = new Date().toISOString();
        status.lastError = undefined;
        const response = await service.enqueueAgentMessage(message, async (completed) => {
          await sendQQReply(event, completed.reply);
          status.lastReplyAt = new Date().toISOString();
        });
        await sendQQReply(event, response.reply);
        status.lastReplyAt = new Date().toISOString();
      } catch (error) {
        status.lastError = error instanceof Error ? error.message : String(error);
      }
    };
    client.on("GUILD_MESSAGES", handle);
    client.on("DIRECT_MESSAGE", handle);
    client.on("PUBLIC_GUILD_MESSAGES", handle);
    client.on(sdk.SessionEvents?.READY ?? "READY", () => {
      status.running = true;
      status.note = "QQ Bot SDK websocket session 已连接。";
    });
    client.on(sdk.SessionEvents?.ERROR ?? "ERROR", (event: unknown) => {
      status.lastError = JSON.stringify(event);
      status.note = "QQ Bot SDK session 报错。";
    });
    client.on(sdk.SessionEvents?.DEAD ?? "DEAD", (event: unknown) => {
      status.running = false;
      status.lastError = JSON.stringify(event);
      status.note = "QQ Bot SDK session 已死亡，需要检查网络、Token 或权限。";
    });
    status.running = true;
    status.note = "QQ Bot SDK session 正在连接。";
  } catch (error) {
    status.running = false;
    status.lastError = error instanceof Error ? error.message : String(error);
    status.note = "QQ Bot SDK 自动启动失败。";
  }
}

export function normalizeQQSdkEvent(event: unknown): AgentMessageRequest {
  const payload = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
  const msg = readObject(payload, ["msg"]) ?? readObject(payload, ["d"]) ?? payload;
  const content = cleanQQContent(firstText([readPath(msg, ["content"]), readPath(msg, ["message", "content"]), readPath(payload, ["content"])]));
  if (!content) throw new Error("QQ Bot SDK 事件中没有文本 content");
  return {
    text: content,
    source: "qq",
    senderId:
      firstText([
        readPath(msg, ["author", "id"]),
        readPath(msg, ["member", "user", "id"]),
        readPath(msg, ["src_guild_id"]),
        readPath(msg, ["guild_id"]),
        readPath(payload, ["senderId"])
      ]) ?? "qq-unknown",
    messageId:
      firstText([
        readPath(msg, ["id"]),
        readPath(msg, ["message_id"]),
        readPath(payload, ["eventId"]),
        readPath(payload, ["id"]),
        readPath(payload, ["messageId"])
      ]) ?? `qq-${Date.now()}`,
    chatId: firstText([readPath(msg, ["channel_id"]), readPath(msg, ["guild_id"]), readPath(payload, ["channelId"])]),
    autoWrite: false,
    raw: payload
  };
}

export async function sendQQReply(event: unknown, text: string): Promise<void> {
  const appID = process.env.QQ_BOT_APP_ID;
  const token = process.env.QQ_BOT_TOKEN;
  if (!appID || !token || !text.trim()) return;
  const payload = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
  const msg = readObject(payload, ["msg"]) ?? readObject(payload, ["d"]) ?? payload;
  const channelID = firstText([readPath(msg, ["channel_id"]), readPath(payload, ["channel_id"])]);
  const guildID = firstText([readPath(msg, ["guild_id"]), readPath(msg, ["src_guild_id"]), readPath(payload, ["guild_id"])]);
  const messageID = firstText([readPath(msg, ["id"]), readPath(msg, ["message_id"]), readPath(payload, ["messageId"])]);
  if (!channelID && !guildID) return;
  const sdk = (await import("qq-guild-bot")) as unknown as {
    createOpenAPI: (config: { appID: string; token: string; sandbox?: boolean }) => {
      messageApi: { postMessage: (channelID: string, message: { content: string; msg_id?: string; message_reference?: { message_id: string } }) => Promise<unknown> };
      directMessageApi: { postDirectMessage: (guildID: string, message: { content: string; msg_id?: string }) => Promise<unknown> };
    };
  };
  const api = sdk.createOpenAPI({
    appID,
    token,
    sandbox: process.env.QQ_BOT_SANDBOX === "true"
  });
  const content = text.slice(0, 1900);
  if (channelID) {
    await api.messageApi.postMessage(channelID, {
      content,
      msg_id: messageID,
      message_reference: messageID ? { message_id: messageID } : undefined
    });
    return;
  }
  await api.directMessageApi.postDirectMessage(guildID!, { content, msg_id: messageID });
}

function readObject(value: Record<string, unknown>, path: string[]): Record<string, unknown> | undefined {
  const result = readPath(value, path);
  return result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function firstText(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const clean = value.trim();
    if (clean) return clean;
  }
  return undefined;
}

function cleanQQContent(value: string | undefined): string | undefined {
  return value?.replace(/<@!?\d+>/g, "").replace(/\s+/g, " ").trim() || undefined;
}
