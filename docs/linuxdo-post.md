# LinuxDo 分享帖：ObsidianLink，本地 Obsidian 知识库智能体

标题建议：

```text
开源一个我自己用的 Obsidian 知识库智能体：飞书里发抖音/GitHub/想法，确认后自动入库
```

正文：

大家好，我最近做了一个自己用的小工具，叫 **ObsidianLink**。

一句话介绍：**它是一个本地运行的 Obsidian 知识库智能体。你在飞书里发抖音链接、GitHub 项目、网页文章或开发想法，它会自动解析、研究、整理成预览卡片，等你确认后再写入本地 Obsidian。**

项目地址：

```text
https://github.com/520skyincloud/Obsidianlink
```

## 我为什么做这个

我平时经常刷到一些技术内容：

- 抖音上的开源项目介绍
- GitHub 上看到的工具
- 别人分享的产品想法
- 一些开发经验、教程、踩坑
- 自己突然冒出来的灵感

问题是这些东西当时觉得很有用，但刷完很快就忘了。手动整理到 Obsidian 又太麻烦，打开软件、建标题、分类、写摘要、贴链接，整个动作太重，最后就变成“收藏夹吃灰”。

所以我想做一个更自然的入口：**像聊天一样把东西丢给机器人，它自动研究，自动整理，但最后要不要写入由我确认。**

## 它现在能做什么

目前 v0.1.0 的核心链路是：

```text
飞书消息
  -> 本地 ObsidianLink 智能体
  -> 意图识别
  -> 抖音 / GitHub / 网页 / 想法解析
  -> 生成预览卡片
  -> 用户确认
  -> 写入本地 Obsidian Markdown
```

支持这些输入：

| 输入 | 行为 |
|---|---|
| `你好`、`测试` | 普通聊天，不发卡片，不写库 |
| 抖音链接 | 调解析接口，视频抽帧/OCR 或图文识别，生成知识预览 |
| GitHub 链接 | 调 GitHub API 研究仓库，生成一个项目卡 |
| `去 GitHub 找 Docling` | 搜索 GitHub 项目并整理 |
| 网页链接 | 抽正文并生成知识卡 |
| 开发想法 | 先陪聊澄清，不立刻入库 |
| `保存刚才这个` | 把这一轮想法整理进 Obsidian |
| 卡片按钮 `入库` | 写入 Obsidian |
| 卡片按钮 `生成应用想法` | 只回飞书，不写入 Obsidian |

## 几个我比较在意的设计

### 1. 本地优先

Obsidian Markdown 是最终知识库，SQLite 只保存运行状态、任务日志、预览和去重索引。没有云数据库，也不替代 Obsidian。

### 2. 飞书优先用长连接

飞书这块我现在主推长连接，不要求你必须有公网 webhook。普通消息和卡片按钮事件都可以通过长连接进入本机智能体。公网 FRP 只是备用模式。

### 3. 不自动乱写库

我最怕 AI 把知识库写成垃圾场。所以现在默认是：

- 闲聊不写库
- 想法先聊清楚再写
- 链接内容先生成预览
- 只有你点确认才写入 Obsidian
- 取消后会清理待确认记录

### 4. GitHub 项目只写一个主文件

之前我踩过坑，一个 GitHub 项目自动生成一堆知识卡、想法卡，知识库会很乱。现在策略是：**GitHub 项目默认只写一个项目文件**，联想和组合方向只发回飞书，除非你明确保存。

### 5. 抖音不只当项目解析

抖音链接可能是开源项目，也可能是教程、观点、案例、产品洞察。现在会先判断内容类型，再决定生成项目卡还是知识卡。

## 桌面端

这次 release 里放了一个 macOS Apple Silicon 的 DMG：

```text
ObsidianLink-0.1.0-arm64.dmg
```

打开后是一个本地桌面壳，里面可以看：

- 助手对话
- 待确认队列
- 知识库最近写入
- 配置和连接状态
- 飞书长连接状态

目前包是本地 ad-hoc 签名，还没有 Apple Developer ID 公证。第一次打开如果被 macOS 拦，可以右键打开。

## 部署方式

如果你直接用源码跑：

```bash
git clone https://github.com/520skyincloud/Obsidianlink.git
cd Obsidianlink
npm install
cp .env.example .env
npm run build
npm run service:start
```

macOS 上做 OCR 建议装：

```bash
brew install ffmpeg tesseract tesseract-lang
```

`.env` 里主要填：

```text
OBSIDIAN_VAULT_PATH=你的 Obsidian Vault 绝对路径
OPENAI_BASE_URL=OpenAI 兼容接口 /v1 地址
OPENAI_API_KEY=模型密钥
OPENAI_MODEL=模型名
GITHUB_TOKEN=GitHub Token
DOUYIN_PARSE_API=抖音解析接口

FEISHU_APP_ID=飞书 App ID
FEISHU_APP_SECRET=飞书 App Secret
FEISHU_VERIFICATION_TOKEN=飞书 Verification Token
FEISHU_ENCRYPT_KEY=可选
FEISHU_LONG_CONNECTION_ENABLED=true
FEISHU_CARD_CALLBACK_ENABLED=true
```

飞书后台需要：

```text
1. 开启机器人能力
2. 安装应用到企业
3. 事件订阅选择长连接
4. 订阅 im.message.receive_v1
5. 订阅 card.action.trigger
6. 开通发送消息、接收消息相关权限
```

## 目前还不完美

老实说，这还是 v0.1.0，有些地方还会继续改：

- UI 还可以继续变简单
- Windows/Linux 桌面包还没做
- Apple Developer ID 签名和公证还没做
- 更多聊天入口，比如微信/Telegram/企业微信，可以继续扩展
- 本地向量检索/RAG 目前没有内置成重功能，主要依赖 Obsidian 本身和结构化 Markdown

## 我希望它最终变成什么

我希望它不是“又一个剪藏工具”，而是一个真正的个人知识智能体：

```text
随手发给它
它能判断是不是知识
能研究项目
能理解视频
能和我把想法聊清楚
能知道哪些该入库，哪些只是闲聊
最后把有价值的东西变成 Obsidian 里可长期使用的 Markdown
```

欢迎大家试试，也欢迎提 issue 或 PR。尤其想听听大家对“个人知识库入口”和“AI 自动整理但不污染知识库”这两个方向的看法。

