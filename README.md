# ObsidianLink

一句话：ObsidianLink 是一个把飞书聊天里的抖音链接、GitHub 项目、网页文章和开发想法自动整理进本地 Obsidian 知识库的 AI 智能体。

它的核心用法很简单：

```text
你在飞书发消息
  -> ObsidianLink 判断意图
  -> 解析抖音 / GitHub / 网页 / 想法
  -> 需要入库时发确认卡片
  -> 你确认后写入本地 Obsidian Vault
```

默认控制台：

```text
http://127.0.0.1:38721/
```

默认知识库路径示例：

```text
/Users/sky/Documents/obsidian/sky
```

## 给 AI 看的：一键部署教程

如果你是 Cursor、Codex、Claude Code、Gemini CLI 或其他 AI 编程助手，请按本节执行。目标是帮用户把项目部署成本机常驻服务，并接入飞书长连接。

### 0. 执行原则

```text
不要猜密钥。
不要把密钥写进 README、日志、截图或 Git 提交。
不要提交 .env、data、日志、缓存、视频、图片。
飞书优先使用长连接，不默认启用 HTTP 公网回调。
每一步都要真实验证，不要只说“应该可以”。
```

### 1. 先向用户要这些参数

| 参数 | 必填 | 填什么 | 示例 |
|---|---:|---|---|
| `OBSIDIAN_VAULT_PATH` | 是 | 本机 Obsidian Vault 绝对路径 | `/Users/sky/Documents/obsidian/sky` |
| `OPENAI_BASE_URL` | 是 | OpenAI 兼容接口地址，必须到 `/v1` | `http://your-openai-compatible-host/v1` |
| `OPENAI_API_KEY` | 是 | 模型接口密钥 | `sk-...` |
| `OPENAI_MODEL` | 是 | 模型名 | `gpt-5.5` |
| `GITHUB_TOKEN` | 是 | GitHub Personal Access Token | `ghp_...` |
| `DOUYIN_PARSE_API` | 建议 | 抖音解析接口 | `https://api.bugpk.com/api/douyin?url=` |
| `FEISHU_APP_ID` | 飞书必填 | 飞书企业自建应用 App ID | `cli_xxx` |
| `FEISHU_APP_SECRET` | 飞书必填 | 飞书应用 App Secret | `xxx` |
| `FEISHU_VERIFICATION_TOKEN` | 飞书建议 | 飞书事件订阅 Verification Token | `xxx` |
| `FEISHU_ENCRYPT_KEY` | 可选 | 飞书事件加密 Encrypt Key；没开加密可空 | `xxx` |

用户不知道参数时，告诉他：

```text
GitHub Token：GitHub -> Settings -> Developer settings -> Personal access tokens。
飞书 App ID/App Secret：飞书开放平台 -> 企业自建应用 -> 凭证与基础信息。
Verification Token / Encrypt Key：飞书开放平台 -> 事件与回调。
```

### 2. 拉代码并安装

```bash
git clone https://github.com/520skyincloud/Obsidianlink.git
cd Obsidianlink
npm install
cp .env.example .env
```

如果用户要识别抖音视频画面或图文图片，在 macOS 上安装：

```bash
brew install ffmpeg tesseract tesseract-lang
```

### 3. 写入 `.env`

把下面内容写进 `.env`，把所有 `替换为...` 改成用户真实参数：

```bash
PORT=38721
OBSIDIANLINK_DB_PATH=./data/obsidianlink.sqlite
OBSIDIAN_VAULT_PATH=替换为用户的 Obsidian Vault 绝对路径

OPENAI_BASE_URL=替换为 OpenAI 兼容接口 /v1 地址
OPENAI_API_KEY=替换为模型密钥
OPENAI_MODEL=替换为模型名
OPENAI_TIMEOUT_MS=60000
OPENAI_ALLOW_INSECURE_TLS=false

GITHUB_TOKEN=替换为 GitHub Token

DOUYIN_PARSE_API=https://api.bugpk.com/api/douyin?url=
DOUYIN_ALLOW_INSECURE_TLS=false
OCR_FRAME_INTERVAL_SECONDS=4
OCR_MAX_FRAMES=8
OCR_MAX_VIDEO_BYTES=83886080

FEISHU_APP_ID=替换为飞书 App ID
FEISHU_APP_SECRET=替换为飞书 App Secret
FEISHU_VERIFICATION_TOKEN=替换为飞书 Verification Token
FEISHU_ENCRYPT_KEY=
FEISHU_LONG_CONNECTION_ENABLED=true
FEISHU_CARD_CALLBACK_ENABLED=true

# 飞书长连接不需要公网地址；HTTP webhook 备用模式才需要公网。
CONNECTOR_PUBLIC_BASE_URL=http://127.0.0.1:38721
```

最容易填错的地方：

| 参数 | 正确写法 |
|---|---|
| `OPENAI_BASE_URL` | 填接口根地址，例如 `http://host:port/v1`，不要填到 `/chat/completions`。 |
| `OBSIDIAN_VAULT_PATH` | 必须是本机绝对路径。 |
| `FEISHU_LONG_CONNECTION_ENABLED` | 飞书主链路必须是 `true`。 |
| `CONNECTOR_PUBLIC_BASE_URL` | 长连接不依赖公网，先保留本机地址即可。 |

### 4. 指导用户配置飞书后台

在飞书开放平台创建企业自建应用，然后让用户完成：

```text
1. 开启机器人能力。
2. 安装应用到当前企业。
3. 把机器人加入单聊或群聊。
4. 在“事件与回调”里选择“使用长连接接收事件/回调”。
5. 订阅 im.message.receive_v1。
6. 订阅 card.action.trigger。
7. 如果开启事件加密，把 Encrypt Key 填进 .env。
8. 开通接收消息、发送消息相关权限。
9. 发布应用。
```

重点：

```text
飞书主链路用长连接。
不需要 FRP。
不需要公网域名。
不要把 127.0.0.1 填到飞书回调地址。
不要同时用长连接和 HTTP webhook 接收同一类事件。
```

### 5. 启动并验证

```bash
npm run build
npm run service:restart
npm run service:status
```

本机健康检查：

```bash
curl -s http://127.0.0.1:38721/api/system/health
```

飞书长连接检查：

```bash
curl -s http://127.0.0.1:38721/api/connectors | node -e '
let s="";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  const j = JSON.parse(s);
  const f = j.connectors.find(c => c.source === "feishu");
  console.log(JSON.stringify({
    configured: f?.setupStatus?.configured,
    enabled: f?.enabled,
    longConnection: f?.longConnection,
    notes: f?.setupStatus?.notes
  }, null, 2));
});
'
```

成功时应该看到：

```text
"enabled": true
"running": true
"飞书长连接已连接，正在接收事件。"
```

### 6. 让用户在飞书里做验收

按顺序发送：

```text
你好
```

预期：普通文字回复，不发卡片，不入库。

```text
去 GitHub 找 LangGraph 这个项目
```

预期：先收到普通文字“收到，正在解析”，然后收到项目预览卡。

```text
我有个开发想法，想做一个自动整理抖音技术视频的知识库助手
```

预期：进入普通聊天澄清，不直接写入 Obsidian。

```text
保存刚才这个
```

预期：把刚才那轮想法整理成一张想法卡，写入 Obsidian。

AI 的最终验收标准：

```text
npm run build 通过
npm run service:status 显示 Health ok
/api/system/health 显示 vault writable、database ok、model configured
/api/connectors 显示 feishu.longConnection.running=true
飞书发送“你好”不会出卡片
飞书发送 GitHub 项目名会生成预览卡
点击预览卡按钮后能收到处理结果
Obsidian Vault 内出现对应 Markdown 文件
```

如果任何一步失败，先看：

```text
data/obsidianlink.log
```

不要在失败时告诉用户“部署完成”。

## 这个项目解决什么问题

你平时在抖音、网页、GitHub、聊天里看到很多有价值的信息，但它们通常会散掉。ObsidianLink 做的事情是：让你把这些内容直接发给飞书机器人，由本机 AI 自动解析、整理、判断是否值得入库，然后在你确认后写成 Obsidian Markdown。

它不是云笔记，也不替代 Obsidian。Obsidian 仍然是最终知识库，SQLite 只保存运行状态、任务日志、预览和去重索引。

## 它会怎么判断消息

| 你在飞书发什么 | 系统行为 |
|---|---|
| `你好`、`测试`、普通闲聊 | 直接文字回复，不发卡片，不写库。 |
| 抖音链接 | 解析视频或图文，抽帧/OCR，生成知识预览卡。 |
| GitHub 链接 | 调 GitHub API 研究仓库，只生成一张项目卡预览。 |
| `去 GitHub 找 MinerU 这个项目` | 搜索 GitHub，定位 repo 后生成项目预览卡。 |
| 网页链接 | 抽取网页正文，生成知识预览。 |
| 开发想法、产品点子 | 先聊天澄清，不立即写库。 |
| `保存刚才这个` | 保存当前想法会话到 Obsidian。 |
| `状态` | 查询当前任务或待确认预览。 |
| `取消` | 取消最近一个待确认预览。 |

核心规则：

```text
没有确认，不写库。
普通聊天，不发卡片。
额外联想，只回飞书，不塞进 Obsidian。
GitHub 项目，默认只写一个项目文件。
```

## 系统怎么工作

```text
飞书 / Web 控制台
  -> Connector Adapter
  -> Ingest Job
  -> LangGraph Agent
  -> Tool Calls
  -> Preview Draft
  -> User Decision
  -> Obsidian Vault Commit
```

主要能力：

- 飞书长连接：接收普通消息和卡片按钮事件。
- 意图识别：区分闲聊、来源摄入、GitHub 项目搜索、想法陪聊、保存想法、知识问答。
- 抖音解析：支持视频和图文，视频会临时下载、抽帧 OCR，处理后清理缓存。
- GitHub 研究：用 GitHub API 获取 repo 描述、README、stars、topics、license、更新时间。
- LangGraph 智能体：按节点记录解析、路由、工具调用、知识抽取、预览计划。
- Obsidian 写入：只写主项目、主知识或明确保存的想法。
- SQLite 状态库：保存消息、job、run、step logs、tool calls、previews、vault_files。
- 本地控制台：查看对话、接入通道、预览确认、流水线、Vault 和配置状态。

## 普通用户部署教程

### 1. 准备环境

需要：

- Node.js 20+
- macOS 或 Linux
- 一个 Obsidian Vault
- OpenAI 兼容模型接口
- GitHub Token
- 飞书企业自建应用
- 可选：`ffmpeg`、`tesseract`，用于抖音视频/图文 OCR

### 2. 下载项目

```bash
git clone https://github.com/520skyincloud/Obsidianlink.git
cd Obsidianlink
npm install
cp .env.example .env
```

### 3. 填写 `.env`

最小可用配置：

```bash
OBSIDIAN_VAULT_PATH=/Users/你的用户名/Documents/obsidian/你的Vault
OPENAI_BASE_URL=http://your-openai-compatible-host/v1
OPENAI_API_KEY=your_model_key
OPENAI_MODEL=gpt-5.5
GITHUB_TOKEN=your_github_token
DOUYIN_PARSE_API=https://api.bugpk.com/api/douyin?url=

FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=your_feishu_app_secret
FEISHU_VERIFICATION_TOKEN=your_feishu_verification_token
FEISHU_ENCRYPT_KEY=
FEISHU_LONG_CONNECTION_ENABLED=true
FEISHU_CARD_CALLBACK_ENABLED=true
CONNECTOR_PUBLIC_BASE_URL=http://127.0.0.1:38721
```

如果要处理抖音视频和图文：

```bash
brew install ffmpeg tesseract tesseract-lang
```

### 4. 配置飞书

飞书开放平台里做这些：

```text
1. 创建企业自建应用。
2. 开启机器人能力。
3. 安装应用到你的企业。
4. 把机器人拉进单聊或群聊。
5. 事件订阅方式选择“使用长连接接收事件/回调”。
6. 订阅 im.message.receive_v1。
7. 订阅 card.action.trigger。
8. 开通发送消息、接收消息权限。
9. 发布应用。
```

飞书长连接不需要公网地址。只有你主动改用 HTTP webhook 备用模式时，才需要公网域名或内网穿透。

### 5. 启动服务

```bash
npm run build
npm run service:start
```

查看状态：

```bash
npm run service:status
```

打开控制台：

```text
http://127.0.0.1:38721/
```

停止服务：

```bash
npm run service:stop
```

重启服务：

```bash
npm run service:restart
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

## 飞书里怎么用

### 普通聊天

```text
你好
测试
你现在能干嘛？
```

系统只会普通文字回复，不会入库。

### GitHub 项目

```text
去 GitHub 找 MinerU 这个项目
```

或：

```text
https://github.com/langchain-ai/langgraph
```

系统会研究项目，然后发一张预览卡。你可以点：

| 按钮 | 行为 |
|---|---|
| `只入库` | 只写一张项目卡。 |
| `只联想` | 不写文件，只把应用想法发回飞书。 |
| `入库并联想` | 写主项目卡，联想只发回飞书。 |

### 抖音和网页

```text
这个抖音视频整理一下：https://v.douyin.com/xxxx/
```

系统会解析视频或图文，尽量提取标题、作者、描述、图片、视频 OCR 和画面里的项目名/网址，再生成知识预览卡。

### 开发想法

```text
我有个开发想法，想做一个自动整理抖音技术视频的知识库助手
```

系统会先陪你聊清楚，不会立刻写入。

当你说：

```text
保存刚才这个
```

系统才把这轮想法写进 Obsidian。

## Obsidian 写入规则

目录：

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

规则：

- GitHub 项目写入 `1_项目/0_开源项目`。
- 普通知识写入 `2_知识`。
- 明确保存的想法写入 `4_想法`。
- 低置信度或缺信息内容进入 `0_收件箱`。
- 主题放进 frontmatter 的 `domains`、`tags`、`entities`，不靠无限嵌套目录。
- 同一个 GitHub repo 用 `github_repo` 去重，不重复创建一堆文件。
- 联想内容默认只发回飞书，不额外写进 Obsidian。

GitHub 项目文件标题会尽量用：

```text
英文项目名 - 中文用途摘要
```

例如：

```text
langgraph - 多智能体工作流编排框架
MinerU - 文档解析与结构化提取工具
```

## 控制台页面

打开：

```text
http://127.0.0.1:38721/
```

页面用途：

| 页面 | 用途 |
|---|---|
| 今日摄入 | 看今天处理了什么、有没有失败或待确认。 |
| 对话测试 | 不通过飞书，直接在网页里测试意图和预览。 |
| 接入通道 | 看飞书长连接、配置字段和平台事件。 |
| 预览确认 | 查看待确认内容和将写入的文件。 |
| 处理流水线 | 看 LangGraph 节点、工具调用和错误。 |
| 知识库 | 看 Vault 状态、最近写入和目录树。 |
| 配置 | 测试模型、GitHub、抖音解析、OCR 工具。 |

## 参数说明

### 基础参数

| 参数 | 必填 | 含义 |
|---|---:|---|
| `PORT` | 否 | 本机服务端口，默认 `38721`。 |
| `OBSIDIANLINK_DB_PATH` | 否 | SQLite 状态库路径，默认 `./data/obsidianlink.sqlite`。 |
| `OBSIDIAN_VAULT_PATH` | 是 | Obsidian Vault 根目录。 |
| `CONNECTOR_PUBLIC_BASE_URL` | 视情况 | HTTP webhook 备用模式才需要公网地址；飞书长连接不需要。 |

### 模型参数

| 参数 | 必填 | 含义 |
|---|---:|---|
| `OPENAI_BASE_URL` | 是 | OpenAI 兼容接口地址，必须到 `/v1`。 |
| `OPENAI_API_KEY` | 是 | 模型接口密钥。 |
| `OPENAI_MODEL` | 是 | 模型名。 |
| `OPENAI_TIMEOUT_MS` | 否 | 模型请求超时时间，默认 `60000`。 |
| `OPENAI_ALLOW_INSECURE_TLS` | 否 | 私有模型网关证书异常时才设为 `true`。 |

### 内容工具参数

| 参数 | 必填 | 含义 |
|---|---:|---|
| `GITHUB_TOKEN` | 是 | 调 GitHub API，避免公开 API 限流。 |
| `DOUYIN_PARSE_API` | 是 | 抖音解析接口。 |
| `DOUYIN_ALLOW_INSECURE_TLS` | 否 | 抖音解析站证书异常时才设为 `true`。 |
| `OCR_FRAME_INTERVAL_SECONDS` | 否 | 视频 OCR 抽帧间隔。 |
| `OCR_MAX_FRAMES` | 否 | 视频/图文最多 OCR 帧数或图片数。 |
| `OCR_MAX_VIDEO_BYTES` | 否 | 视频下载大小上限。 |

### 飞书参数

| 参数 | 必填 | 含义 |
|---|---:|---|
| `FEISHU_APP_ID` | 是 | 飞书应用 App ID。 |
| `FEISHU_APP_SECRET` | 是 | 飞书应用 App Secret。 |
| `FEISHU_VERIFICATION_TOKEN` | 建议 | 飞书事件订阅 Verification Token。 |
| `FEISHU_ENCRYPT_KEY` | 可选 | 飞书事件加密 Encrypt Key。 |
| `FEISHU_LONG_CONNECTION_ENABLED` | 是 | 使用飞书长连接时填 `true`。 |
| `FEISHU_CARD_CALLBACK_ENABLED` | 建议 | 是否在预览卡里显示可点击按钮。 |

## 排错

| 现象 | 先检查 |
|---|---|
| 飞书发消息没回复 | `FEISHU_LONG_CONNECTION_ENABLED=true`、服务已重启、飞书后台选择长连接、机器人已进会话。 |
| 卡片按钮点了没反应 | 飞书是否订阅 `card.action.trigger`，控制台接入页是否显示长连接 running。 |
| 重复回复 | 不要同时用长连接和 HTTP webhook 接收同一类事件。 |
| 模型失败 | 控制台配置页测试模型，确认 `OPENAI_BASE_URL` 到 `/v1`。 |
| GitHub 找不到项目 | 检查 `GITHUB_TOKEN`，或把项目名说完整。 |
| 抖音解析失败 | 检查 `DOUYIN_PARSE_API`，用控制台测试真实抖音链接。 |
| OCR 没结果 | 安装 `ffmpeg`、`tesseract`、`tesseract-lang`。 |
| Obsidian 没写入 | 需要先点确认；再检查 Vault 路径是否存在且可写。 |

查看日志：

```bash
tail -f data/obsidianlink.log
```

## 开发命令

```bash
npm run dev
npm run build
npm run typecheck
npm test
```

## 安全说明

- `.env` 不提交。
- 数据库、日志、视频缓存、图片缓存不提交。
- 前端不回显密钥明文。
- 视频和图片只用于临时 OCR，处理后清理。
- 飞书主链路默认长连接，不要求公网暴露本机服务。

## 当前定位

ObsidianLink 当前重点优化飞书场景。其他平台 Adapter 可以继续扩展，但飞书长连接是主入口。
