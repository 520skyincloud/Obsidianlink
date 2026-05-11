# ObsidianLink 前端 image2 页面生成提示词

## 总体设计约束

产品：ObsidianLink，本机知识摄入智能体控制台。

目标用户：个人开发者/知识工作者，用飞书、QQ、抖音链接、GitHub 链接、自然语言想法投喂本地智能体，最终只把确认后的主知识/主项目写入 Obsidian；联想只在飞书/页面展示，不自动写入 Obsidian。

视觉方向：中文本地工具，不做营销官网。要像“本机 Agent 控制塔”：安静、清晰、可信、信息密度适中。避免一坨卡片堆砌，避免大面积渐变和花哨装饰。桌面优先，移动端能用。圆角 8px 以内。颜色用温和的纸白、墨黑、青绿色状态色、琥珀警告色、蓝色动作色。不要紫蓝渐变主题。

全局布局：
- 左侧窄导航：总览、智能体对话、接入通道、预览确认、处理流水线、知识库、配置。
- 顶部状态栏：服务、Vault、模型、FFmpeg、OCR、飞书长连接。
- 主区域按页面变化。
- 所有按钮都必须是真功能按钮，不允许假按钮。未实现能力要显示禁用态和原因。

真实 API 绑定：
- `GET /api/system/health`
- `GET /api/system/status`
- `GET /api/settings`
- `PATCH /api/settings`
- `POST /api/settings/test/openai`
- `POST /api/settings/test/github`
- `POST /api/settings/test/douyin`
- `POST /api/settings/test/tools`
- `POST /api/settings/test/ocr`
- `GET /api/connectors`
- `PATCH /api/connectors/:source/config`
- `POST /api/connectors/:source/test`
- `POST /api/connectors/:source/send-test`
- `POST /api/connectors/:source/start`
- `POST /api/connectors/:source/stop`
- `POST /api/ingest/preview`
- `GET /api/ingest/jobs`
- `GET /api/ingest/jobs/:jobId`
- `GET /api/agent/runs`
- `GET /api/agent/runs/:runId/steps`
- `GET /api/agent/runs/:runId/tool-calls`
- `POST /api/agent/runs/:runId/retry`
- `GET /api/previews`
- `GET /api/previews/:previewId`
- `GET /api/previews/:previewId/markdown`
- `POST /api/previews/:previewId/confirm`
- `POST /api/previews/:previewId/cancel`
- `POST /api/previews/:previewId/regenerate`
- `GET /api/vault/status`
- `POST /api/vault/init`
- `GET /api/vault/tree`
- `GET /api/vault/recent-files`
- `POST /api/vault/check-broken-links`
- `POST /api/vault/search`

## 页面 1：总览仪表盘 image2 prompt

Use case: ui-mockup
Asset type: desktop web app screen, 1440x960
Primary request: 设计 ObsidianLink 总览仪表盘，中文界面，本机 Agent 控制塔风格。不要营销页，不要巨大 hero。左侧导航固定，顶部状态栏固定，主区是 operational dashboard。
Visible copy must be Chinese and include:
- 左侧导航：总览、智能体对话、接入通道、预览确认、处理流水线、知识库、配置
- 顶部状态：服务在线、Vault 可写、模型 gpt-5.5、FFmpeg 可用、OCR 可用、飞书长连接
- 主标题：今天的知识摄入
- 快速投喂输入框 placeholder：粘贴抖音链接、GitHub 链接，或直接说一个想法
- 按钮：生成预览、发送给智能体、清空
- 指标：今日消息、待确认、失败任务、已写入
- 模块：最近任务、等待确认、当前智能体步骤、最近写入文件
Functional details:
- 快速投喂框有来源下拉：网页、飞书、QQ、API
- 最近任务以列表/表格展示 jobId、来源、状态、当前节点、时间
- 等待确认显示 previewId、标题、写入计划和三个操作：确认、取消、查看 Markdown
- 当前智能体步骤用横向 pipeline：输入解析、抖音解析、抽帧 OCR、GitHub 研究、知识抽取、联想生成、预览生成、等待确认
Visual constraints:
- 信息密度高但有呼吸感
- 卡片可以用，但不要卡片套卡片
- 重要状态用小色点和标签
- 桌面端所有文字清楚可读

## 页面 2：智能体对话与预览 image2 prompt

Use case: ui-mockup
Asset type: desktop web app screen, 1440x960
Primary request: 设计 ObsidianLink 智能体对话页，中文界面。它不是普通聊天软件，而是用于测试飞书/QQ 同款智能体逻辑的本地调试页。主视觉是左侧对话流，右侧实时预览与处理状态。
Visible copy:
- 页面标题：智能体对话
- 输入框 placeholder：像发给飞书一样，把抖音链接、GitHub 链接或想法发给我
- 按钮：发送、只生成预览、确认入库、取消、重新生成、查看 Markdown
- 三个决策按钮文案必须是：入库知识、生成应用想法、入库并联想
- 提醒文案：应用想法只返回到对话，不写入 Obsidian
Functional details:
- 左侧消息流展示用户消息、处理中卡片、识别成功卡片、应用想法卡片、入库结果
- 处理中卡片展示：已收到、当前步骤、任务 ID
- 识别成功卡片展示：识别类型、标题、摘要、写入计划、可信度、来源、按钮区
- 右侧预览面板显示 notesToWrite、knowledge、ideas、warnings
- 右侧 Markdown 面板可展开，代码风格展示生成内容
- 底部输入区支持来源、senderId、messageId 自动生成
Visual constraints:
- 对话气泡不要像社交娱乐 App，要像工程调试消息
- 预览卡片要漂亮，层次分明，移动端飞书卡片感
- 不能让“联想”看起来会写入 Obsidian

## 页面 3：接入通道与平台配置 image2 prompt

Use case: ui-mockup
Asset type: desktop web app screen, 1440x960
Primary request: 设计 ObsidianLink 接入通道页，中文界面，真实平台 SDK/协议配置。左侧是平台列表，右侧是选中平台的配置表单和测试区。
Required platform list:
- QQ 开放平台 Bot SDK
- 飞书
- 微信公众号/服务号
- 企业微信
- 钉钉
- Telegram
- 网页聊天
- 通用 Webhook
Visible fields:
- 回调 URL
- 公网地址状态
- 配置完整度
- 最近请求时间
- 最近错误
- 最近测试结果
- 支持能力
- 配置字段，密钥字段显示“已配置/未配置”，不回显明文
Buttons:
- 复制回调 URL
- 保存配置
- 测试连接
- 发送测试消息
- 启动长连接/SDK
- 停止长连接/SDK
Feishu selected state details:
- 展示 FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_VERIFICATION_TOKEN、FEISHU_ENCRYPT_KEY、FEISHU_LONG_CONNECTION_ENABLED
- 展示“飞书长连接已连接，正在接收事件”
- 展示“卡片点击回调需要 card.action.trigger 和消息卡片请求地址”
QQ selected state details:
- 展示 QQ_BOT_APP_ID、QQ_BOT_TOKEN、QQ_BOT_SANDBOX、QQ_BOT_SDK_AUTOSTART、QQ_BOT_FORWARD_SECRET
Visual constraints:
- 这页要像专业开发者控制台，不要像表单堆砌
- 平台列表每项有状态灯、模式标签、配置进度
- 右侧表单区分“鉴权配置”“运行控制”“测试结果”

## 页面 4：处理流水线与运行详情 image2 prompt

Use case: ui-mockup
Asset type: desktop web app screen, 1440x960
Primary request: 设计 ObsidianLink 处理流水线页，中文界面。用于追踪一条消息从接入到入库的全部 Agent 节点和工具调用。
Visible modules:
- 左侧 Job 列表：来源、状态、intent_type、current_node、preview_id、错误摘要
- 中间节点时间线：load_context、intent_router、parse_input、douyin_pipeline、github_pipeline、vault_context_retriever、knowledge_extractor、idea_generator、note_planner、preview_builder、quality_checker、reply_builder
- 右侧详情：节点输入摘要、输出摘要、工具名、耗时、错误
- 底部工具调用表：tool_name、status、duration_ms、input_json、output_json
Buttons:
- 刷新
- 重试运行
- 打开预览
- 查看工具输出
- 复制错误
Visual constraints:
- 要像可观测性/trace 调试工具
- 节点状态用 success/warning/failed/running/skipped 五种视觉
- JSON 详情要有代码块风格，但不能太黑，和整体浅色 UI 协调

## 页面 5：知识库与配置中心 image2 prompt

Use case: ui-mockup
Asset type: desktop web app screen, 1440x960
Primary request: 设计 ObsidianLink 知识库和配置页的组合视图，中文界面。左半展示 Vault 状态和目录树，右半展示配置中心。
Vault 目录必须展示：
- 0_收件箱
- 1_项目
- 2_知识
- 3_能力
- 4_想法
- 5_实验
- 6_作品
- 7_地图
- 8_归档
- 9_系统
Vault buttons:
- 初始化目录
- 刷新目录树
- 搜索笔记
- 检查双链
- 打开 Vault
Settings fields:
- OBSIDIAN_VAULT_PATH
- OPENAI_BASE_URL
- OPENAI_API_KEY
- OPENAI_MODEL
- GITHUB_TOKEN
- DOUYIN_PARSE_API
- OCR_FRAME_INTERVAL_SECONDS
- OCR_MAX_FRAMES
Test buttons:
- 测试模型
- 测试 GitHub
- 测试抖音解析
- 检查 FFmpeg/OCR
- OCR 烟测
- 保存配置
Visual constraints:
- 密钥永不明文显示，输入框 placeholder：留空则不修改
- 工具状态用明确结果：可用/不可用/未测试
- 目录树不要像普通文件浏览器，要强调“知识库结构”

## 页面 6：移动端响应式 image2 prompt

Use case: ui-mockup
Asset type: mobile web app screen, 390x844
Primary request: 设计 ObsidianLink 移动端主界面，中文界面。移动端重点是快速投喂和待确认，不展示复杂配置。
Visible modules:
- 顶部：ObsidianLink、服务状态
- 快速投喂输入框
- 按钮：发送、预览
- 待确认列表
- 最近运行步骤
- 底部导航：总览、对话、通道、流水线、配置
Visual constraints:
- 触控按钮高度至少 44px
- 不要横向溢出
- 状态文案短
- 信息折叠为可展开行
