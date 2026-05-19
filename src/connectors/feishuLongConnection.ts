import crypto from "node:crypto";
import { IngestService } from "../ingestService.js";
import { repositories } from "../database/repositories.js";
import { classifyMessageIntent } from "../intentRouter.js";
import { AgentMessageRequest, AgentMessageResponse, ConfirmResult, IngestPreview, StoredPreview } from "../types.js";

interface FeishuLongConnectionStatus {
  enabled: boolean;
  running: boolean;
  lastEventAt?: string;
  lastReplyAt?: string;
  lastError?: string;
  note: string;
}

const status: FeishuLongConnectionStatus = {
  enabled: false,
  running: false,
  note: "飞书长连接未开启。"
};

let wsClient:
  | {
      start: (params: { eventDispatcher: unknown }) => Promise<void>;
      close?: (params?: { force?: boolean }) => void;
    }
  | undefined;

export function getFeishuLongConnectionStatus(): FeishuLongConnectionStatus {
  return { ...status };
}

export function stopFeishuLongConnection(): FeishuLongConnectionStatus {
  wsClient?.close?.({ force: true });
  wsClient = undefined;
  status.running = false;
  status.note = status.enabled ? "飞书长连接已手动停止。" : "飞书长连接未开启。";
  return getFeishuLongConnectionStatus();
}

export async function startFeishuLongConnection(service: IngestService): Promise<void> {
  const enabled = process.env.FEISHU_LONG_CONNECTION_ENABLED === "true";
  status.enabled = enabled;
  if (!enabled) {
    status.note = "FEISHU_LONG_CONNECTION_ENABLED 未开启；当前可使用 webhook 模式。";
    return;
  }
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    status.lastError = "FEISHU_APP_ID 或 FEISHU_APP_SECRET 未配置";
    status.note = "飞书长连接启动失败：缺少 App ID/App Secret。";
    return;
  }
  if (wsClient) {
    status.running = true;
    status.note = "飞书长连接已经在运行。";
    return;
  }

  try {
    const lark = (await import("@larksuiteoapi/node-sdk")) as unknown as {
      WSClient: new (params: {
        appId: string;
        appSecret: string;
        loggerLevel?: unknown;
        onReady?: () => void;
        onError?: (error: Error) => void;
        onReconnecting?: () => void;
        onReconnected?: () => void;
      }) => { start: (params: { eventDispatcher: unknown }) => Promise<void>; close?: (params?: { force?: boolean }) => void };
      EventDispatcher: new (params: { verificationToken?: string; encryptKey?: string; loggerLevel?: unknown }) => {
        register: (handlers: Record<string, (data: unknown) => Promise<void>>) => unknown;
      };
      LoggerLevel?: Record<string, unknown>;
    };

    const eventDispatcher = new lark.EventDispatcher({
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
      encryptKey: process.env.FEISHU_ENCRYPT_KEY,
      loggerLevel: lark.LoggerLevel?.info
    }).register({
      "im.message.receive_v1": async (data: unknown) => {
        try {
          repositories.addConnectorLog({
            source: "feishu",
            eventType: "long_connection_event",
            status: "received",
            message: "收到飞书 im.message.receive_v1 事件",
            metadata: summarizeFeishuEvent(data)
          });
          const message = normalizeFeishuLongConnectionEvent(data);
          status.lastEventAt = new Date().toISOString();
          status.lastError = undefined;
          repositories.addConnectorLog({
            source: "feishu",
            eventType: "message_normalized",
            status: "success",
            message: message.text.slice(0, 160),
            metadata: {
              senderId: message.senderId,
              chatId: message.chatId,
              messageId: message.messageId
            }
          });
          const response = await service.enqueueAgentMessage(message, async (completed) => {
            await sendFeishuReply(data, completed.reply, completed);
            status.lastReplyAt = new Date().toISOString();
            repositories.addConnectorLog({
              source: "feishu",
              eventType: "async_reply",
              status: completed.ok ? "success" : "failed",
              message: completed.reply.slice(0, 160),
              metadata: {
                action: completed.action,
                jobId: completed.jobId,
                runId: completed.runId,
                previewId: completed.previewId
              }
            });
          });
          if (response.action !== "queued") {
            await sendFeishuReply(data, response.reply, response);
            status.lastReplyAt = new Date().toISOString();
          } else {
            await sendFeishuProcessingAck(message.chatId, response.jobId);
            status.lastReplyAt = new Date().toISOString();
          }
          repositories.addConnectorLog({
            source: "feishu",
            eventType: "queued_reply",
            status: response.ok ? "success" : "failed",
            message: response.reply.slice(0, 160),
            metadata: { action: response.action, jobId: response.jobId, replied: response.action !== "queued" }
          });
        } catch (error) {
          status.lastError = error instanceof Error ? error.message : String(error);
          if (status.lastError.includes("没有文本消息内容")) {
            const chatId = extractFeishuChatId(data);
            if (chatId) {
              await sendFeishuChatText(chatId, "收到了，但这条不是可解析的纯文本消息。请直接发文字、抖音链接、GitHub 链接或网页链接，我会立刻处理。").catch(() => undefined);
              status.lastReplyAt = new Date().toISOString();
            }
          }
          repositories.addConnectorLog({
            source: "feishu",
            eventType: "long_connection_event",
            status: "failed",
            message: status.lastError,
            metadata: summarizeFeishuEvent(data)
          });
        }
      },
      "card.action.trigger": async (data: unknown) => {
        try {
          repositories.addConnectorLog({
            source: "feishu",
            eventType: "card_action",
            status: "received",
            message: "收到飞书卡片按钮点击",
            metadata: summarizeFeishuCardAction(data)
          });
          await handleFeishuCardAction(service, data, { sendChatReply: true });
        } catch (error) {
          repositories.addConnectorLog({
            source: "feishu",
            eventType: "card_action",
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
            metadata: summarizeFeishuCardAction(data)
          });
        }
      }
    });

    wsClient = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel?.info,
      onReady: () => {
        status.running = true;
        status.note = "飞书长连接已连接，正在接收事件。";
      },
      onError: (error) => {
        status.running = false;
        status.lastError = error.message;
        status.note = "飞书长连接连接失败。";
      },
      onReconnecting: () => {
        status.running = false;
        status.note = "飞书长连接正在重连。";
      },
      onReconnected: () => {
        status.running = true;
        status.note = "飞书长连接已重连。";
      }
    });
    await wsClient.start({ eventDispatcher });
    status.running = true;
    status.note = "飞书长连接启动中；首次握手成功后会更新为已连接。";
  } catch (error) {
    status.running = false;
    status.lastError = error instanceof Error ? error.message : String(error);
    status.note = "飞书长连接启动失败。";
  }
}

export function normalizeFeishuLongConnectionEvent(data: unknown): AgentMessageRequest {
  const message = readObject(data, ["message"]) ?? readObject(data, ["event", "message"]);
  const sender = readObject(data, ["sender"]) ?? readObject(data, ["event", "sender"]);
  const content = parseContent(readPath(message, ["content"]));
  const text = firstText([readPath(content, ["text"]), readPath(message, ["text"]), collectNestedText(content)]);
  if (!text) throw new Error("飞书长连接事件中没有文本消息内容");
  return {
    text,
    source: "feishu",
	    senderId:
	      firstText([
	        readPath(sender, ["sender_id", "open_id"]),
	        readPath(sender, ["sender_id", "user_id"]),
	        readPath(message, ["chat_id"])
	      ]) ?? "feishu-unknown",
	    chatId: firstText([readPath(message, ["chat_id"])]),
	    messageId: firstText([readPath(message, ["message_id"]), readPath(data, ["event_id"]), readPath(data, ["header", "event_id"])]) ?? `feishu-${Date.now()}`,
    autoWrite: false,
    raw: data && typeof data === "object" ? (data as Record<string, unknown>) : { value: data }
  };
}

export async function sendFeishuReply(event: unknown, text: string, response?: AgentMessageResponse): Promise<void> {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const message = readObject(event, ["message"]) ?? readObject(event, ["event", "message"]);
  const messageId = firstText([readPath(message, ["message_id"])]);
  if (!appId || !appSecret || !messageId || !text.trim()) {
    repositories.addConnectorLog({
      source: "feishu",
      eventType: "reply",
      status: "skipped",
      message: "飞书回复缺少 appId/appSecret/messageId/text",
      metadata: {
        hasAppId: Boolean(appId),
        hasAppSecret: Boolean(appSecret),
        hasMessageId: Boolean(messageId),
        hasText: Boolean(text.trim())
      }
    });
    return;
  }
  const { client } = await feishuClient(appId, appSecret);
  const eventText = extractFeishuEventText(event);
  const chatId = extractFeishuChatId(event);
  const previewForCard = previewFromResponse(response);
  const decisionCard = previewForCard && shouldSendDecisionCard(previewForCard, eventText)
    ? buildPreviewDecisionCard(previewForCard, { chatId })
    : undefined;
  if (!decisionCard) {
    await sendFeishuTextWithClient(client, { chatId, messageId, text });
    repositories.addConnectorLog({
      source: "feishu",
      eventType: "reply",
      status: "success",
      message: "已发送飞书普通文本回复",
      metadata: { messageId, chatId, interactive: false, directChat: Boolean(chatId), action: response?.action, eventText: eventText?.slice(0, 80) }
    });
    return;
  }
  await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: "interactive",
      content: JSON.stringify(decisionCard)
    }
  });
  repositories.addConnectorLog({
    source: "feishu",
    eventType: "reply",
    status: "success",
    message: "已发送飞书交互确认卡片",
    metadata: { messageId, chatId, interactive: true, action: response?.action, previewId: response?.previewId, hasPreview: Boolean(previewForCard), eventText: eventText?.slice(0, 80) }
  });
}

function previewFromResponse(response?: AgentMessageResponse): IngestPreview | undefined {
  if (!response || (response.action !== "preview_generated" && response.action !== "regenerated")) return undefined;
  if (response.preview) return response.preview;
  if (!response.previewId) return undefined;
  const stored = repositories.getStoredPreview(response.previewId);
  return stored ? toCardPreview(stored) : undefined;
}

function toCardPreview(stored: StoredPreview): IngestPreview {
  return {
    previewId: stored.previewId,
    summary: stored.summary,
    detectedProjects: stored.detectedProjects,
    notesToWrite: stored.notesToWrite,
    knowledge: stored.knowledge,
    ideas: stored.ideas,
    warnings: stored.warnings
  };
}

export async function handleFeishuCardCallback(service: IngestService, body: unknown): Promise<Record<string, unknown>> {
  const data = decodeFeishuCardBody(body);
  const challenge = readPath(data, ["challenge"]);
  if (readPath(data, ["type"]) === "url_verification" && typeof challenge === "string") {
    repositories.addConnectorLog({
      source: "feishu",
      eventType: "card_url_verification",
      status: "success",
      message: "飞书卡片回调 URL verification 已返回 challenge",
      metadata: { challenge: challenge.slice(0, 16) }
    });
    return { challenge };
  }
  repositories.addConnectorLog({
    source: "feishu",
    eventType: "card_action",
    status: "received",
    message: "收到飞书 HTTP 卡片按钮回调",
    metadata: summarizeFeishuCardAction(data)
  });
  try {
    const message = await handleFeishuCardAction(service, data, { sendChatReply: true });
    return buildCardCallbackAckCard("操作完成", message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    repositories.addConnectorLog({
      source: "feishu",
      eventType: "card_action",
      status: "failed",
      message,
      metadata: summarizeFeishuCardAction(data)
    });
    return buildCardCallbackAckCard("处理失败", `处理失败：${message}`);
  }
}

async function handleFeishuCardAction(service: IngestService, data: unknown, options: { sendChatReply?: boolean } = {}): Promise<string> {
  const action = normalizeFeishuCardAction(data);
  if (!action.previewId) throw new Error("卡片动作缺少 previewId");
  let text: string;
  if (action.decision === "ideate") {
    const stored = repositories.getStoredPreview(action.previewId);
    if (stored) {
      if (options.sendChatReply && action.chatId) await sendFeishuChatText(action.chatId, formatFeishuIdeas(stored));
      repositories.addConnectorLog({
        source: "feishu",
        eventType: "card_action",
        status: "success",
        message: `已发送联想分析文本：${action.previewId}`,
        metadata: action
      });
      return options.sendChatReply && action.chatId ? `已发送应用想法：${action.previewId}` : formatFeishuIdeas(stored);
    }
    text = `没有找到预览：${action.previewId}`;
  } else if (action.decision === "confirm") {
    const stored = repositories.getStoredPreview(action.previewId);
    const result = await service.confirm({ previewId: action.previewId, decision: "confirm", writeMode: stored && isKnowledgePreview(stored) ? "knowledge_only" : "default" });
    text = formatFeishuConfirmResult(result, false);
  } else if (action.decision === "confirm_ideate") {
    const stored = repositories.getStoredPreview(action.previewId);
    const result = await service.confirm({ previewId: action.previewId, decision: "confirm", writeMode: stored && isKnowledgePreview(stored) ? "knowledge_only" : "default" });
    const confirmText = formatFeishuConfirmResult(result, false);
    if (options.sendChatReply && action.chatId) {
      await sendFeishuChatText(action.chatId, confirmText);
      if (stored) await sendFeishuChatText(action.chatId, formatFeishuIdeas(stored));
      text = stored ? "已入库主文件，并已发送应用想法；联想不会写入 Obsidian。" : `${confirmText}\n\n联想分析暂不可用。`;
      repositories.addConnectorLog({
        source: "feishu",
        eventType: "card_action",
        status: "success",
        message: text.slice(0, 160),
        metadata: action
      });
      return text;
    }
    text = `${confirmText}\n\n${stored ? formatFeishuIdeas(stored) : "联想分析暂不可用。"}\n\n注意：联想只发送到飞书，不写入 Obsidian。`;
  } else {
    throw new Error(`未知卡片动作：${action.decision}`);
  }
  if (options.sendChatReply && action.chatId) await sendFeishuChatText(action.chatId, text);
  repositories.addConnectorLog({
    source: "feishu",
    eventType: "card_action",
    status: "success",
    message: text.slice(0, 160),
    metadata: action
  });
  return text;
}

async function sendFeishuChatText(chatId: string, text: string): Promise<void> {
  await sendFeishuChatMessage(chatId, "text", { text });
}

export async function sendFeishuProcessingAck(chatId: string | undefined, jobId?: string): Promise<void> {
  if (!chatId) return;
  const suffix = jobId ? `任务 ${shortId(jobId)}。` : "";
  await sendFeishuChatText(chatId, `收到，我先开始解析。${suffix}如果判断出需要入库，我会发确认卡片；普通聊天我就直接文字回复。`);
}

async function sendFeishuChatMessage(chatId: string, msgType: "text" | "interactive", content: Record<string, unknown>): Promise<void> {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error("FEISHU_APP_ID 或 FEISHU_APP_SECRET 未配置");
  const { client } = await feishuClient(appId, appSecret);
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: msgType,
      content: JSON.stringify(content)
    }
  });
}

async function sendFeishuTextWithClient(
  client: Awaited<ReturnType<typeof feishuClient>>["client"],
  params: { chatId?: string; messageId: string; text: string }
): Promise<void> {
  if (params.chatId) {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: params.chatId,
        msg_type: "text",
        content: JSON.stringify({ text: params.text })
      }
    });
    return;
  }
  await client.im.message.reply({
    path: { message_id: params.messageId },
    data: {
      msg_type: "text",
      content: JSON.stringify({ text: params.text })
    }
  });
}

async function feishuClient(appId: string, appSecret: string) {
  const lark = (await import("@larksuiteoapi/node-sdk")) as unknown as {
    Client: new (params: { appId: string; appSecret: string; loggerLevel?: unknown }) => {
      im: {
        message: {
          reply: (payload: { path: { message_id: string }; data: { msg_type: string; content: string } }) => Promise<unknown>;
          create: (payload: { params: { receive_id_type: string }; data: { receive_id: string; msg_type: string; content: string } }) => Promise<unknown>;
        };
      };
    };
    LoggerLevel?: Record<string, unknown>;
  };
  return { client: new lark.Client({ appId, appSecret, loggerLevel: lark.LoggerLevel?.info }) };
}

function buildPreviewDecisionCard(preview: IngestPreview, context: { chatId?: string } = {}) {
  const labels = cardActionLabels(preview);
  const useButtons = shouldUseFeishuCardButtons();
  const cardKind = previewCardKind(preview);
  const tone = previewCardTone(preview);
  const primaryTitle = formatPrimaryTitle(preview);
  const noteSummary = preview.notesToWrite[0];
  const warningElements = preview.warnings.length
    ? [
        {
          tag: "note",
          elements: [{ tag: "plain_text", content: `注意：${preview.warnings.slice(0, 2).map((item) => truncateCardText(item, 72)).join("；")}` }]
        }
      ]
    : [];
  return {
    config: { wide_screen_mode: true },
    header: {
      template: tone,
      title: { tag: "plain_text", content: `识别完成 · ${cardKind}` }
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `${tagText(cardKind, tone)} **${primaryTitle}**\n${truncateCardText(preview.summary, 210)}`
        }
      },
      {
        tag: "column_set",
        flex_mode: "none",
        background_style: "grey",
        columns: [
          cardColumn("写入计划", formatNotePlan(preview)),
          cardColumn("可信度", formatConfidence(preview)),
          cardColumn("来源", formatPreviewSource(preview))
        ]
      },
      ...(noteSummary
        ? [
            {
              tag: "div",
              text: {
                tag: "lark_md",
                content: `**将写入**\n${noteTypeLabel(noteSummary.type)} · ${truncateCardText(noteSummary.title, 42)}\n${truncateMiddle(noteSummary.path, 68)}`
              }
            }
          ]
        : []),
      ...(preview.ideas.length
        ? [
            {
              tag: "div",
              text: { tag: "lark_md", content: `**可联想方向**\n${formatIdeaTeaser(preview)}` }
            }
          ]
        : []),
      ...warningElements,
      {
        tag: "hr"
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**选择下一步**\n${labels.shortDescription}`
        }
      },
      ...(useButtons
        ? [
            {
              tag: "action",
              actions: [
                buildActionButton(labels.confirm, "confirm", preview.previewId, context.chatId, "primary"),
                buildActionButton(labels.ideate, "ideate", preview.previewId, context.chatId, "default"),
                buildActionButton(labels.confirmIdeate, "confirm_ideate", preview.previewId, context.chatId, "default")
              ]
            }
          ]
        : [
            {
              tag: "note",
              elements: [{ tag: "plain_text", content: `可直接回复：${labels.confirm} / ${labels.ideate} / ${labels.confirmIdeate}` }]
            }
          ]),
      {
        tag: "note",
        elements: [{ tag: "plain_text", content: `预览 ${shortId(preview.previewId)} · 不确认不会写入 Obsidian` }]
      }
    ]
  };
}

function buildActionButton(label: string, decision: string, previewId: string, chatId: string | undefined, type: "primary" | "default") {
  return {
    tag: "button",
    type,
    text: { tag: "plain_text", content: label },
    value: { obsidianlink: true, decision, previewId, chatId }
  };
}

function isKnowledgePreview(preview: Pick<IngestPreview, "detectedProjects" | "knowledge">): boolean {
  return preview.detectedProjects.length === 0 && preview.knowledge.length > 0;
}

function cardActionLabels(preview: IngestPreview): { confirm: string; ideate: string; confirmIdeate: string; shortDescription: string } {
  if (preview.detectedProjects.length) {
    return {
      confirm: "只入库",
      ideate: "只联想",
      confirmIdeate: "入库并联想",
      shortDescription: "只入库写项目卡；只联想不写文件；入库并联想只写主文件，联想只发到飞书。"
    };
  }
  if (isKnowledgePreview(preview)) {
    return {
      confirm: "入库知识",
      ideate: "生成应用想法",
      confirmIdeate: "入库并联想",
      shortDescription: "入库知识只写主文件；应用想法只发到飞书，不写入 Obsidian。"
    };
  }
  return {
    confirm: "入库",
    ideate: "展开想法",
    confirmIdeate: "入库并展开",
    shortDescription: "信息足够就入库；不确定时先补充上下文。"
  };
}

function shouldUseFeishuCardButtons(): boolean {
  return process.env.FEISHU_CARD_CALLBACK_ENABLED === "true";
}

function previewCardKind(preview: IngestPreview): string {
  if (preview.detectedProjects.some((item) => item.githubRepo || item.githubUrl)) return "GitHub 项目";
  if (preview.detectedProjects.length) return "项目候选";
  if (preview.knowledge.length) return "知识卡片";
  if (preview.notesToWrite.some((note) => note.type === "idea")) return "想法";
  return "待补充";
}

function previewCardTone(preview: IngestPreview): "blue" | "green" | "yellow" | "purple" {
  if (preview.detectedProjects.some((item) => item.githubRepo || item.githubUrl)) return "green";
  if (preview.detectedProjects.length) return "yellow";
  if (preview.knowledge.length) return "blue";
  return "purple";
}

function tagText(label: string, tone: string): string {
  const labels: Record<string, string> = {
    green: "已确认",
    blue: "已识别",
    yellow: "待核对",
    purple: "可展开",
    red: "需处理"
  };
  const prefix = labels[tone] ?? "状态";
  return `**${prefix}｜${label}**`;
}

function cardColumn(title: string, value: string): Record<string, unknown> {
  return {
    tag: "column",
    width: "weighted",
    weight: 1,
    vertical_align: "top",
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**${title}**\n${truncateCardText(value, 46)}`
        }
      }
    ]
  };
}

function formatPrimaryTitle(preview: IngestPreview): string {
  if (preview.detectedProjects.length) {
    const project = preview.detectedProjects[0];
    return truncateCardText(project.githubRepo ?? project.name ?? project.githubUrl ?? "项目候选", 80);
  }
  if (preview.knowledge.length) return truncateCardText(preview.knowledge[0].title, 80);
  if (preview.notesToWrite.length) return truncateCardText(preview.notesToWrite[0].title, 80);
  return "待补充信息";
}

function formatPreviewSource(preview: IngestPreview): string {
  if (preview.notesToWrite.some((note) => note.path.includes("1_项目"))) return "项目";
  if (preview.notesToWrite.some((note) => note.path.includes("2_知识"))) return "知识";
  if (preview.notesToWrite.some((note) => note.path.includes("4_想法"))) return "想法";
  return "输入";
}

function formatDetectedTarget(preview: IngestPreview): string {
  if (preview.detectedProjects.length) {
    return preview.detectedProjects
      .map((item) => item.githubRepo ?? item.githubUrl ?? item.name)
      .slice(0, 3)
      .join("\n");
  }
  if (preview.knowledge.length) return preview.knowledge.map((item) => item.title).slice(0, 3).join("\n");
  return "未稳定识别，需要补充项目名、链接或关键上下文。";
}

function formatConfidence(preview: IngestPreview): string {
  const values = preview.detectedProjects.map((item) => item.confidence).filter((item) => Number.isFinite(item));
  if (!values.length) return preview.warnings.length ? "中，需要人工确认" : "中";
  const score = Math.round((values.reduce((sum, item) => sum + item, 0) / values.length) * 100);
  if (score >= 85) return `${score}% 高`;
  if (score >= 65) return `${score}% 中`;
  return `${score}% 低，建议先补充`;
}

function formatNotePlan(preview: IngestPreview): string {
  if (!preview.notesToWrite.length) return "暂不写入，等待补充";
  if (preview.detectedProjects.length) return preview.detectedProjects.some((item) => item.githubRepo || item.githubUrl) ? "1 个项目卡" : "1 个项目候选卡";
  const typeCounts = new Map<string, number>();
  for (const note of preview.notesToWrite) {
    typeCounts.set(note.type, (typeCounts.get(note.type) ?? 0) + 1);
  }
  return Array.from(typeCounts.entries())
    .map(([type, count]) => `${noteTypeLabel(type)} ${count}`)
    .join("，");
}

function formatNotePaths(preview: IngestPreview): string {
  if (!preview.notesToWrite.length) return "- 暂无文件计划";
  return preview.notesToWrite
    .slice(0, 3)
    .map((note) => `- ${noteTypeLabel(note.type)}：${truncateCardText(note.title, 38)}\n  ${truncateMiddle(note.path, 64)}`)
    .join("\n");
}

function formatIdeaTeaser(preview: IngestPreview): string {
  if (!preview.ideas.length) return "- 暂无；可先入库，后续从项目卡继续生成。";
  return preview.ideas
    .slice(0, 3)
    .map((idea) => `- ${truncateCardText(idea.title, 28)}：${truncateCardText(idea.productConcept || idea.minimalExperiment, 72)}`)
    .join("\n");
}

function noteTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    project: "项目",
    knowledge: "知识",
    idea: "想法",
    source: "素材",
    inbox: "收件箱",
    action: "行动"
  };
  return labels[type] ?? type;
}

function normalizeFeishuCardAction(data: unknown): { previewId?: string; decision?: string; chatId?: string; messageId?: string; operatorId?: string } {
  const value = readObject(data, ["action", "value"]) ?? readObject(data, ["event", "action", "value"]);
  return {
    previewId: firstText([readPath(value, ["previewId"])]),
    decision: firstText([readPath(value, ["decision"])]),
    chatId: firstText([
      readPath(value, ["chatId"]),
      readPath(data, ["context", "open_chat_id"]),
      readPath(data, ["open_chat_id"]),
      readPath(data, ["event", "context", "open_chat_id"]),
      readPath(data, ["event", "open_chat_id"])
    ]),
    messageId: firstText([
      readPath(data, ["context", "open_message_id"]),
      readPath(data, ["open_message_id"]),
      readPath(data, ["event", "context", "open_message_id"]),
      readPath(data, ["event", "open_message_id"])
    ]),
    operatorId: firstText([
      readPath(data, ["operator", "open_id"]),
      readPath(data, ["event", "operator", "open_id"]),
      readPath(data, ["operator", "user_id"]),
      readPath(data, ["event", "operator", "user_id"])
    ])
  };
}

function summarizeFeishuCardAction(data: unknown): Record<string, unknown> {
  return normalizeFeishuCardAction(data);
}

function formatFeishuConfirmResult(result: ConfirmResult, includePreviewId = true): string {
  if (result.alreadyCommitted) {
    return [
      "这条预览已经入库过，本次没有重复写入。",
      includePreviewId ? `Preview：${result.previewId}` : "",
      result.plannedFiles?.length ? `已关联文件：${result.plannedFiles.slice(0, 5).join("、")}` : ""
    ].filter(Boolean).join("\n");
  }
  const prefix = result.status === "confirmed" ? "已入库 Obsidian。" : result.status === "cancelled" ? "已取消。" : "已重新生成。";
  return [prefix, includePreviewId ? `Preview：${result.previewId}` : "", `写入：${result.writtenFiles.length} 个文件`].filter(Boolean).join("\n");
}

function decodeFeishuCardBody(body: unknown): unknown {
  const encrypt = readPath(body, ["encrypt"]);
  const decoded = typeof encrypt === "string" && encrypt.trim() ? decryptFeishuPayload(encrypt) : body;
  const token = firstText([readPath(decoded, ["token"])]);
  const expected = process.env.FEISHU_VERIFICATION_TOKEN;
  if (expected && token && token !== expected) throw new Error("飞书卡片回调 token 校验失败");
  return decoded;
}

function decryptFeishuPayload(encrypt: string): unknown {
  const encryptKey = process.env.FEISHU_ENCRYPT_KEY;
  if (!encryptKey) throw new Error("飞书卡片回调是加密 payload，但 FEISHU_ENCRYPT_KEY 未配置");
  const encrypted = Buffer.from(encrypt, "base64");
  if (encrypted.length <= 16) throw new Error("飞书卡片回调加密格式无效");
  const iv = encrypted.subarray(0, 16);
  const content = encrypted.subarray(16);
  const key = crypto.createHash("sha256").update(encryptKey, "utf8").digest();
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(content), decipher.final()]).toString("utf8");
  return JSON.parse(decrypted) as unknown;
}

function buildCardCallbackAckCard(title: string, message: string): Record<string, unknown> {
  const failed = title.includes("失败");
  const lines = message.split("\n").filter(Boolean);
  const firstLine = lines[0] ?? message;
  const detail = lines.slice(1).join("\n");
  return {
    config: { wide_screen_mode: true },
    header: {
      template: failed ? "red" : "green",
      title: { tag: "plain_text", content: title }
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: `${tagText(failed ? "操作失败" : "操作完成", failed ? "red" : "green")}\n${truncateCardText(firstLine, 160)}` }
      },
      ...(detail
        ? [
            {
              tag: "div",
              text: { tag: "lark_md", content: `**明细**\n${truncateCardText(detail, failed ? 360 : 420)}` }
            }
          ]
        : []),
      {
        tag: "hr"
      },
      {
        tag: "note",
        elements: [{ tag: "plain_text", content: failed ? "可以补充信息后重新生成。" : "ObsidianLink 已处理完这次卡片操作。" }]
      }
    ]
  };
}

function formatFeishuIdeas(stored: StoredPreview): string {
  if (!stored.ideas.length) return "这次预览没有生成联想方向。";
  return [
    `联想分析：${stored.previewId}`,
    ...stored.ideas.slice(0, 5).map((idea, index) =>
      [
        `${index + 1}. ${idea.title}`,
        `产品设想：${idea.productConcept}`,
        `最小实验：${idea.minimalExperiment}`,
        `下一步：${idea.nextAction}`
      ].join("\n")
    )
  ].join("\n\n");
}

function shouldSendDecisionCard(preview: IngestPreview, eventText?: string): boolean {
  if (eventText) {
    const routed = classifyMessageIntent(eventText);
    if (routed.kind === "casual_chat" || routed.kind === "help" || routed.kind === "idea_chat") return false;
    if (routed.kind === "source_ingest" || routed.kind === "knowledge_ingest") return true;
  }
  if (preview.detectedProjects.length > 0) return true;
  if (preview.notesToWrite.some((note) => note.type === "project" || note.type === "source")) return true;
  return preview.notesToWrite.length > 0 && preview.knowledge.length > 0 && !preview.summary.includes("低信息输入");
}

function extractFeishuEventText(event: unknown): string | undefined {
  const message = readObject(event, ["message"]) ?? readObject(event, ["event", "message"]);
  const content = parseContent(readPath(message, ["content"]));
  return firstText([readPath(content, ["text"]), readPath(message, ["text"]), collectNestedText(content)]);
}

function extractFeishuChatId(event: unknown): string | undefined {
  const message = readObject(event, ["message"]) ?? readObject(event, ["event", "message"]);
  return firstText([readPath(message, ["chat_id"]), readPath(event, ["context", "open_chat_id"]), readPath(event, ["event", "context", "open_chat_id"])]);
}

function truncateCardText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.max(8, Math.floor((max - 1) * 0.58));
  const tail = Math.max(8, max - head - 1);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function shortId(id: string): string {
  const clean = id.trim();
  if (clean.length <= 14) return clean;
  return `${clean.slice(0, 6)}…${clean.slice(-6)}`;
}

function summarizeFeishuEvent(data: unknown): Record<string, unknown> {
  const message = readObject(data, ["message"]) ?? readObject(data, ["event", "message"]);
  const sender = readObject(data, ["sender"]) ?? readObject(data, ["event", "sender"]);
  return {
    eventId: firstText([readPath(data, ["event_id"]), readPath(data, ["header", "event_id"])]),
    messageId: firstText([readPath(message, ["message_id"])]),
    messageType: firstText([readPath(message, ["message_type"])]),
    chatId: firstText([readPath(message, ["chat_id"])]),
    senderId: firstText([readPath(sender, ["sender_id", "open_id"]), readPath(sender, ["sender_id", "user_id"])])
  };
}

function parseContent(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { text: value };
  }
}

function readObject(value: unknown, path: string[]): Record<string, unknown> | undefined {
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

function collectNestedText(value: unknown): string | undefined {
  const chunks: string[] = [];
  const visit = (current: unknown) => {
    if (!current) return;
    if (typeof current === "string") {
      const clean = current.trim();
      if (clean) chunks.push(clean);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    for (const key of ["text", "title", "content", "href"]) visit(record[key]);
  };
  visit(value);
  return chunks.join(" ").trim() || undefined;
}
