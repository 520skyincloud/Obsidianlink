import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { config, missingRequiredConfig, resolveVaultPath } from "./config.js";
import { sourceKindSchema } from "./connectors.js";
import {
  connectorAdapters,
  connectorConfig,
  connectorEnabledEnvKey,
  getConnectorAdapter
} from "./connectors/adapters/index.js";
import { ConnectorAdapter, ConnectorRuntimeConfig } from "./connectors/adapters/types.js";
import { handleFeishuCardCallback, sendFeishuProcessingAck, startFeishuLongConnection, stopFeishuLongConnection } from "./connectors/feishuLongConnection.js";
import { databaseStatus } from "./database/db.js";
import { repositories } from "./database/repositories.js";
import { updateEnvFile } from "./envFile.js";
import { IngestService } from "./ingestService.js";
import { classifyMessageIntent, hasIdeaSaveSignal } from "./intentRouter.js";
import { fullVaultDirs } from "./knowledgeTaxonomy.js";
import { DouyinClient } from "./clients/douyin.js";
import { OcrClient } from "./clients/ocr.js";
import { ObsidianVault } from "./obsidian/vault.js";

const previewSchema = z.object({
  text: z.string().min(1),
  source: sourceKindSchema.default("web"),
  senderId: z.string().min(1),
  messageId: z.string().min(1)
});

const agentMessageSchema = z.object({
  text: z.string().min(1),
  source: sourceKindSchema.default("web"),
  senderId: z.string().min(1),
  messageId: z.string().min(1),
  autoWrite: z.boolean().optional().default(true)
});

const confirmSchema = z.object({
  previewId: z.string().min(1),
  decision: z.enum(["confirm", "cancel"]),
  extraText: z.string().optional()
});

const supplementSchema = z.object({
  previewId: z.string().min(1),
  extraText: z.string().trim().min(1)
});

const settingsSchema = z.object({
  obsidianVaultPath: z.string().trim().min(1).optional(),
  openaiBaseUrl: z.string().trim().url().optional(),
  openaiApiKey: z.string().trim().min(10).optional(),
  openaiModel: z.string().trim().min(1).optional(),
  githubToken: z.string().trim().min(20).optional(),
  douyinParseApi: z.string().trim().url().optional(),
  ocrFrameIntervalSeconds: z.coerce.number().positive().optional(),
  ocrMaxFrames: z.coerce.number().int().positive().optional()
});

const connectorSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  publicBaseUrl: z.string().trim().url().optional(),
  fields: z.record(z.string(), z.string().trim()).optional()
});

const connectorTestSchema = z.object({
  text: z.string().trim().min(1).default("连接测试：请生成预览，不要写入 Obsidian。"),
  senderId: z.string().trim().min(1).default("connector-test")
});

interface ConnectorRuntimeState {
  lastRequestAt?: string;
  lastError?: string;
  lastTestAt?: string;
  lastTestResult?: string;
}

const connectorRuntime = new Map<string, ConnectorRuntimeState>();

export function createApp(service = new IngestService(), vault = new ObsidianVault()) {
  const app = express();
  app.use(express.json({ limit: "2mb", type: ["application/json", "application/*+json"] }));
  app.use(express.text({ limit: "2mb", type: ["text/*", "application/xml", "text/xml"] }));
  app.use(express.static(path.resolve(process.cwd(), "src/public"), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }));

  app.get("/chat.html", (_req, res) => {
    res.redirect(302, "/");
  });

  app.get("/health", async (_req, res) => {
    const missing = missingRequiredConfig();
    res.json({
      ok: missing.length === 0,
      service: "obsidianlink",
      database: databaseStatus(),
      vaultPath: config.OBSIDIAN_VAULT_PATH,
      vaultExists: await vault.exists(),
      githubTokenConfigured: Boolean(config.GITHUB_TOKEN),
      openaiConfigured: Boolean(config.OPENAI_API_KEY),
      openaiBaseUrl: config.OPENAI_BASE_URL,
      openaiModel: config.OPENAI_MODEL,
      douyinParseApiConfigured: Boolean(config.DOUYIN_PARSE_API),
      douyinParseApi: config.DOUYIN_PARSE_API,
      missing
    });
  });

  app.get("/api/system/health", async (_req, res) => {
    const tools = {
      ffmpeg: await commandStatus("ffmpeg", ["-version"]),
      tesseract: await commandStatus("tesseract", ["--version"])
    };
    res.json({
      ok: missingRequiredConfig().length === 0 && databaseStatus().ok,
      service: "ObsidianLink",
      version: "0.1.0",
      database: databaseStatus().ok ? "ok" : databaseStatus(),
      vault: {
        path: config.OBSIDIAN_VAULT_PATH,
        exists: await vault.exists(),
        writable: await vaultWritable()
      },
      tools: {
        ffmpeg: tools.ffmpeg.available,
        tesseract: tools.tesseract.available
      },
      model: {
        configured: Boolean(config.OPENAI_API_KEY),
        baseUrl: config.OPENAI_BASE_URL,
        model: config.OPENAI_MODEL
      }
    });
  });

  app.get("/settings", (_req, res) => {
    res.json(settingsView());
  });

  app.get("/api/settings", (_req, res) => res.json(settingsView()));

  app.get("/system/status", async (_req, res) => {
    res.json({
      tools: {
        ffmpeg: await commandStatus("ffmpeg", ["-version"]),
        tesseract: await commandStatus("tesseract", ["--version"])
      },
      vaultDirs: [
        ...fullVaultDirs
      ]
    });
  });

  app.get("/api/system/status", async (_req, res) => {
    res.json({
      database: databaseStatus(),
      tools: {
        ffmpeg: await commandStatus("ffmpeg", ["-version"]),
        tesseract: await commandStatus("tesseract", ["--version"])
      },
      vaultDirs: [...fullVaultDirs]
    });
  });

  app.get("/activity", (req, res) => {
    const limit = Number(req.query.limit ?? 80);
    res.json({ activity: service.activity(Number.isFinite(limit) ? limit : 80) });
  });

  app.get("/previews", (req, res) => {
    const limit = Number(req.query.limit ?? 30);
    res.json({ previews: service.recentPreviews(Number.isFinite(limit) ? limit : 30) });
  });

  app.get("/connectors", (_req, res) => {
    res.json({
      publicBaseUrl: connectorPublicBaseUrl(),
      connectors: connectorAdapters.map((connector) => connectorView(connector))
    });
  });

  app.get("/api/connectors", (_req, res) => {
    res.json({
      publicBaseUrl: connectorPublicBaseUrl(),
      connectors: connectorAdapters.map((connector) => connectorView(connector))
    });
  });

  app.get("/api/connectors/logs", (req, res) => {
    const limit = Number(req.query.limit ?? 80);
    const source = typeof req.query.source === "string" ? req.query.source : undefined;
    res.json({ logs: repositories.listConnectorLogs(Number.isFinite(limit) ? limit : 80, source) });
  });

  app.get("/connectors/:connector/settings", (req, res, next) => {
    try {
      const source = sourceKindSchema.parse(req.params.connector);
      const connector = getConnectorAdapter(source);
      res.json(connectorView(connector));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/connectors/:connector", (req, res, next) => {
    try {
      const source = sourceKindSchema.parse(req.params.connector);
      res.json(connectorView(getConnectorAdapter(source)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/connectors/:connector/settings", async (req, res, next) => {
    try {
      const source = sourceKindSchema.parse(req.params.connector);
      const connector = getConnectorAdapter(source);
      const body = connectorSettingsSchema.parse(req.body);
      const updates: Record<string, string> = {};
      if (typeof body.enabled === "boolean") {
        updates[connectorEnabledEnvKey(connector)] = body.enabled ? "true" : "false";
      }
      if (body.publicBaseUrl) {
        updates.CONNECTOR_PUBLIC_BASE_URL = body.publicBaseUrl.replace(/\/$/, "");
        process.env.CONNECTOR_PUBLIC_BASE_URL = updates.CONNECTOR_PUBLIC_BASE_URL;
      }
      for (const [field, value] of Object.entries(body.fields ?? {})) {
        if (!value) continue;
        const schema = connector.getConfigSchema().find((item) => item.key === field);
        if (!schema) continue;
        updates[schema.envKey] = value;
      }
      if (Object.keys(updates).length) {
        await updateEnvFile(updates);
        for (const [key, value] of Object.entries(updates)) process.env[key] = value;
      }
      if (source === "feishu" && process.env.FEISHU_LONG_CONNECTION_ENABLED === "true") {
        void startFeishuLongConnection(service);
      }
      res.json({ ok: true, connector: connectorView(connector) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/connectors/:connector/config", async (req, res, next) => {
    try {
      const source = sourceKindSchema.parse(req.params.connector);
      const connector = getConnectorAdapter(source);
      const body = connectorSettingsSchema.parse(req.body);
      const updates: Record<string, string> = {};
      if (typeof body.enabled === "boolean") updates[connectorEnabledEnvKey(connector)] = body.enabled ? "true" : "false";
      if (body.publicBaseUrl) updates.CONNECTOR_PUBLIC_BASE_URL = body.publicBaseUrl.replace(/\/$/, "");
      for (const [field, value] of Object.entries(body.fields ?? {})) {
        if (!value) continue;
        const schema = connector.getConfigSchema().find((item) => item.key === field);
        if (schema) updates[schema.envKey] = value;
      }
      if (Object.keys(updates).length) {
        await updateEnvFile(updates);
        for (const [key, value] of Object.entries(updates)) process.env[key] = value;
      }
      res.json({ ok: true, connector: connectorView(connector) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/connectors/:connector/test", async (req, res, next) => {
    try {
      const source = sourceKindSchema.parse(req.params.connector);
      const connector = getConnectorAdapter(source);
      const body = connectorTestSchema.parse(req.body);
      const runtimeConfig = connectorConfig(connector, connectorPublicBaseUrl());
      const platform = await connector.sendTestMessage(runtimeConfig);
      const response = await service.handleAgentMessage({
        text: body.text,
        source,
        senderId: body.senderId,
        messageId: `${source}-test-${Date.now()}`,
        autoWrite: false
      });
      markConnectorTest(connector.source, `${platform.message} / 智能体测试：${response.action}`);
      res.json({ ok: platform.ok && response.ok, connector: connectorView(connector), platform, response });
    } catch (error) {
      if (String(req.params.connector) === "feishu" && messageOf(error).includes("没有文本消息内容")) {
        repositories.addConnectorLog({
          source: "feishu",
          eventType: "ignored_callback",
          status: "success",
          message: "忽略飞书非文本消息；已返回 ok，避免平台重试",
          metadata: summarizeCallbackPayload(req.body)
        });
        res.json({ ok: true, action: "ignored", reason: "non_text_message" });
        return;
      }
      markConnectorError(String(req.params.connector), error);
      next(error);
    }
  });

  app.post("/api/connectors/:connector/test", async (req, res, next) => {
    try {
      const source = sourceKindSchema.parse(req.params.connector);
      const connector = getConnectorAdapter(source);
      const body = connectorTestSchema.parse(req.body);
      const runtimeConfig = connectorConfig(connector, connectorPublicBaseUrl());
      const platform = await connector.sendTestMessage(runtimeConfig);
      const response = await service.handleAgentMessage({
        text: body.text,
        source,
        senderId: body.senderId,
        messageId: `${source}-test-${Date.now()}`,
        autoWrite: false
      });
      markConnectorTest(connector.source, `${platform.message} / 智能体测试：${response.action}`);
      res.json({ ok: platform.ok && response.ok, connector: connectorView(connector), platform, response });
    } catch (error) {
      if (String(req.params.connector) === "feishu" && messageOf(error).includes("没有文本消息内容")) {
        repositories.addConnectorLog({
          source: "feishu",
          eventType: "ignored_callback",
          status: "success",
          message: "忽略飞书非文本消息；已返回 ok，避免平台重试",
          metadata: summarizeCallbackPayload(req.body)
        });
        res.json({ ok: true, action: "ignored", reason: "non_text_message" });
        return;
      }
      markConnectorError(String(req.params.connector), error);
      next(error);
    }
  });

  app.post("/api/connectors/:connector/send-test", async (req, res, next) => {
    try {
      const source = sourceKindSchema.parse(req.params.connector);
      const connector = getConnectorAdapter(source);
      const runtimeConfig = connectorConfig(connector, connectorPublicBaseUrl());
      const platform = await connector.sendTestMessage(runtimeConfig);
      markConnectorTest(connector.source, platform.message);
      res.json({ ok: platform.ok, platform, connector: connectorView(connector) });
    } catch (error) {
      if (String(req.params.connector) === "feishu" && isFeishuNonTextMessageError(error)) {
        markFeishuIgnoredCallback(req.body, messageOf(error));
        res.json({ ok: true, action: "ignored", reason: "non_text_feishu_event" });
        return;
      }
      markConnectorError(String(req.params.connector), error);
      next(error);
    }
  });

  app.post("/api/connectors/:connector/start", async (req, res, next) => {
    try {
      const source = sourceKindSchema.parse(req.params.connector);
      if (source === "feishu") await startFeishuLongConnection(service);
      else res.json({ ok: false, error: "这个接入没有本机长连接/SDK session 可启动；请使用平台 webhook 回调。" });
      if (res.headersSent) return;
      res.json({ ok: true, connector: connectorView(getConnectorAdapter(source)) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/connectors/:connector/stop", (req, res, next) => {
    try {
      const source = sourceKindSchema.parse(req.params.connector);
      if (source === "feishu") stopFeishuLongConnection();
      else {
        res.json({ ok: false, error: "这个接入没有本机长连接/SDK session 可停止。" });
        return;
      }
      res.json({ ok: true, connector: connectorView(getConnectorAdapter(source)) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/settings", async (req, res, next) => {
    try {
      const body = settingsSchema.parse(req.body);
      const updates: Record<string, string> = {};
      if (body.obsidianVaultPath) {
        updates.OBSIDIAN_VAULT_PATH = body.obsidianVaultPath;
        config.OBSIDIAN_VAULT_PATH = body.obsidianVaultPath;
        process.env.OBSIDIAN_VAULT_PATH = body.obsidianVaultPath;
      }
      if (body.openaiBaseUrl) {
        updates.OPENAI_BASE_URL = body.openaiBaseUrl;
        config.OPENAI_BASE_URL = body.openaiBaseUrl;
        process.env.OPENAI_BASE_URL = body.openaiBaseUrl;
      }
      if (body.openaiApiKey) {
        updates.OPENAI_API_KEY = body.openaiApiKey;
        config.OPENAI_API_KEY = body.openaiApiKey;
        process.env.OPENAI_API_KEY = body.openaiApiKey;
      }
      if (body.openaiModel) {
        updates.OPENAI_MODEL = body.openaiModel;
        config.OPENAI_MODEL = body.openaiModel;
        process.env.OPENAI_MODEL = body.openaiModel;
      }
      if (body.githubToken) {
        updates.GITHUB_TOKEN = body.githubToken;
        config.GITHUB_TOKEN = body.githubToken;
        process.env.GITHUB_TOKEN = body.githubToken;
      }
      if (body.douyinParseApi) {
        updates.DOUYIN_PARSE_API = body.douyinParseApi;
        config.DOUYIN_PARSE_API = body.douyinParseApi;
        process.env.DOUYIN_PARSE_API = body.douyinParseApi;
      }
      if (body.ocrFrameIntervalSeconds) {
        updates.OCR_FRAME_INTERVAL_SECONDS = String(body.ocrFrameIntervalSeconds);
        config.OCR_FRAME_INTERVAL_SECONDS = body.ocrFrameIntervalSeconds;
        process.env.OCR_FRAME_INTERVAL_SECONDS = String(body.ocrFrameIntervalSeconds);
      }
      if (body.ocrMaxFrames) {
        updates.OCR_MAX_FRAMES = String(body.ocrMaxFrames);
        config.OCR_MAX_FRAMES = body.ocrMaxFrames;
        process.env.OCR_MAX_FRAMES = String(body.ocrMaxFrames);
      }
      if (Object.keys(updates).length) await updateEnvFile(updates);
      res.json({
        ok: true,
        githubTokenConfigured: Boolean(config.GITHUB_TOKEN),
        openaiConfigured: Boolean(config.OPENAI_API_KEY),
        obsidianVaultPath: config.OBSIDIAN_VAULT_PATH,
        openaiBaseUrl: config.OPENAI_BASE_URL,
        openaiModel: config.OPENAI_MODEL,
        douyinParseApi: config.DOUYIN_PARSE_API
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/settings", async (req, res, next) => {
    try {
      await saveSettings(settingsSchema.parse(req.body));
      res.json({ ok: true, ...settingsView() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/settings/test/tools", async (_req, res) => {
    res.json({
      ok: true,
      tools: {
        ffmpeg: await commandStatus("ffmpeg", ["-version"]),
        tesseract: await commandStatus("tesseract", ["--version"])
      }
    });
  });

  app.post("/api/settings/test/ocr", async (_req, res, next) => {
    const ffmpeg = await commandStatus("ffmpeg", ["-version"]);
    if (!ffmpeg.available) {
      res.status(400).json({ ok: false, error: "ffmpeg 不可用，无法生成 OCR 测试视频。" });
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidianlink-ocr-api-"));
    try {
      const videoPath = path.join(dir, "ocr-smoke.mp4");
      await runCommand(ffmpeg.command, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=640x360:d=5", "-pix_fmt", "yuv420p", videoPath]);
      const result = await new OcrClient().analyzeVideo(videoPath);
      res.json({
        ok: !result.error,
        result: {
          available: result.available,
          framesAnalyzed: result.framesAnalyzed,
          textLength: result.text.length,
          tempCleaned: result.tempCleaned,
          error: result.error
        }
      });
    } catch (error) {
      next(error);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  app.post("/api/settings/test/github", async (_req, res) => {
    try {
      if (!config.GITHUB_TOKEN) {
        res.status(400).json({ ok: false, error: "GITHUB_TOKEN 未配置" });
        return;
      }
      const response = await fetch("https://api.github.com/rate_limit", {
        headers: { Authorization: `Bearer ${config.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" }
      });
      res.status(response.ok ? 200 : 502).json({ ok: response.ok, status: response.status, result: await response.json().catch(() => ({})) });
    } catch (error) {
      res.status(502).json({ ok: false, error: `GitHub 测试请求失败：${messageOf(error)}` });
    }
  });

  app.post("/api/settings/test/openai", async (_req, res) => {
    try {
      if (!config.OPENAI_API_KEY) {
        res.status(400).json({ ok: false, error: "OPENAI_API_KEY 未配置" });
        return;
      }
      const response = await fetch(`${config.OPENAI_BASE_URL.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` }
      });
      res.status(response.ok ? 200 : 502).json({ ok: response.ok, status: response.status });
    } catch (error) {
      res.status(502).json({ ok: false, error: `模型连接测试失败：${messageOf(error)}` });
    }
  });

  app.post("/api/settings/test/douyin", async (req, res) => {
    try {
      const url = typeof req.body?.url === "string" ? req.body.url : "";
      if (!url) {
        res.json({ ok: true, configured: Boolean(config.DOUYIN_PARSE_API), message: "抖音解析 API 已配置；传入 url 可做真实解析测试。" });
        return;
      }
      const result = await new DouyinClient().parse(url);
      res.json({ ok: true, result });
    } catch (error) {
      res.status(502).json({ ok: false, error: `抖音解析测试失败：${messageOf(error)}` });
    }
  });

  app.post("/ingest/preview", async (req, res, next) => {
    try {
      const body = previewSchema.parse(req.body);
      res.json(await service.preview(body));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ingest/preview", async (req, res, next) => {
    try {
      const body = previewSchema.parse(req.body);
      const preview = await service.preview(body);
      const persisted = service.dbPreview(preview.previewId);
      res.json({ ...preview, jobId: persisted?.jobId, runId: persisted?.runId, status: "waiting_user" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/ingest/jobs", (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ jobs: service.jobs(Number.isFinite(limit) ? limit : 50) });
  });

  app.get("/api/ingest/jobs/:jobId", (req, res) => {
    const job = service.job(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json({ job });
  });

  app.post("/agent/message", async (req, res, next) => {
    try {
      const body = agentMessageSchema.parse(req.body);
      res.json(await service.handleAgentMessage(body));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agent/runs", (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ runs: service.runs(Number.isFinite(limit) ? limit : 50) });
  });

  app.get("/api/agent/runs/:runId", (req, res) => {
    const run = service.run(req.params.runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json({ run });
  });

  app.get("/api/agent/runs/:runId/steps", (req, res) => {
    res.json({ steps: service.runSteps(req.params.runId) });
  });

  app.get("/api/agent/runs/:runId/tool-calls", (req, res) => {
    res.json({ toolCalls: service.runToolCalls(req.params.runId) });
  });

  app.post("/api/agent/runs/:runId/retry", async (req, res, next) => {
    try {
      res.json(await service.retryRun(req.params.runId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/connectors/:connector/message", async (req, res, next) => {
    try {
      const source = sourceKindSchema.parse(req.params.connector);
      const connector = getConnectorAdapter(source);
      const runtimeConfig = connectorConfig(connector, connectorPublicBaseUrl());
      const challenge = await connector.handleChallenge(req, runtimeConfig);
      markConnectorRequest(source);
      if (!challenge.handled) {
        res.status(404).json({ error: "这个平台没有 GET challenge，或请求参数不完整。" });
        return;
      }
      if (challenge.contentType) res.type(challenge.contentType);
      res.status(challenge.status ?? 200).send(challenge.body);
    } catch (error) {
      if (String(req.params.connector) === "feishu" && isFeishuNonTextMessageError(error)) {
        markFeishuIgnoredCallback(req.body, messageOf(error));
        res.json({ ok: true, action: "ignored", reason: "non_text_feishu_event" });
        return;
      }
      markConnectorError(String(req.params.connector), error);
      next(error);
    }
  });

  app.post("/connectors/:connector/message", async (req, res, next) => {
    try {
      const source = sourceKindSchema.parse(req.params.connector);
      const connector = getConnectorAdapter(source);
      const runtimeConfig = connectorConfig(connector, connectorPublicBaseUrl());
      const challenge = await connector.handleChallenge(req, runtimeConfig);
      markConnectorRequest(source);
      if (challenge.handled) {
        if (challenge.contentType) res.type(challenge.contentType);
        res.status(challenge.status ?? 200).send(challenge.body);
        return;
      }
      if (source === "feishu" && isFeishuCardActionPayload(req.body)) {
        res.json(await handleFeishuCardCallback(service, req.body));
        return;
      }
      if (source === "feishu" && !isEncryptedFeishuPayload(req.body) && !isFeishuTextMessagePayload(req.body)) {
        repositories.addConnectorLog({
          source: "feishu",
          eventType: "ignored_callback",
          status: "success",
          message: "忽略飞书非文本消息/非卡片回调 payload",
          metadata: summarizeCallbackPayload(req.body)
        });
        res.json({ ok: true, action: "ignored" });
        return;
      }
      await connector.verifyRequest(req, runtimeConfig);
      const body = await connector.normalizeMessage(req, runtimeConfig);
      res.json(await enqueueOrHandle(service, connector, runtimeConfig, body));
    } catch (error) {
      if (String(req.params.connector) === "feishu" && isFeishuNonTextMessageError(error)) {
        markFeishuIgnoredCallback(req.body, messageOf(error));
        res.json({ ok: true, action: "ignored", reason: "non_text_feishu_event" });
        return;
      }
      markConnectorError(String(req.params.connector), error);
      next(error);
    }
  });

  app.post("/api/connectors/:connector/webhook", async (req, res, next) => {
    try {
      const source = sourceKindSchema.parse(req.params.connector);
      const connector = getConnectorAdapter(source);
      const runtimeConfig = connectorConfig(connector, connectorPublicBaseUrl());
      const challenge = await connector.handleChallenge(req, runtimeConfig);
      markConnectorRequest(source);
      if (challenge.handled) {
        if (challenge.contentType) res.type(challenge.contentType);
        res.status(challenge.status ?? 200).send(challenge.body);
        return;
      }
      if (source === "feishu" && isFeishuCardActionPayload(req.body)) {
        res.json(await handleFeishuCardCallback(service, req.body));
        return;
      }
      if (source === "feishu" && !isEncryptedFeishuPayload(req.body) && !isFeishuTextMessagePayload(req.body)) {
        repositories.addConnectorLog({
          source: "feishu",
          eventType: "ignored_callback",
          status: "success",
          message: "忽略飞书非文本消息/非卡片回调 payload",
          metadata: summarizeCallbackPayload(req.body)
        });
        res.json({ ok: true, action: "ignored" });
        return;
      }
      await connector.verifyRequest(req, runtimeConfig);
      const body = await connector.normalizeMessage(req, runtimeConfig);
      res.json(await enqueueOrHandle(service, connector, runtimeConfig, body));
    } catch (error) {
      if (String(req.params.connector) === "feishu" && isFeishuNonTextMessageError(error)) {
        markFeishuIgnoredCallback(req.body, messageOf(error));
        res.json({ ok: true, action: "ignored", reason: "non_text_feishu_event" });
        return;
      }
      markConnectorError(String(req.params.connector), error);
      next(error);
    }
  });

  app.post("/connectors/feishu/card", async (req, res, next) => {
    try {
      res.json(await handleFeishuCardCallback(service, req.body));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/connectors/feishu/card", async (req, res, next) => {
    try {
      res.json(await handleFeishuCardCallback(service, req.body));
    } catch (error) {
      next(error);
    }
  });

  app.post("/ingest/confirm", async (req, res, next) => {
    try {
      const body = confirmSchema.parse(req.body);
      res.json(await service.confirm(body));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ingest/confirm", async (req, res, next) => {
    try {
      const body = confirmSchema.parse({ ...req.body, decision: "confirm" });
      res.json(await service.confirm(body));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ingest/cancel", async (req, res, next) => {
    try {
      const previewId = z.object({ previewId: z.string().min(1) }).parse(req.body).previewId;
      res.json(await service.confirm({ previewId, decision: "cancel" }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ingest/supplement", async (req, res, next) => {
    try {
      const body = supplementSchema.parse(req.body);
      res.json(await service.confirm({ previewId: body.previewId, decision: "confirm", extraText: body.extraText }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/previews", (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    res.json({ previews: service.dbPreviews(Number.isFinite(limit) ? limit : 50, status) });
  });

  app.get("/api/previews/:previewId", (req, res) => {
    const preview = service.dbPreview(req.params.previewId);
    if (!preview) {
      res.status(404).json({ error: "Preview not found" });
      return;
    }
    res.json({ preview });
  });

  app.post("/api/previews/:previewId/confirm", async (req, res, next) => {
    try {
      res.json(await service.confirm({ previewId: req.params.previewId, decision: "confirm" }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/previews/:previewId/cancel", async (req, res, next) => {
    try {
      res.json(await service.confirm({ previewId: req.params.previewId, decision: "cancel" }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/previews/:previewId/regenerate", async (req, res, next) => {
    try {
      const extraText = z.object({ extraText: z.string().trim().min(1) }).parse(req.body).extraText;
      res.json(await service.confirm({ previewId: req.params.previewId, decision: "confirm", extraText }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/previews/:previewId/markdown", (req, res) => {
    const preview = service.dbPreview(req.params.previewId);
    if (!preview) {
      res.status(404).json({ error: "Preview not found" });
      return;
    }
    res.type("text/markdown").send(preview.markdownPreview || "");
  });

  app.get("/api/vault/status", async (_req, res) => {
    res.json({ path: config.OBSIDIAN_VAULT_PATH, exists: await vault.exists(), writable: await vaultWritable() });
  });

  app.post("/api/vault/init", async (_req, res, next) => {
    try {
      await vault.ensureStructure();
      res.json({ ok: true, dirs: [...fullVaultDirs] });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/vault/tree", async (_req, res, next) => {
    try {
      await vault.ensureStructure();
      res.json({ tree: await vaultTree() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/vault/recent-files", async (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ files: repositories.listVaultFiles(Number.isFinite(limit) ? limit : 50) });
  });

  app.post("/api/vault/check-broken-links", async (_req, res, next) => {
    try {
      res.json(await vault.checkBrokenLinks());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/vault/search", async (req, res, next) => {
    try {
      const query = z.object({ query: z.string().trim().min(1) }).parse(req.body).query.toLowerCase();
      const tree = await vaultTree();
      const files = tree.filter((item) => item.type === "file" && item.path.toLowerCase().includes(query)).slice(0, 50);
      res.json({ results: files });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/vault/open-path", async (_req, res, next) => {
    try {
      const vaultPath = resolveVaultPath();
      await fs.access(vaultPath);
      await new Promise<void>((resolve, reject) => {
        const child = spawn("open", [vaultPath], { stdio: "ignore" });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`open exited with code ${code}`)));
      });
      res.json({ ok: true, path: vaultPath });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof z.ZodError ? 400 : 500;
    res.status(status).json({
      error: error instanceof z.ZodError ? formatZodError(error) : error instanceof Error ? error.message : String(error)
    });
  });

  return app;
}

async function commandStatus(command: string, args: string[]) {
  const candidates = [
    command,
    `/Users/sky/.homebrew/bin/${command}`,
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`
  ];
  for (const candidate of candidates) {
    try {
      const output = await runCommand(candidate, args);
      return {
        available: true,
        command: candidate,
        version: output.split(/\r?\n/)[0] ?? ""
      };
    } catch {
      // Try next known path.
    }
  }
  return { available: false, command, version: "" };
}

function isFeishuCardActionPayload(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const value = body as Record<string, unknown>;
  const header = value.header && typeof value.header === "object" ? (value.header as Record<string, unknown>) : undefined;
  if (header?.event_type === "card.action.trigger") return true;
  if (hasObjectPath(value, ["action", "value"])) return true;
  if (hasObjectPath(value, ["event", "action", "value"])) return true;
  return false;
}

function isEncryptedFeishuPayload(body: unknown): boolean {
  const encrypt = readUnknownPath(body, ["encrypt"]);
  return typeof encrypt === "string" && encrypt.trim().length > 0;
}

function isFeishuTextMessagePayload(body: unknown): boolean {
  const eventType = readUnknownPath(body, ["header", "event_type"]) ?? readUnknownPath(body, ["event_type"]);
  if (eventType && eventType !== "im.message.receive_v1") return false;
  const messageType = readUnknownPath(body, ["event", "message", "message_type"]) ?? readUnknownPath(body, ["message", "message_type"]);
  if (messageType && !["text", "post"].includes(String(messageType))) return false;
  const content = readUnknownPath(body, ["event", "message", "content"]) ?? readUnknownPath(body, ["message", "content"]);
  if (typeof content === "string" && content.trim()) return true;
  const text = readUnknownPath(body, ["event", "message", "text"]) ?? readUnknownPath(body, ["message", "text"]) ?? readUnknownPath(body, ["text"]);
  return typeof text === "string" && text.trim().length > 0;
}

function summarizeCallbackPayload(body: unknown): Record<string, unknown> {
  return {
    schema: readUnknownPath(body, ["schema"]),
    eventType: readUnknownPath(body, ["header", "event_type"]) ?? readUnknownPath(body, ["event_type"]),
    messageType: readUnknownPath(body, ["event", "message", "message_type"]) ?? readUnknownPath(body, ["message", "message_type"]),
    hasEncrypt: typeof readUnknownPath(body, ["encrypt"]) === "string",
    hasAction: hasObjectPath(body, ["action", "value"]) || hasObjectPath(body, ["event", "action", "value"])
  };
}

function isFeishuNonTextMessageError(error: unknown): boolean {
  return messageOf(error).includes("飞书事件中没有文本消息内容");
}

function markFeishuIgnoredCallback(body: unknown, reason: string): void {
  repositories.addConnectorLog({
    source: "feishu",
    eventType: "ignored_callback",
    status: "success",
    message: "忽略飞书非文本事件；已返回 ok，避免平台重试",
    metadata: {
      ...summarizeCallbackPayload(body),
      reason: reason.slice(0, 800)
    }
  });
}

function readUnknownPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function hasObjectPath(value: unknown, path: string[]): boolean {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[key];
  }
  return Boolean(current && typeof current === "object");
}

function enqueueOrHandle(
  service: IngestService,
  connector: ConnectorAdapter,
  runtimeConfig: ConnectorRuntimeConfig,
  request: Parameters<IngestService["handleAgentMessage"]>[0]
) {
  if (connector.source === "feishu" && isStaleFeishuMessage(request)) {
    repositories.addConnectorLog({
      source: "feishu",
      eventType: "ignored_stale_event",
      status: "success",
      message: "忽略飞书旧消息，避免平台重试或服务重启后突然补处理",
      metadata: {
        messageId: request.messageId,
        senderId: request.senderId,
        chatId: request.chatId,
        eventTime: feishuEventTime(request.raw)?.toISOString(),
        textPreview: request.text.slice(0, 120)
      }
    });
    return Promise.resolve({
      ok: true,
      action: "ignored" as const,
      reply: "",
      writtenFiles: [],
      warnings: ["stale_feishu_event"]
    });
  }
  if (connector.source === "feishu" && shouldSendImmediateFeishuAck(request)) {
    void sendFeishuProcessingAck(request.chatId)
      .catch((error) => markConnectorError(connector.source, error));
  }
  const queued = service.enqueueAgentMessage(request, async (completed) => {
    try {
      await sendConnectorReply(connector, runtimeConfig, request, completed);
    } catch (error) {
      markConnectorError(connector.source, error);
    }
  });
  if (connector.source === "feishu") {
    queued
      .then((response) => {
        if (response.action === "queued") return sendFeishuProcessingAck(request.chatId, response.jobId);
        if (response.reply?.trim()) return sendConnectorReply(connector, runtimeConfig, request, response);
        return undefined;
      })
      .catch((error) => markConnectorError(connector.source, error));
  }
  return queued;
}

function shouldSendImmediateFeishuAck(request: Parameters<IngestService["handleAgentMessage"]>[0]): boolean {
  if (!request.chatId) return false;
  if (repositories.getIncomingMessageBySourceMessageId(request.source, request.messageId)) return false;
  const intent = classifyMessageIntent(request.text);
  if (intent.kind === "casual_chat" || intent.kind === "help" || intent.kind === "status") return false;
  if (intent.kind === "source_ingest" || intent.kind === "knowledge_ingest") return false;
  return intent.kind === "idea_chat" || hasIdeaSaveSignal(request.text);
}

function isStaleFeishuMessage(request: Parameters<IngestService["handleAgentMessage"]>[0]): boolean {
  const eventTime = feishuEventTime(request.raw);
  if (!eventTime) return false;
  const maxAgeMs = Number(process.env.FEISHU_STALE_EVENT_MAX_AGE_MS ?? 5 * 60 * 1000);
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return false;
  return Date.now() - eventTime.getTime() > maxAgeMs;
}

function feishuEventTime(raw: unknown): Date | undefined {
  const value =
    readUnknownPath(raw, ["event", "message", "create_time"]) ??
    readUnknownPath(raw, ["message", "create_time"]) ??
    readUnknownPath(raw, ["header", "create_time"]) ??
    readUnknownPath(raw, ["event", "create_time"]) ??
    readUnknownPath(raw, ["timestamp"]);
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  const millis = parsed < 10_000_000_000 ? parsed * 1000 : parsed;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

async function sendConnectorReply(
  connector: ConnectorAdapter,
  runtimeConfig: ConnectorRuntimeConfig,
  request: Parameters<IngestService["handleAgentMessage"]>[0],
  completed: Awaited<ReturnType<IngestService["handleAgentMessage"]>>
): Promise<void> {
  const result = await connector.sendReply(
    {
      source: connector.source,
      senderId: request.senderId,
      chatId: request.chatId,
      messageId: request.messageId,
      raw: request.raw
    },
    {
      text: completed.reply,
      jobId: completed.jobId,
      runId: completed.runId,
      previewId: completed.previewId,
      preview: completed.preview,
      warnings: completed.warnings,
      action: completed.action
    },
    runtimeConfig
  );
  repositories.addConnectorLog({
    source: connector.source,
    eventType: "reply",
    status: result.ok ? "success" : "warning",
    message: result.message,
    metadata: {
      jobId: completed.jobId,
      runId: completed.runId,
      previewId: completed.previewId,
      action: completed.action
    }
  });
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout || stderr);
      else reject(new Error(stderr || stdout || `${command} exited ${code}`));
    });
  });
}

function settingsView() {
  return {
    githubTokenConfigured: Boolean(config.GITHUB_TOKEN),
    openaiConfigured: Boolean(config.OPENAI_API_KEY),
    openaiBaseUrl: config.OPENAI_BASE_URL,
    openaiModel: config.OPENAI_MODEL,
    obsidianVaultPath: config.OBSIDIAN_VAULT_PATH,
    douyinParseApi: config.DOUYIN_PARSE_API,
    ocrFrameIntervalSeconds: config.OCR_FRAME_INTERVAL_SECONDS,
    ocrMaxFrames: config.OCR_MAX_FRAMES,
    database: databaseStatus()
  };
}

async function saveSettings(body: z.infer<typeof settingsSchema>) {
  const updates: Record<string, string> = {};
  if (body.obsidianVaultPath) {
    updates.OBSIDIAN_VAULT_PATH = body.obsidianVaultPath;
    config.OBSIDIAN_VAULT_PATH = body.obsidianVaultPath;
    process.env.OBSIDIAN_VAULT_PATH = body.obsidianVaultPath;
  }
  if (body.openaiBaseUrl) {
    updates.OPENAI_BASE_URL = body.openaiBaseUrl;
    config.OPENAI_BASE_URL = body.openaiBaseUrl;
    process.env.OPENAI_BASE_URL = body.openaiBaseUrl;
  }
  if (body.openaiApiKey) {
    updates.OPENAI_API_KEY = body.openaiApiKey;
    config.OPENAI_API_KEY = body.openaiApiKey;
    process.env.OPENAI_API_KEY = body.openaiApiKey;
  }
  if (body.openaiModel) {
    updates.OPENAI_MODEL = body.openaiModel;
    config.OPENAI_MODEL = body.openaiModel;
    process.env.OPENAI_MODEL = body.openaiModel;
  }
  if (body.githubToken) {
    updates.GITHUB_TOKEN = body.githubToken;
    config.GITHUB_TOKEN = body.githubToken;
    process.env.GITHUB_TOKEN = body.githubToken;
  }
  if (body.douyinParseApi) {
    updates.DOUYIN_PARSE_API = body.douyinParseApi;
    config.DOUYIN_PARSE_API = body.douyinParseApi;
    process.env.DOUYIN_PARSE_API = body.douyinParseApi;
  }
  if (body.ocrFrameIntervalSeconds) {
    updates.OCR_FRAME_INTERVAL_SECONDS = String(body.ocrFrameIntervalSeconds);
    config.OCR_FRAME_INTERVAL_SECONDS = body.ocrFrameIntervalSeconds;
    process.env.OCR_FRAME_INTERVAL_SECONDS = String(body.ocrFrameIntervalSeconds);
  }
  if (body.ocrMaxFrames) {
    updates.OCR_MAX_FRAMES = String(body.ocrMaxFrames);
    config.OCR_MAX_FRAMES = body.ocrMaxFrames;
    process.env.OCR_MAX_FRAMES = String(body.ocrMaxFrames);
  }
  if (Object.keys(updates).length) await updateEnvFile(updates);
}

async function vaultWritable(): Promise<boolean> {
  try {
    await fs.mkdir(resolveVaultPath(), { recursive: true });
    const probe = resolveVaultPath(".obsidianlink-write-test");
    await fs.writeFile(probe, "ok", "utf8");
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function vaultTree() {
  const root = resolveVaultPath();
  const results: { path: string; type: "file" | "dir" }[] = [];
  async function walk(relative = ""): Promise<void> {
    const dir = resolveVaultPath(relative);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".obsidian")) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push({ path: child, type: "dir" });
        if (child.split("/").length < 4) await walk(child);
      } else if (entry.isFile()) {
        results.push({ path: child, type: "file" });
      }
    }
  }
  await walk();
  return results.sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
}

function connectorView(connector: ConnectorAdapter) {
  const runtimeConfig = connectorConfig(connector, connectorPublicBaseUrl());
  const setup = connector.getSetupStatus(runtimeConfig);
  const runtime = connectorRuntime.get(connector.source) ?? {};
  const configuredFields = Object.fromEntries(
    connector.getConfigSchema().map((field) => [field.key, Boolean(runtimeConfig.values[field.key])])
  );
  repositories.upsertConnectorStatus({
    source: connector.source,
    enabled: runtimeConfig.enabled,
    mode: connector.mode,
    publicBaseUrl: connectorPublicBaseUrl(),
    localEndpoint: connector.endpoint,
    configStatus: setup.configured ? "complete" : "incomplete",
    configuredFields,
    capabilities: setup.capabilities,
    lastMessageAt: runtime.lastRequestAt,
    lastTestAt: runtime.lastTestAt,
    lastTestResult: runtime.lastTestResult,
    lastError: runtime.lastError
  });
  return {
    source: connector.source,
    adapter: connector.adapter,
    label: connector.label,
    endpoint: connector.endpoint,
    status: "ready",
    mode: connector.mode,
    description: connector.description,
    configFields: connector.getConfigSchema().map((field) => ({
      key: field.key,
      envKey: field.envKey,
      label: field.label,
      secret: field.secret,
      required: field.required,
      placeholder: field.placeholder
    })),
    enabled: runtimeConfig.enabled,
    url: `${connectorPublicBaseUrl()}${connector.endpoint}`,
    controls: connectorControls(connector),
    publicUrl: publicUrlStatus(connectorPublicBaseUrl(), connector.source),
    configuredFields,
    setupStatus: setup,
    lastRequestAt: runtime.lastRequestAt,
    lastError: runtime.lastError,
    lastTestAt: runtime.lastTestAt,
    lastTestResult: runtime.lastTestResult
  };
}

function connectorControls(connector: ConnectorAdapter) {
  const hasLocalSession = connector.source === "feishu";
  const canAsyncReply = connector.source === "feishu" || connector.source === "telegram";
  return {
    start: hasLocalSession,
    stop: hasLocalSession,
    asyncReply: canAsyncReply,
    testConnection: true
  };
}

function publicUrlStatus(publicBaseUrl: string, source?: string) {
  const isHttp = /^https?:\/\//i.test(publicBaseUrl);
  const isHttps = /^https:\/\//i.test(publicBaseUrl);
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(publicBaseUrl);
  const requiresHttps = ["wechat", "wecom", "dingtalk"].includes(source ?? "");
  const usable = isHttp && !isLocal && (!requiresHttps || isHttps);
  return {
    value: publicBaseUrl,
    usableByExternalPlatforms: usable,
    message: usable
      ? "当前是公网 FRP 回调地址；可填到该平台回调配置里。"
      : requiresHttps && isHttp && !isLocal
        ? "当前是 HTTP 公网 FRP 地址；该平台通常要求 HTTPS，请换成 HTTPS 域名。"
      : "当前是本机地址，需要内网穿透或部署后才能让真实平台回调。"
  };
}

function connectorPublicBaseUrl(): string {
  return (process.env.CONNECTOR_PUBLIC_BASE_URL || `http://127.0.0.1:${config.PORT}`).replace(/\/$/, "");
}

function markConnectorRequest(source: string): void {
  const current = connectorRuntime.get(source) ?? {};
  connectorRuntime.set(source, { ...current, lastRequestAt: new Date().toISOString(), lastError: undefined });
  repositories.addConnectorLog({ source, eventType: "request", status: "success", message: "收到平台请求" });
}

function markConnectorError(source: string, error: unknown): void {
  const current = connectorRuntime.get(source) ?? {};
  const message = error instanceof Error ? error.message : String(error);
  connectorRuntime.set(source, { ...current, lastError: message });
  repositories.addConnectorLog({ source, eventType: "error", status: "failed", message });
}

function markConnectorTest(source: string, result: string): void {
  const current = connectorRuntime.get(source) ?? {};
  connectorRuntime.set(source, { ...current, lastTestAt: new Date().toISOString(), lastTestResult: result });
  repositories.addConnectorLog({ source, eventType: "test", status: "success", message: result });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.join(".") || "请求参数";
      if (issue.code === "too_small") return `${field} 长度不够`;
      if (issue.code === "invalid_enum_value") return `${field} 选项无效`;
      return `${field} 参数无效`;
    })
    .join("；");
}

if (process.env.NODE_ENV !== "test") {
  const service = new IngestService();
  createApp(service).listen(config.PORT, "127.0.0.1", () => {
    console.log(`ObsidianLink listening on http://127.0.0.1:${config.PORT}`);
    void startFeishuLongConnection(service);
  });
}
