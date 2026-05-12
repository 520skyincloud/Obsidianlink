# ObsidianLink

ObsidianLink 是一个本机优先的个人知识摄入智能体。你把抖音链接、GitHub 链接、网页文章、项目名或自然语言想法发给它，它会自动解析来源、研究项目、理解图文/视频内容、生成知识预览，确认后写入本地 Obsidian Vault。

它不是一个云端笔记应用，而是一套“聊天入口 + LangGraph 智能体 + 本地 Obsidian”的自动化工作流。

```text
聊天入口 / Web 控制台
  -> Connector Adapter
  -> Ingest Job
  -> LangGraph Agent
  -> Tool Calls
  -> Preview Draft
  -> User Decision
  -> Obsidian Vault Commit
```

默认控制台：

```text
http://127.0.0.1:38721/
```

默认 Vault：

```text
/Users/sky/Documents/obsidian/sky
```

## 适合谁

- 经常刷到抖音技术视频、图文教程、GitHub 项目，但转头就忘的人。
- 想把 QQ、飞书、Telegram、微信等聊天入口变成个人知识库入口的人。
- 想让模型先整理、分类、联想，再由自己确认写入 Obsidian 的人。
- 想用 LangGraph.js 搭一个本地智能体任务系统的人。

## 核心能力

- 多来源摄入：抖音短视频、抖音图文、GitHub 仓库、网页文章、普通想法、项目名称。
- 抖音理解：解析接口拿到标题、作者、aweme_id、视频地址或图片列表。
- 视频 OCR：下载临时视频，ffmpeg 抽帧，tesseract 识别画面文字，处理后清理缓存。
- 图文 OCR：下载抖音图文图片，逐张 OCR，再交给模型总结内容，处理后清理缓存。
- GitHub 研究：通过 GitHub API 获取 repo 描述、README、stars、topics、license、更新时间。
- LangGraph 智能体：按节点记录输入解析、来源路由、工具调用、知识抽取、创意生成、预览计划。
- 预览确认：飞书/网页先给预览卡片，用户选择入库、生成应用想法、入库并保存想法。
- Obsidian 写入：只写入主项目或主知识卡，额外应用想法默认只回到聊天，不乱塞进 Vault。
- SQLite 状态库：记录消息、job、run、step logs、tool calls、previews、vault_files。
- 本地控制台：查看对话、接入通道、预览确认、流水线、Vault、配置状态。

## 知识库结构

目录按知识库使用场景组织，主题放到 frontmatter，而不是无限嵌套目录。

```text
0_收件箱
1_项目
2_知识
3_能力
4_想法
5_实验
6_作品
7_地图
8_归档
9_系统
```

示例 frontmatter：

```yaml
type: knowledge
title: "提示词优化图文方法"
content_kind: method
source_type: douyin
domains: ["AI智能体", "效率工作流"]
entities: ["Prompt", "Obsidian"]
source_urls:
  - "https://v.douyin.com/example/"
```

GitHub 项目卡标题会使用：

```text
英文项目名 - 中文用途摘要
```

例如：

```text
langgraph - 多智能体工作流编排框架
minimind - 从零训练小型语言模型
Agent-Reach - 给 AI Agent 一键装上互联网能力
```

文件路径仍使用稳定 repo slug，方便去重：

```text
1_项目/0_开源项目/langchain-ai-langgraph.md
```

## 快速启动

要求：

- Node.js 20+
- macOS / Linux
- 一个 Obsidian Vault
- OpenAI 兼容模型接口
- GitHub Token
- 可选：ffmpeg、tesseract，用于视频/图片 OCR

安装：

```bash
npm install
cp .env.example .env
```

编辑 `.env`，至少填写：

```bash
OBSIDIAN_VAULT_PATH=/Users/sky/Documents/obsidian/sky
OPENAI_BASE_URL=http://your-openai-compatible-host/v1
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-5.5
GITHUB_TOKEN=your_github_token
DOUYIN_PARSE_API=https://api.bugpk.com/api/douyin?url=
```

安装 OCR 工具：

```bash
brew install ffmpeg tesseract tesseract-lang
```

构建并启动：

```bash
npm run build
npm run service:start
```

打开控制台：

```text
http://127.0.0.1:38721/
```

查看状态：

```bash
npm run service:status
npm run doctor
```

停止服务：

```bash
npm run service:stop
```

登录后自动常驻：

```bash
npm run build
npm run launchd:install
```

取消自动常驻：

```bash
npm run launchd:uninstall
```

开发模式：

```bash
npm run dev
```

## 配置说明

`.env.example` 里列出了全部配置。常用字段：

```bash
PORT=38721
OBSIDIANLINK_DB_PATH=./data/obsidianlink.sqlite
OBSIDIAN_VAULT_PATH=/Users/sky/Documents/obsidian/sky

OPENAI_BASE_URL=http://your-openai-compatible-host/v1
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.5
OPENAI_TIMEOUT_MS=60000

GITHUB_TOKEN=
DOUYIN_PARSE_API=https://api.bugpk.com/api/douyin?url=

OCR_FRAME_INTERVAL_SECONDS=4
OCR_MAX_FRAMES=8
OCR_MAX_VIDEO_BYTES=83886080
```

安全约定：

- `.env` 不会提交到 Git。
- SQLite、日志、截图、运行缓存不会提交到 Git。
- 前端不会回显密钥明文，只显示是否已配置。
- 视频和图片只用于临时 OCR，处理后会删除临时文件。

## 使用方式

### 1. Web 控制台

打开：

```text
http://127.0.0.1:38721/
```

推荐调试顺序：

1. 配置页：测试模型、GitHub、抖音解析、ffmpeg、tesseract。
2. 对话页：粘贴 GitHub 链接、抖音链接、网页 URL 或项目名。
3. 预览页：检查将写入的项目卡/知识卡。
4. 流水线页：查看每个 LangGraph 节点、tool call、warning/error。
5. Vault 页：检查目录、最近写入、断链。

### 2. HTTP API

生成预览：

```bash
curl -X POST http://127.0.0.1:38721/api/ingest/preview \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "研究一下 https://github.com/langchain-ai/langgraph",
    "source": "web",
    "senderId": "local-user",
    "messageId": "web-001",
    "mode": "preview_only"
  }'
```

确认写入：

```bash
curl -X POST http://127.0.0.1:38721/api/previews/pv_xxx/confirm
```

取消：

```bash
curl -X POST http://127.0.0.1:38721/api/previews/pv_xxx/cancel
```

补充后重生成：

```bash
curl -X POST http://127.0.0.1:38721/api/previews/pv_xxx/regenerate \
  -H 'Content-Type: application/json' \
  -d '{"extraText":"偏自动化和硬件结合方向"}'
```

### 3. 飞书

飞书有两套完全不同的连接方式：长连接模式和公网回调模式。不要把它们混在一起。

#### 3.1 长连接模式

长连接是推荐的本机开发方式。

```bash
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_LONG_CONNECTION_ENABLED=true
```

特点：

- 不需要公网 URL。
- 不需要把 `127.0.0.1` 暴露给飞书。
- ObsidianLink 会用飞书 SDK 主动连到飞书开放平台，事件从这条连接推回本机。
- 适合本机常驻、个人使用、开发调试。
- 如果只是“飞书发消息给机器人，机器人回复预览/文本”，优先用这个。

启动方式：

```bash
npm run service:restart
```

或在控制台“接入通道”里启动飞书长连接。

#### 3.2 公网回调模式

公网回调是飞书开放平台把事件 HTTP POST 到你的服务器。它需要飞书能访问到你的地址。

事件回调：

```text
http://your-public-domain/connectors/feishu/message
```

卡片按钮回调：

```text
http://your-public-domain/connectors/feishu/card
```

必填：

```bash
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_VERIFICATION_TOKEN=
```

特点：

- 需要公网 URL，生产环境通常要求 HTTPS。
- 本机 `127.0.0.1` 不能直接填到飞书开放平台。
- 可以用服务器部署、HTTPS 域名，或内网穿透把本机端口暴露出去。
- 飞书事件订阅 URL 填 `/connectors/feishu/message`。
- 飞书卡片按钮回调 URL 填 `/connectors/feishu/card`。

#### 3.3 两种模式怎么选

```text
只想本机收飞书消息       -> 用长连接，不用公网回调
需要飞书 HTTP 事件订阅    -> 用公网回调
需要交互卡片按钮点击回调  -> 卡片回调必须是公网可访问地址
本机调试卡片按钮          -> 用内网穿透提供公网地址
```

通用公网地址配置：

```bash
CONNECTOR_PUBLIC_BASE_URL=https://your-public-domain
```

注意：

- 长连接接收消息不依赖 `CONNECTOR_PUBLIC_BASE_URL`。
- 卡片按钮点击是平台回调，必须能访问 `CONNECTOR_PUBLIC_BASE_URL`。
- 如果卡片按钮点了没反应，优先检查 `/connectors/feishu/card` 的公网可访问性和 verification token。

### 4. QQ 开放平台 Bot SDK

使用 QQ 开放平台 Bot SDK。

```bash
QQ_BOT_APP_ID=
QQ_BOT_TOKEN=
QQ_BOT_SANDBOX=false
QQ_BOT_SDK_AUTOSTART=true
```

QQ SDK 只负责收发消息，知识理解和写入都走 ObsidianLink 的统一智能体链路。

### 5. 其他平台

项目里保留了统一 Adapter 结构，便于接入：

- Telegram
- 微信公众号/服务号
- 企业微信
- 钉钉
- 通用 Webhook

这些入口的共同原则：

```text
平台 SDK/签名/消息归一化在 Adapter
模型推理、工具调用、预览确认、Obsidian 写入在 Agent
```

## 抖音处理逻辑

抖音链接不一定是 GitHub 项目，也可能是教程、观点、经验、图文知识。

ObsidianLink 会先解析来源类型：

```text
抖音视频
  -> 解析视频地址
  -> 下载临时视频
  -> ffmpeg 抽帧
  -> tesseract OCR
  -> 模型整理视频内容
  -> 预览知识卡/项目卡
  -> 清理临时视频和帧图

抖音图文
  -> 解析图片列表
  -> 下载临时图片
  -> tesseract OCR
  -> 模型总结图文内容
  -> 预览知识卡/项目卡
  -> 清理临时图片
```

如果 OCR 没识别出内容，系统仍会用标题、描述、原始输入和 GitHub 搜索兜底，并在预览里显示 warning。

## GitHub 项目处理逻辑

如果输入是 GitHub URL：

```text
识别 owner/repo
  -> GitHub API 读取仓库信息
  -> 读取 README
  -> 模型生成项目定位、用途、能力、限制
  -> 只写入一张项目卡
```

如果输入只是项目名：

```text
自然语言项目名
  -> GitHub 搜索
  -> 候选 repo
  -> 研究 repo
  -> 生成预览
```

同一个 repo 会使用 `github_repo` 去重，不会重复创建一堆文件。额外应用想法默认只发回聊天窗口，不自动写入 Obsidian，除非用户选择“入库并保存想法”。

## 数据库

运行状态存 SQLite：

```text
data/obsidianlink.sqlite
```

数据库只保存任务和索引，不替代 Obsidian。

主要表：

- `connector_configs`
- `incoming_messages`
- `ingest_jobs`
- `agent_runs`
- `agent_step_logs`
- `tool_calls`
- `previews`
- `vault_files`
- `connector_logs`

## 常用 API

系统：

```text
GET /api/system/health
GET /api/system/status
```

配置：

```text
GET   /api/settings
PATCH /api/settings
POST  /api/settings/test/openai
POST  /api/settings/test/github
POST  /api/settings/test/douyin
POST  /api/settings/test/ocr
```

摄入：

```text
POST /api/ingest/preview
GET  /api/ingest/jobs
GET  /api/ingest/jobs/:jobId
```

预览：

```text
GET  /api/previews
GET  /api/previews/:previewId
POST /api/previews/:previewId/confirm
POST /api/previews/:previewId/cancel
POST /api/previews/:previewId/regenerate
```

Agent：

```text
GET  /api/agent/runs
GET  /api/agent/runs/:runId
GET  /api/agent/runs/:runId/steps
POST /api/agent/runs/:runId/retry
```

Vault：

```text
GET  /api/vault/status
POST /api/vault/init
GET  /api/vault/tree
GET  /api/vault/recent-files
POST /api/vault/check-broken-links
POST /api/vault/search
```

## 验收命令

```bash
npm run typecheck
npm test
npm run build
npm run doctor
```

接口烟测：

```bash
curl http://127.0.0.1:38721/api/system/health
curl -X POST http://127.0.0.1:38721/api/vault/check-broken-links \
  -H 'Content-Type: application/json' \
  -d '{}'
```

## 故障排查

- 服务打不开：`npm run service:status`，再看 `data/obsidianlink.log`。
- 登录自动启动失败：看 `data/launchd.err.log`，确认已经 `npm run build`。
- 模型失败：配置中心测试模型，确认 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`。
- GitHub 失败：配置中心测试 GitHub，确认 token 有效。
- 抖音失败：配置中心传入真实抖音 URL 测试解析接口。
- 视频 OCR 失败：确认 `ffmpeg`、`tesseract`，并确认视频可下载。
- 图文 OCR 失败：确认图片 URL 可访问、tesseract 可用。
- 飞书长连接收不到消息：确认 `FEISHU_LONG_CONNECTION_ENABLED=true`、App ID/App Secret 正确，并在接入页查看长连接状态。
- 飞书公网回调收不到消息：确认公网 URL、事件订阅、verification token。
- 飞书卡片按钮点了没反应：确认卡片回调地址不是 `127.0.0.1`，平台必须能访问 `/connectors/feishu/card`。
- 写入失败：确认 Vault 路径存在且可写。

## 开发说明

主要目录：

```text
src/agent/previewGraph.ts        LangGraph 摄入预览图
src/clients/                     模型、GitHub、抖音、OCR、网页工具
src/connectors/                  飞书、QQ、Webhook 等入口
src/database/                    SQLite migrations 和 repositories
src/obsidian/                    Markdown 生成与 Vault 写入
src/public/                      本地控制台前端
tests/                           单元和集成测试
vendor/langgraphjs/              本地二开的 LangGraph.js 源码
```

开发原则：

- Adapter 只处理平台协议，不写 Obsidian。
- Agent 负责理解、工具调用、预览计划。
- Preview 阶段不直接写入 Vault。
- Confirm 阶段才写入 Obsidian。
- GitHub 项目默认只写一张项目卡。
- 非项目知识默认只写一张主知识卡。
- 额外联想默认只回到聊天，不自动污染知识库。
