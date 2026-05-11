# ObsidianLink

本机优先的个人知识摄入智能体。你把抖音链接、GitHub 链接、网页文章、项目名或自然语言想法发进来，系统会解析、研究、分类、联想，生成可确认预览，确认后写入本地 Obsidian Vault。

默认 Vault：

```text
/Users/sky/Documents/obsidian/sky
```

默认控制台：

```text
http://127.0.0.1:38721/
```

## 当前能力

- LangGraph.js 智能体流水线：解析输入、来源路由、工具调用、知识抽取、创意生成、写入计划。
- SQLite 运行状态：消息、job、run、step logs、tool calls、preview、vault_files。
- 内容工具：GitHub API、抖音解析、视频抽帧 OCR、网页正文抽取、普通文本理解。
- Obsidian 写入：预览确认、目录初始化、去重、合并追加、双链、断链检查。
- 接入通道：网页调试、通用 Webhook、飞书长连接/回调、QQ 开放平台 Bot SDK、Telegram、微信公众号、企业微信、钉钉。
- 控制台：聊天测试、接入配置、运行日志、工具调用、重试运行、Vault 检查、配置测试。

## 快速启动

```bash
npm install
cp .env.example .env
npm run build
npm run service:start
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

## 必填配置

`.env` 至少填写：

```bash
OBSIDIAN_VAULT_PATH=/Users/sky/Documents/obsidian/sky
OPENAI_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4
OPENAI_API_KEY=...
OPENAI_MODEL=GLM-5.1
GITHUB_TOKEN=...
DOUYIN_PARSE_API=https://api.bugpk.com/api/douyin?url=
```

OCR 需要本机工具：

```bash
brew install ffmpeg tesseract tesseract-lang
```

缺 OCR 时系统仍会用原始文本、抖音描述、网页正文和 GitHub 信息兜底。

## 常用入口

### 本机控制台

打开：

```text
http://127.0.0.1:38721/
```

推荐调试顺序：

1. 配置中心：测试模型、GitHub、抖音、ffmpeg、tesseract。
2. 智能体首页：粘贴链接或想法，先生成预览。
3. 处理结果：确认写入、取消或补充后重生成。
4. 运行日志：查看每个 LangGraph 节点和 tool call。
5. Vault 页面：检查目录、最近写入计划、双链断链。

### HTTP 预览

```bash
curl -X POST http://127.0.0.1:38721/api/ingest/preview \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "研究一下 https://github.com/langchain-ai/langgraph",
    "source": "web",
    "senderId": "sky",
    "messageId": "web-001"
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

## 平台接入

所有平台都只是消息入口，核心逻辑统一进入：

```text
Connector Adapter -> Ingest Job -> LangGraph Agent -> Preview -> Confirm -> Obsidian
```

### 飞书

- Webhook 模式：配置飞书事件订阅回调 URL。
- 长连接模式：设置 `FEISHU_LONG_CONNECTION_ENABLED=true`，然后在接入页启动，或重启服务。
- 必填：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_VERIFICATION_TOKEN`。

### QQ 开放平台 Bot SDK

- 使用 QQ 开放平台 Bot SDK，不再走 OpenClaw。
- 必填：`QQ_BOT_APP_ID`、`QQ_BOT_TOKEN`。
- 本机自动启动 SDK session：`QQ_BOT_SDK_AUTOSTART=true`。

### Telegram / 微信 / 企业微信 / 钉钉

- 本机 `127.0.0.1` 只能做模拟。
- 真实平台回调需要 `CONNECTOR_PUBLIC_BASE_URL` 是 HTTPS 公网地址，或使用内网穿透。
- 接入页会显示每个平台真实配置状态，不会把本机地址误判成公网可用。

## Obsidian 目录

当前目录按个人知识库使用方式组织：

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

目录放类型，主题放 frontmatter：

```yaml
domains: ["AI智能体", "自动化", "知识管理"]
content_kind: method
source_type: douyin
entities: ["LangGraph", "飞书长连接"]
```

## 数据与日志

```text
data/obsidianlink.sqlite      SQLite 状态库
data/obsidianlink.pid         常驻服务 PID
data/obsidianlink.log         常驻服务日志
data/launchd.out.log          LaunchAgent 标准输出
data/launchd.err.log          LaunchAgent 错误日志
```

数据库只保存运行状态和索引，Obsidian Markdown 才是最终知识库。

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
curl -X POST http://127.0.0.1:38721/api/vault/check-broken-links -H 'Content-Type: application/json' -d '{}'
```

## 故障排查

- 服务打不开：`npm run service:status`，再看 `data/obsidianlink.log`。
- 登录自动启动失败：看 `data/launchd.err.log`，确认已经 `npm run build`。
- 模型失败：配置中心测试模型，确认 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`。
- GitHub 失败：配置中心测试 GitHub，确认 token 有效。
- 抖音失败：配置中心传入真实抖音 URL 测试解析接口。
- OCR 无结果：检查 `ffmpeg`、`tesseract`，并确认视频可下载。
- 平台收不到消息：确认公网 HTTPS 回调、平台签名/token、接入页最近错误。
- 写入失败：确认 Vault 路径存在且可写。
