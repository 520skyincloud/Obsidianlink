import crypto from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConnectorAdapter } from "../src/connectors/adapters/index.js";
import { ConnectorRuntimeConfig } from "../src/connectors/adapters/types.js";
import { normalizeFeishuLongConnectionEvent } from "../src/connectors/feishuLongConnection.js";
import { normalizeQQSdkEvent } from "../src/connectors/qqBotSdk.js";
import { normalizeConnectorMessage } from "../src/connectors.js";
import { createApp } from "../src/server.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function req(body: unknown, query: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return {
    body,
    query,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
    is(type: string) {
      return type.includes("xml") && typeof body === "string" && body.trim().startsWith("<");
    }
  } as never;
}

function config(values: Record<string, string> = {}, enabled = true): ConnectorRuntimeConfig {
  return { enabled, publicBaseUrl: "http://127.0.0.1:38721", values };
}

function sha1(values: string[]) {
  return crypto.createHash("sha1").update(values.sort().join("")).digest("hex");
}

function encryptFeishuPayload(payload: unknown, encryptKey: string) {
  const iv = Buffer.from("1234567890abcdef");
  const key = crypto.createHash("sha256").update(encryptKey, "utf8").digest();
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]).toString("base64");
}

describe("connector adapters", () => {
  it("normalizes QQ Bot SDK websocket events", () => {
    expect(
      normalizeQQSdkEvent({
        eventType: "MESSAGE_CREATE",
        eventId: "evt-qq",
        msg: {
          id: "msg-qq",
          content: "<@!123456> 保存这个抖音链接 https://v.douyin.com/demo",
          author: { id: "qq-user" }
        }
      })
    ).toMatchObject({
      text: "保存这个抖音链接 https://v.douyin.com/demo",
      source: "qq",
      senderId: "qq-user",
      messageId: "msg-qq",
      autoWrite: false
    });
  });

  it("reports QQ Bot SDK required config fields", () => {
    const adapter = getConnectorAdapter("qq");
    const status = adapter.getSetupStatus(config({ appId: "app" }));
    expect(adapter.adapter).toBe("qq-bot-sdk");
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual(["token"]);
  });

  it("handles Feishu URL verification challenge", async () => {
    const adapter = getConnectorAdapter("feishu");
    const result = await adapter.handleChallenge(
      req({ type: "url_verification", token: "vt", challenge: "ok-challenge" }),
      config({ verificationToken: "vt" })
    );
    expect(result).toMatchObject({ handled: true, body: { challenge: "ok-challenge" } });
  });

  it("decrypts Feishu encrypted URL verification challenge", async () => {
    const adapter = getConnectorAdapter("feishu");
    const encrypted = encryptFeishuPayload(
      { type: "url_verification", token: "vt", challenge: "encrypted-ok" },
      "encrypt-key"
    );
    const result = await adapter.handleChallenge(req({ encrypt: encrypted }), config({ verificationToken: "vt", encryptKey: "encrypt-key" }));
    expect(result).toMatchObject({ handled: true, body: { challenge: "encrypted-ok" } });
  });

  it("normalizes Feishu event payloads", async () => {
    const adapter = getConnectorAdapter("feishu");
    const message = await adapter.normalizeMessage(
      req({
        header: { event_id: "evt_1" },
        event: {
          sender: { sender_id: { open_id: "ou_123" } },
          message: {
            message_id: "om_456",
            content: JSON.stringify({ text: "飞书发来的抖音链接 https://v.douyin.com/test" })
          }
        }
      }),
      config()
    );
    expect(message).toMatchObject({
      text: "飞书发来的抖音链接 https://v.douyin.com/test",
      source: "feishu",
      senderId: "ou_123",
      messageId: "om_456",
      autoWrite: false
    });
  });

  it("normalizes Feishu long connection events", () => {
    expect(
      normalizeFeishuLongConnectionEvent({
        sender: { sender_id: { open_id: "ou_long" } },
        message: {
          message_id: "om_long",
          chat_id: "oc_chat",
          content: JSON.stringify({ text: "长连接收到一条抖音链接" })
        }
      })
    ).toMatchObject({
      text: "长连接收到一条抖音链接",
      source: "feishu",
      senderId: "ou_long",
      messageId: "om_long",
      autoWrite: false
    });
  });

  it("handles WeChat GET signature verification", async () => {
    const adapter = getConnectorAdapter("wechat");
    const signature = sha1(["wx-token", "123", "abc"]);
    const result = await adapter.handleChallenge(
      req(undefined, { signature, timestamp: "123", nonce: "abc", echostr: "echo-ok" }),
      config({ token: "wx-token" })
    );
    expect(result).toMatchObject({ handled: true, body: "echo-ok", contentType: "text/plain" });
  });

  it("normalizes WeChat XML text messages", async () => {
    const adapter = getConnectorAdapter("wechat");
    const message = await adapter.normalizeMessage(
      req("<xml><FromUserName><![CDATA[wx-user]]></FromUserName><MsgId>42</MsgId><Content><![CDATA[微信里随手记一个产品想法]]></Content></xml>"),
      config({ token: "wx-token" })
    );
    expect(message).toMatchObject({
      text: "微信里随手记一个产品想法",
      source: "wechat",
      senderId: "wx-user",
      messageId: "42"
    });
  });

  it("verifies Telegram webhook secret token and normalizes messages", async () => {
    const adapter = getConnectorAdapter("telegram");
    await adapter.verifyRequest(req({}, {}, { "x-telegram-bot-api-secret-token": "secret" }), config({ secretToken: "secret", botToken: "token" }));
    const message = await adapter.normalizeMessage(
      req({ update_id: 7, message: { message_id: 8, chat: { id: 9 }, text: "GitHub langgraph 项目" } }),
      config({ secretToken: "secret", botToken: "token" })
    );
    expect(message).toMatchObject({ text: "GitHub langgraph 项目", source: "telegram", senderId: "9", messageId: "8" });
  });

  it("reports missing required setup fields", () => {
    const adapter = getConnectorAdapter("feishu");
    const status = adapter.getSetupStatus(config({ verificationToken: "vt" }));
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual(["appId", "appSecret"]);
  });

  it("does not mark Dingtalk complete without a signing secret", () => {
    const adapter = getConnectorAdapter("dingtalk");
    const status = adapter.getSetupStatus(config());
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual(["signSecret"]);
  });

  it("requires full WeCom app credentials for setup", () => {
    const adapter = getConnectorAdapter("wecom");
    const status = adapter.getSetupStatus(config({ token: "token" }));
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual(["corpId", "agentId", "secret"]);
  });

  it("reports local webhook URLs as not ready for real platform callbacks", async () => {
    await expect(getConnectorAdapter("wechat").sendTestMessage(config({ token: "wx-token" }))).resolves.toMatchObject({
      ok: false
    });
    await expect(getConnectorAdapter("dingtalk").sendTestMessage(config({ signSecret: "ding-secret" }))).resolves.toMatchObject({
      ok: false
    });
  });

  it("exposes a unified sendReply interface on every adapter", () => {
    for (const source of ["qq", "feishu", "wechat", "wecom", "dingtalk", "telegram", "web", "api"] as const) {
      expect(typeof getConnectorAdapter(source).sendReply).toBe("function");
    }
  });

  it("keeps the legacy normalizer path for simple payloads", () => {
    expect(normalizeConnectorMessage("api", { text: "hello", senderId: "me", messageId: "1", autoWrite: false })).toMatchObject({
      text: "hello",
      source: "api",
      senderId: "me",
      messageId: "1",
      autoWrite: false
    });
  });
});

describe("connector HTTP integration", () => {
  it("returns Feishu challenge through /connectors/feishu/message", async () => {
    process.env.FEISHU_VERIFICATION_TOKEN = "vt";
    const { baseUrl, close } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/connectors/feishu/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "url_verification", token: "vt", challenge: "challenge-ok" })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ challenge: "challenge-ok" });
    } finally {
      await close();
    }
  });

  it("returns Feishu card callback challenge through /connectors/feishu/card", async () => {
    process.env.FEISHU_VERIFICATION_TOKEN = "vt";
    const { baseUrl, close } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/connectors/feishu/card`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "url_verification", token: "vt", challenge: "card-challenge-ok" })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ challenge: "card-challenge-ok" });
    } finally {
      await close();
    }
  });

  it("handles Feishu card callback actions without chat id", async () => {
    process.env.FEISHU_VERIFICATION_TOKEN = "vt";
    const { baseUrl, close } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/connectors/feishu/card`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "vt",
          action: { value: { obsidianlink: true, decision: "ideate", previewId: "pv_missing" } }
        })
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(JSON.stringify(body)).toContain("没有找到预览");
    } finally {
      await close();
    }
  });

  it("routes Feishu card actions that arrive at the message endpoint", async () => {
    process.env.FEISHU_VERIFICATION_TOKEN = "vt";
    const { baseUrl, close } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/connectors/feishu/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "vt",
          header: { event_type: "card.action.trigger" },
          action: { value: { obsidianlink: true, decision: "ideate", previewId: "pv_missing" } }
        })
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(JSON.stringify(body)).toContain("没有找到预览");
    } finally {
      await close();
    }
  });

  it("ignores Feishu non-text callbacks at the message endpoint", async () => {
    process.env.FEISHU_VERIFICATION_TOKEN = "vt";
    const { baseUrl, close } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/connectors/feishu/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "vt",
          header: { event_type: "im.message.message_read_v1" },
          event: { message: { message_type: "unknown" } }
        })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, action: "ignored" });
    } finally {
      await close();
    }
  });

  it("ignores stale Feishu text events instead of replying or writing later", async () => {
    process.env.FEISHU_VERIFICATION_TOKEN = "vt";
    process.env.FEISHU_STALE_EVENT_MAX_AGE_MS = "1000";
    const enqueueAgentMessage = vi.fn();
    const { baseUrl, close } = await startTestServer({ enqueueAgentMessage });
    try {
      const response = await fetch(`${baseUrl}/connectors/feishu/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "vt",
          header: { event_id: `evt_stale_${Date.now()}`, event_type: "im.message.receive_v1" },
          event: {
            sender: { sender_id: { open_id: "ou_stale" } },
            message: {
              message_id: `om_stale_${Date.now()}`,
              chat_id: "oc_stale",
              message_type: "text",
              create_time: String(Math.floor((Date.now() - 60_000) / 1000)),
              content: JSON.stringify({ text: "很久以前的灵感，记录一下" })
            }
          }
        })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, action: "ignored", warnings: ["stale_feishu_event"] });
      expect(enqueueAgentMessage).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("does not ignore encrypted Feishu payloads before adapter decryption", async () => {
    process.env.FEISHU_VERIFICATION_TOKEN = "vt";
    process.env.FEISHU_ENCRYPT_KEY = "";
    const { baseUrl, close } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/connectors/feishu/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ encrypt: "encrypted-payload-placeholder" })
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "飞书推送了加密事件，但 FEISHU_ENCRYPT_KEY 未配置" });
    } finally {
      await close();
    }
  });

  it("returns WeChat echostr through GET verification", async () => {
    process.env.WECHAT_TOKEN = "wx-token";
    const signature = sha1(["wx-token", "123", "abc"]);
    const { baseUrl, close } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/connectors/wechat/message?signature=${signature}&timestamp=123&nonce=abc&echostr=echo-ok`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("echo-ok");
    } finally {
      await close();
    }
  });

  it("runs /connectors/api/test as preview_only without leaking secrets", async () => {
    const handleAgentMessage = vi.fn(async () => ({
      ok: true,
      action: "preview_only" as const,
      reply: "预览已生成",
      writtenFiles: [],
      warnings: []
    }));
    const { baseUrl, close } = await startTestServer({ handleAgentMessage });
    try {
      const response = await fetch(`${baseUrl}/connectors/api/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "测试消息", senderId: "tester" })
      });
      const json = (await response.json()) as { response: { action: string }; connector: { configuredFields: Record<string, boolean> } };
      expect(response.status).toBe(200);
      expect(json.response.action).toBe("preview_only");
      expect(handleAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ autoWrite: false, source: "api" }));
      expect(JSON.stringify(json)).not.toContain("GENERIC_WEBHOOK_TOKEN=");
    } finally {
      await close();
    }
  });

  it("queues connector messages instead of synchronously running the agent", async () => {
    const enqueueAgentMessage = vi.fn(async () => ({
      ok: true,
      action: "queued" as const,
      jobId: "job_queued",
      reply: "已收到，已进入后台队列。",
      writtenFiles: [],
      warnings: []
    }));
    const handleAgentMessage = vi.fn();
    const { baseUrl, close } = await startTestServer({ enqueueAgentMessage, handleAgentMessage });
    try {
      const response = await fetch(`${baseUrl}/connectors/api/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "异步队列测试", senderId: "tester", messageId: "queued-1" })
      });
      const json = (await response.json()) as { action: string; jobId: string };
      expect(response.status).toBe(200);
      expect(json.action).toBe("queued");
      expect(json.jobId).toBe("job_queued");
      expect(enqueueAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "异步队列测试", source: "api" }), expect.any(Function));
      expect(handleAgentMessage).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("exposes connector controls so unsupported buttons can be disabled", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/connectors`);
      const json = (await response.json()) as { connectors: Array<{ source: string; controls: { start: boolean; stop: boolean; asyncReply: boolean }; publicUrl: { usableByExternalPlatforms: boolean } }> };
      const feishu = json.connectors.find((connector) => connector.source === "feishu");
      const wechat = json.connectors.find((connector) => connector.source === "wechat");
      expect(feishu?.controls.start).toBe(true);
      expect(feishu?.controls.asyncReply).toBe(true);
      expect(wechat?.controls.start).toBe(false);
      expect(wechat?.controls.asyncReply).toBe(false);
      expect(wechat?.publicUrl.usableByExternalPlatforms).toBe(false);
    } finally {
      await close();
    }
  });
});

async function startTestServer(service: Record<string, unknown> = {}) {
  const app = createApp(
    {
      handleAgentMessage: async () => ({
        ok: true,
        action: "preview_only" as const,
        reply: "预览已生成",
        writtenFiles: [],
        warnings: []
      }),
      activity: () => [],
      recentPreviews: () => [],
      ...service
    } as never,
    { exists: async () => true } as never
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server failed to bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}
