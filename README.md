# ObsidianLink

ObsidianLink 是一个以飞书机器人为入口的本地 Obsidian 知识库智能体。你在飞书里发抖音链接、GitHub 链接、网页文章、项目名或开发想法，它会自动判断意图、解析内容、研究项目、生成入库预览；你点确认后，它才写入本地 Obsidian Vault。

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

## 先看这个：飞书场景怎么用

你可以把它理解成一个“飞书里的知识库助手”：

```text
你在飞书发消息
  -> ObsidianLink 先判断这是闲聊、想法、抖音、GitHub、网页还是知识问题
  -> 普通聊天直接文字回复
  -> 需要入库时才发确认卡片
  -> 你点“入库 / 联想 / 入库并联想”
  -> 主知识或主项目写入本地 Obsidian
```

飞书里可以这样用：

| 你发什么 | 它会怎么做 |
|---|---|
| `你好`、`测试` | 普通文字回复，不入库，不发卡片。 |
| 抖音链接 | 解析视频/图文，OCR 画面文字，生成知识预览卡。 |
| GitHub 链接 | 调 GitHub API 研究仓库，只生成一张项目卡预览。 |
| `去 GitHub 找 MinerU 这个项目` | 自动搜索 GitHub，找到最可能的 repo 后给你项目预览。 |
| 一个开发想法 | 先陪你聊清楚，不立即写库。 |
| `保存刚才这个` | 把这轮想法整理成一张想法卡写入 Obsidian。 |
| 点击预览卡的 `入库` | 真正写入本地 Obsidian。 |
| 点击 `生成应用想法` | 只把联想结果发回飞书，不写入 Obsidian。 |

最重要的规则：

```text
没有确认，不写库。
普通聊天，不发卡片。
额外联想，只回飞书，不塞进 Obsidian。
GitHub 项目，默认只写一个项目文件。
```

## 飞书傻瓜式部署

下面按第一次部署的顺序写。照着做，不需要先理解全部代码。

### 第 1 步：准备 4 样东西

| 要准备什么 | 去哪里拿 | 填到哪里 |
|---|---|---|
| Obsidian Vault 路径 | 你的本机 Obsidian 知识库文件夹 | `OBSIDIAN_VAULT_PATH` |
| 模型接口 | 任意 OpenAI 兼容接口，地址必须以 `/v1` 结尾 | `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL` |
| GitHub Token | GitHub 设置里的 Personal Access Token | `GITHUB_TOKEN` |
| 飞书自建应用 | 飞书开放平台创建企业自建应用 | `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_VERIFICATION_TOKEN` |

抖音解析接口默认可以先用：

```bash
DOUYIN_PARSE_API=https://api.bugpk.com/api/douyin?url=
```

### 第 2 步：安装依赖

```bash
git clone https://github.com/520skyincloud/Obsidianlink.git
cd Obsidianlink
npm install
cp .env.example .env
```

如果要识别抖音视频画面和图文图片，安装 OCR 工具：

```bash
brew install ffmpeg tesseract tesseract-lang
```

不装也能跑 GitHub、网页和普通想法；只是视频/图片 OCR 能力会弱。

### 第 3 步：填写 `.env`

最小能跑的飞书配置长这样：

```bash
PORT=38721
OBSIDIAN_VAULT_PATH=/Users/你的用户名/Documents/obsidian/你的Vault

OPENAI_BASE_URL=http://你的模型服务/v1
OPENAI_API_KEY=你的模型密钥
OPENAI_MODEL=gpt-5.5

GITHUB_TOKEN=你的 GitHub Token
DOUYIN_PARSE_API=https://api.bugpk.com/api/douyin?url=

FEISHU_APP_ID=飞书应用 App ID，例如 cli_xxx
FEISHU_APP_SECRET=飞书应用 App Secret
FEISHU_VERIFICATION_TOKEN=飞书事件订阅 Verification Token
FEISHU_ENCRYPT_KEY=如果飞书开了加密就填；没开可以空

FEISHU_LONG_CONNECTION_ENABLED=true
FEISHU_CARD_CALLBACK_ENABLED=true

# 飞书长连接不需要公网地址；这里保留本机地址即可
CONNECTOR_PUBLIC_BASE_URL=http://127.0.0.1:38721
```

这几个最容易填错：

| 参数 | 怎么填才对 |
|---|---|
| `OPENAI_BASE_URL` | 必须是 OpenAI 兼容接口根地址，比如 `http://host:port/v1`，不要填到 `/chat/completions`。 |
| `OPENAI_MODEL` | 填服务端实际支持的模型名。 |
| `OBSIDIAN_VAULT_PATH` | 必须是本机绝对路径，不是 Obsidian 里的相对目录。 |
| `FEISHU_LONG_CONNECTION_ENABLED` | 飞书主链路用长连接，填 `true`。 |
| `CONNECTOR_PUBLIC_BASE_URL` | 长连接不靠公网，先不用管公网穿透。 |

### 第 4 步：飞书后台这样配置

在飞书开放平台创建企业自建应用后，做这些事：

```text
1. 开启机器人能力。
2. 把机器人安装到你的企业，并加到单聊或群聊。
3. 复制 App ID 和 App Secret，填入 .env。
4. 在“事件与回调”里选择“使用长连接接收事件/回调”。
5. 订阅 im.message.receive_v1，用来接收你发给机器人的消息。
6. 订阅 card.action.trigger，用来接收你点击卡片按钮的事件。
7. 如果开启了事件加密，把 Encrypt Key 填到 FEISHU_ENCRYPT_KEY。
8. 给应用开通接收消息、发送消息相关权限，然后发布/安装应用。
```

飞书主链路不需要填公网 URL。  
FRP / 公网回调只是备用模式，先不要混用。

### 第 5 步：启动

```bash
npm run build
npm run service:start
```

看状态：

```bash
npm run service:status
```

正常应该看到：

```text
Health: ok
Vault: exists / writable
Database: ok
Model: 你的模型名
```

打开控制台：

```text
http://127.0.0.1:38721/
```

在“接入通道”里看飞书，正常应该显示：

```text
飞书长连接已连接，正在接收事件。
```

### 第 6 步：飞书里测试

按这个顺序发：

```text
你好
```

应该只收到普通文字回复，不应该出现卡片。

```text
去 GitHub 找 LangGraph 这个项目
```

应该先收到一条普通文字“收到，正在解析”，然后收到项目预览卡。

```text
我有个开发想法，想做一个自动整理抖音技术视频的知识库助手
```

应该进入普通聊天，不应该直接入库。

```text
保存刚才这个
```

这时才会把刚才那轮想法写入 Obsidian。

## 出问题先看这里

| 现象 | 先检查什么 |
|---|---|
| 飞书发消息没回复 | `.env` 里 `FEISHU_LONG_CONNECTION_ENABLED=true`，服务是否重启，飞书后台是否选择长连接。 |
| 卡片按钮点了没反应 | 飞书是否订阅 `card.action.trigger`，接入页长连接是否 running。 |
| 一条消息重复回复 | 不要同时开启长连接和 HTTP webhook 接收同一类事件。 |
| 模型报错 | 控制台“配置”页测试模型；确认 `OPENAI_BASE_URL` 到 `/v1`。 |
| GitHub 找不到项目 | 检查 `GITHUB_TOKEN`，或把项目名说得更完整。 |
| 抖音解析失败 | 检查 `DOUYIN_PARSE_API`，或先用控制台测试真实抖音链接。 |
| 视频没有 OCR | 本机是否安装 `ffmpeg` 和 `tesseract`。 |
| Obsidian 没写入 | 检查 Vault 路径是否存在、是否可写；没有点确认不会写入。 |

## 适合谁

- 经常刷到抖音技术视频、图文教程、GitHub 项目，但转头就忘的人。
- 想把飞书、Telegram、微信、通用 Webhook 等聊天入口变成个人知识库入口的人。
- 想让模型先整理、分类、联想，再由自己确认写入 Obsidian 的人。
- 想用 LangGraph.js 搭一个本地智能体任务系统的人。

## 核心能力

- 多来源摄入：抖音短视频、抖音图文、GitHub 仓库、网页文章、普通想法、项目名称。
- 抖音理解：解析接口拿到标题、作者、aweme_id、视频地址或图片列表。
- 视频 OCR：下载临时视频，ffmpeg 抽帧，tesseract 识别画面文字，处理后清理缓存。
- 图文 OCR：下载抖音图文图片，逐张 OCR，再交给模型总结内容，处理后清理缓存。
- GitHub 研究：通过 GitHub API 获取 repo 描述、README、stars、topics、license、更新时间。
- LangGraph 智能体：按节点记录输入解析、来源路由、工具调用、知识抽取、创意生成、预览计划。
- 预览确认：飞书/网页先给预览卡片，用户选择入库、生成应用想法、入库并联想。
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

### 第一次部署清单

第一次拿到项目时，按这个顺序做：

```text
1. 准备 Obsidian Vault 路径
2. 准备 OpenAI 兼容模型接口
3. 准备 GitHub Token
4. 准备抖音解析接口
5. 安装 OCR 工具
6. 复制 .env.example 为 .env 并填写参数
7. npm install
8. npm run build
9. npm run service:start
10. 打开 http://127.0.0.1:38721/ 做配置测试
11. 再接飞书 / Telegram / 其他聊天入口
```

最小可用配置只需要：

```bash
OBSIDIAN_VAULT_PATH=你的 Obsidian Vault 绝对路径
OPENAI_BASE_URL=OpenAI 兼容接口的 /v1 地址
OPENAI_API_KEY=模型接口密钥
OPENAI_MODEL=模型名
GITHUB_TOKEN=GitHub Personal Access Token
DOUYIN_PARSE_API=https://api.bugpk.com/api/douyin?url=
```

如果只想先跑通 GitHub 链接和普通想法，可以先不装 OCR；如果要处理抖音视频/图文，建议安装 `ffmpeg` 和 `tesseract`。

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

`.env.example` 里列出了全部配置。参数含义如下。

### 基础参数

| 参数 | 是否必填 | 示例 | 含义 |
|---|---:|---|---|
| `PORT` | 否 | `38721` | 本机 HTTP 服务端口。控制台和 API 都跑在这个端口。 |
| `OBSIDIANLINK_DB_PATH` | 否 | `./data/obsidianlink.sqlite` | SQLite 状态库路径。保存消息、任务、预览、日志和写入索引。 |
| `OBSIDIAN_VAULT_PATH` | 是 | `/Users/sky/Documents/obsidian/sky` | Obsidian Vault 根目录。所有 Markdown 只会写入这个目录内。 |
| `CONNECTOR_PUBLIC_BASE_URL` | 视情况 | `https://kb.example.com` | 公网回调基地址。飞书长连接不需要；HTTP webhook 备用模式和其他平台回调才需要。 |

### 模型参数

| 参数 | 是否必填 | 示例 | 含义 |
|---|---:|---|---|
| `OPENAI_BASE_URL` | 是 | `http://your-host/v1` | OpenAI 兼容接口地址，必须到 `/v1`。 |
| `OPENAI_API_KEY` | 是 | `sk-...` | 模型接口密钥。只写在本机 `.env`，不会提交。 |
| `OPENAI_MODEL` | 是 | `gpt-5.5` | 用于分类、摘要、标题、联想的模型名。 |
| `OPENAI_TIMEOUT_MS` | 否 | `60000` | 模型请求超时时间，单位毫秒。 |
| `OPENAI_ALLOW_INSECURE_TLS` | 否 | `false` | 私有模型网关证书异常时才临时设为 `true`。正常不要开。 |

### 内容工具参数

| 参数 | 是否必填 | 示例 | 含义 |
|---|---:|---|---|
| `GITHUB_TOKEN` | 是 | `ghp_...` | 调 GitHub API 研究仓库，避免公开 API 限流。 |
| `DOUYIN_PARSE_API` | 是 | `https://api.bugpk.com/api/douyin?url=` | 抖音解析接口。服务会把抖音链接拼到 `url=` 后面。 |
| `DOUYIN_ALLOW_INSECURE_TLS` | 否 | `false` | 抖音解析站证书链在本机 Node 环境异常时才临时设为 `true`。正常不要开。 |
| `OCR_FRAME_INTERVAL_SECONDS` | 否 | `4` | 视频 OCR 抽帧间隔。越小越细，越慢。 |
| `OCR_MAX_FRAMES` | 否 | `8` | 视频最多抽多少帧；图文最多处理多少张图片。 |
| `OCR_MAX_VIDEO_BYTES` | 否 | `83886080` | 视频下载上限，默认 80MB，避免大文件拖死本机。 |

### 飞书参数

| 参数 | 是否必填 | 示例 | 含义 |
|---|---:|---|---|
| `FEISHU_APP_ID` | 飞书必填 | `cli_xxx` | 飞书应用 App ID。长连接、回调回复、卡片都需要。 |
| `FEISHU_APP_SECRET` | 飞书必填 | `xxx` | 飞书应用 App Secret。用于 SDK 连接和发消息。 |
| `FEISHU_VERIFICATION_TOKEN` | 回调/事件建议填 | `xxx` | 飞书事件订阅和卡片回调校验 token。 |
| `FEISHU_ENCRYPT_KEY` | 可选 | `xxx` | 如果飞书开启事件加密，需要填写。不开加密可以空。 |
| `FEISHU_LONG_CONNECTION_ENABLED` | 长连接必填 | `true` | 是否启用飞书长连接。长连接不需要公网 URL。 |
| `FEISHU_CARD_CALLBACK_ENABLED` | 推荐开启 | `true` | 是否在飞书预览卡里显示可点击按钮。长连接可接收按钮事件；公网卡片回调只是备用。 |

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

#### 3.1 当前推荐接法

如果你是个人本机使用，推荐这样配：

```bash
FEISHU_APP_ID=你的飞书应用 App ID
FEISHU_APP_SECRET=你的飞书应用 App Secret
FEISHU_VERIFICATION_TOKEN=你的事件订阅 Verification Token
FEISHU_LONG_CONNECTION_ENABLED=true
FEISHU_CARD_CALLBACK_ENABLED=true
CONNECTOR_PUBLIC_BASE_URL=http://127.0.0.1:38721
```

这套配置的效果：

```text
飞书消息 / 卡片按钮 -> 飞书长连接 -> 本机 ObsidianLink -> LangGraph 处理 -> 飞书回复卡片/文本
```

它不要求公网地址，适合把收消息、解析、预览、卡片按钮、入库完整跑通。

飞书开放平台侧需要做的事：

```text
1. 创建企业自建应用
2. 开启机器人能力，并把机器人加到单聊或群聊
3. 记录 App ID 和 App Secret，填到 .env
4. 订阅消息事件和卡片按钮事件时选择“使用长连接接收事件”
5. 给应用开通发送消息、接收消息相关权限，并发布/安装应用到当前企业
6. 回到 ObsidianLink 控制台“接入通道”，启动飞书长连接并看状态
```

如果你要改用 HTTP webhook 备用模式，或者某些场景必须让飞书请求你的服务器，再配置公网地址：

```bash
FEISHU_CARD_CALLBACK_ENABLED=true
CONNECTOR_PUBLIC_BASE_URL=https://your-public-domain
```

并在飞书开放平台把卡片回调地址配置为：

```text
https://your-public-domain/connectors/feishu/card
```

推荐组合：

```text
消息接收：飞书长连接，不需要公网
卡片按钮：飞书长连接，不需要公网
公网回调：备用，不和长连接同时接收同一类事件
```

#### 3.2 长连接模式

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
- 飞书发消息、机器人回复文本/预览卡、点击卡片按钮，都优先用这个。
- 飞书机器人必须被拉进会话，且应用需要能接收 `im.message.receive_v1` 消息事件和 `card.action.trigger` 卡片按钮事件。

启动方式：

```bash
npm run service:restart
```

或在控制台“接入通道”里启动飞书长连接。

长连接能处理这些业务：

| 用户在飞书发什么 | 系统怎么处理 |
|---|---|
| `你好` / `help` | 立即回复，不生成知识预览。 |
| 抖音链接 | 解析视频或图文，OCR，模型整理，生成预览卡。 |
| GitHub 链接 | 研究 repo，只计划写一张项目卡。 |
| `去 GitHub 找 LangGraph 这个项目` | 走 GitHub 搜索，定位 repo 后生成项目预览。 |
| 普通网页 URL | 抽取网页正文，生成知识预览。 |
| 开发想法 / 产品点子 | 先正常聊天澄清；明确“保存/入库/记下来”后写入想法。 |
| `状态` | 返回当前待确认/任务状态。 |
| `取消` | 取消最近一个待确认预览。 |
| 点击预览卡按钮 | 长连接接收 `card.action.trigger`，执行入库/联想/入库并联想。 |

#### 3.3 公网回调模式

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

公网回调能处理这些业务：

| 回调地址 | 用途 |
|---|---|
| `/connectors/feishu/message` | 飞书事件订阅，把用户消息 HTTP POST 到 ObsidianLink。 |
| `/connectors/feishu/card` | 飞书卡片按钮点击回调，比如“入库知识/生成应用想法/入库并联想”。 |

注意：如果你已经启用了长连接，通常不需要再配置 `/connectors/feishu/message` 或 `/connectors/feishu/card`，否则同一事件可能被两条通道重复处理。

#### 3.4 两种模式怎么选

```text
只想本机收飞书消息       -> 用长连接，不用公网回调
需要交互卡片按钮点击回调  -> 优先用长连接的 card.action.trigger
需要飞书 HTTP 事件订阅    -> 用公网回调
本机调试 HTTP webhook      -> 用内网穿透提供公网地址
```

通用公网地址配置：

```bash
CONNECTOR_PUBLIC_BASE_URL=https://your-public-domain
```

注意：

- 长连接接收消息和卡片按钮都不依赖 `CONNECTOR_PUBLIC_BASE_URL`。
- `CONNECTOR_PUBLIC_BASE_URL` 只给 HTTP webhook 备用模式使用。
- 如果卡片按钮点了没反应，长连接模式优先检查 `card.action.trigger` 是否订阅到了长连接，以及接入页长连接是否运行中。
- 同一时间不要同时让长连接和 HTTP 事件回调接收同一类事件，除非你确认消息幂等和去重配置没有问题。

#### 3.5 飞书预览卡业务

当输入被判断为“来源摄入”时，飞书会先收到一条“已收到/处理中”的反馈；处理完成后会收到预览卡。

项目类预览按钮：

| 按钮/文字回复 | 行为 |
|---|---|
| `只入库` | 只写一张项目卡到 Obsidian。 |
| `只联想` | 不写文件，只把应用想法发回飞书。 |
| `入库并联想` | 写主项目卡；联想只发回飞书，不额外写想法文件。 |

知识类预览按钮：

| 按钮/文字回复 | 行为 |
|---|---|
| `入库知识` | 只写一张主知识卡。 |
| `生成应用想法` | 不写文件，只把可组合方向发回飞书。 |
| `入库并联想` | 写主知识卡；联想只发回飞书。 |

如果 `FEISHU_CARD_CALLBACK_ENABLED=false`，预览卡不会显示按钮，而是提示你直接在飞书里回复上面的文字。

如果 `FEISHU_CARD_CALLBACK_ENABLED=true`，长连接模式下需要在飞书开放平台把 `card.action.trigger` 事件订阅到长连接。只有 HTTP webhook 备用模式才需要保证：

```text
CONNECTOR_PUBLIC_BASE_URL + /connectors/feishu/card
```

可以被飞书开放平台访问。

### 4. 其他平台

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

同一个 repo 会使用 `github_repo` 去重，不会重复创建一堆文件。额外应用想法默认只发回聊天窗口，不自动写入 Obsidian；即使选择“入库并联想”，也只写主项目卡，联想只发回飞书。

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
- 飞书卡片按钮点了没反应：长连接模式优先确认飞书开放平台已订阅 `card.action.trigger`，接入页显示长连接运行中；只有 webhook 备用模式才检查 `/connectors/feishu/card` 公网可访问。
- 写入失败：确认 Vault 路径存在且可写。

## 开发说明

主要目录：

```text
src/agent/previewGraph.ts        LangGraph 摄入预览图
src/clients/                     模型、GitHub、抖音、OCR、网页工具
src/connectors/                  飞书、Telegram、Webhook 等入口
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
