# ObsidianLink v0.1.0

ObsidianLink 是一个本地运行的 Obsidian 知识库智能体：你在飞书里发送抖音链接、GitHub 项目、网页文章或开发想法，它会自动解析、研究、生成确认卡片，并在你确认后写入本地 Obsidian Vault。

## 这一版适合谁

- 平时刷到技术视频、开源项目、文章和灵感，但经常忘记整理的人。
- 使用 Obsidian 做本地知识库，希望保留 Markdown 主权的人。
- 想把飞书机器人当成随手输入入口的人。
- 想要“先预览，再确认入库”，不希望 AI 乱写知识库的人。

## v0.1.0 主要能力

- 飞书长连接接入：普通消息和卡片按钮都走长连接，不依赖公网 webhook。
- 本地桌面端：提供 macOS DMG，打开后启动本地服务和控制台。
- 智能意图识别：闲聊只回复，链接/项目/知识才进入预览，想法会先陪聊澄清。
- GitHub 研究：支持 GitHub 链接和“去 GitHub 找某某项目”。
- 抖音解析：支持抖音视频/图文解析，视频抽帧 OCR 后生成知识预览。
- Obsidian 写入：确认后写入本地 Vault，取消会清理待确认记录。
- 待确认队列：支持单条入库、单条取消、批量取消和清空待确认。
- 失败兜底：过期卡片、缺失 preview、连接失败等都会返回可读提示。

## 下载

- `ObsidianLink-0.1.0-arm64.dmg`

这是 macOS Apple Silicon 版本。当前包使用本地 ad-hoc 签名，未做 Apple Developer ID 公证；首次打开时如被 Gatekeeper 拦截，可右键打开。正式分发前建议自行签名和 notarize。

## 首次使用

1. 安装 DMG。
2. 打开 ObsidianLink。
3. 在设置页填写：
   - Obsidian Vault 路径
   - OpenAI 兼容接口地址、密钥和模型名
   - GitHub Token
   - 抖音解析 API
   - 飞书 App ID、App Secret、Verification Token、Encrypt Key
4. 飞书开放平台启用机器人能力，事件订阅选择长连接。
5. 订阅：
   - `im.message.receive_v1`
   - `card.action.trigger`
6. 在飞书里给机器人发送：
   - `你好`
   - `去 GitHub 找 LangGraph 这个项目`
   - 一个抖音链接
   - 一个开发想法，然后说 `保存刚才这个`

## 重要说明

- Obsidian Markdown 是最终知识库。
- SQLite 只保存任务状态、预览、日志和去重索引。
- 飞书推荐长连接模式；公网 webhook 只是备用。
- 默认不会把 AI 联想写入 Obsidian，除非你明确确认入库。
- 密钥不会被写进仓库，也不会打进 DMG。

## 验证

发布前已通过：

- `npm run build`
- `npm run test`：17 个测试文件，92 个用例
- `hdiutil verify dist/ObsidianLink-0.1.0-arm64.dmg`

