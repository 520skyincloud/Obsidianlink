const pages = [
  { id: "home", label: "首页", title: "ObsidianLink Desktop", subtitle: "飞书里的本地 Obsidian 知识库助手", icon: "home" },
  { id: "setup", label: "首次配置", title: "首次配置", subtitle: "按顺序填好 Vault、模型、GitHub、抖音解析和飞书参数", icon: "sliders" },
  { id: "feishu", label: "飞书助手", title: "飞书助手", subtitle: "长连接优先，公网回调只用于 Webhook 备用和卡片回调兜底", icon: "message" },
  { id: "tasks", label: "任务与预览", title: "任务与预览", subtitle: "查看 Agent 任务、预览、确认写入和节点流水线", icon: "queue" },
  { id: "vault", label: "知识库", title: "知识库", subtitle: "查看 Obsidian Vault、最近写入、搜索和断链检查", icon: "database" },
  { id: "diagnostics", label: "设置与诊断", title: "设置与诊断", subtitle: "高级参数、系统健康、平台日志和真实连通性测试", icon: "gear" }
];

const pageIds = new Set(pages.map((page) => page.id));

const state = {
  page: pageIds.has(location.hash.slice(1)) ? location.hash.slice(1) : "home",
  health: null,
  status: null,
  settings: null,
  connectors: [],
  jobs: [],
  previews: [],
  runs: [],
  sessions: [],
  intentLogs: [],
  platformEvents: [],
  recentFiles: [],
  vaultStatus: null,
  vaultTree: [],
  steps: [],
  toolCalls: [],
  selectedPreviewId: "",
  selectedRunId: "",
  selectedJobId: "",
  selectedMarkdown: "",
  selectedConnector: "feishu",
  localChat: [
    { role: "user", text: "你好" },
    { role: "assistant", text: "我在。发抖音链接、GitHub 项目名、网页或开发想法，我会先判断意图，再决定是否生成入库预览。" }
  ],
  searchResults: [],
  lastUpdatedAt: "",
  refreshError: "",
  refreshInFlight: false,
  pendingVisualRefresh: false,
  lastSignature: ""
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  renderNav();
  renderShell();
  try {
    await refreshAll();
    render();
  } catch (error) {
    toast(`启动读取失败：${messageOf(error)}`);
    render();
  }
  setInterval(() => refreshRealtime(), 3000);
});

function bindEvents() {
  document.addEventListener("click", async (event) => {
    const navButton = event.target.closest("[data-nav]");
    if (navButton) {
      state.page = navButton.dataset.nav;
      location.hash = state.page;
      await refreshForPage(state.page);
      render();
      return;
    }

    const selectPreview = event.target.closest("[data-preview-id]");
    if (selectPreview && !event.target.closest("[data-action]")) {
      state.selectedPreviewId = selectPreview.dataset.previewId;
      state.selectedMarkdown = "";
      render();
      return;
    }

    const selectRun = event.target.closest("[data-run-id]");
    if (selectRun && !event.target.closest("[data-action]")) {
      state.selectedRunId = selectRun.dataset.runId;
      await loadRunDetails();
      render();
      return;
    }

    const selectJob = event.target.closest("[data-job-id]");
    if (selectJob && !event.target.closest("[data-action]")) {
      state.selectedJobId = selectJob.dataset.jobId;
      render();
      return;
    }

    const action = event.target.closest("[data-action]");
    if (!action) return;
    event.preventDefault();
    await runAction(action.dataset.action, action);
  });

  window.addEventListener("hashchange", async () => {
    const next = location.hash.slice(1);
    if (!pageIds.has(next)) return;
    state.page = next;
    await refreshForPage(next);
    render();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshRealtime(true);
  });
  window.addEventListener("focus", () => refreshRealtime(true));
}

async function refreshRealtime(force = false) {
  if (document.hidden || state.refreshInFlight) return;
  state.refreshInFlight = true;
  const before = state.lastSignature;
  try {
    await refreshForPage(state.page);
    const changed = force || before !== state.lastSignature;
    if (changed) {
      if (isEditing()) {
        state.pendingVisualRefresh = true;
        renderShell();
      } else {
        state.pendingVisualRefresh = false;
        render();
      }
    } else {
      renderShell();
    }
  } catch (error) {
    state.refreshError = messageOf(error);
    renderShell();
  } finally {
    state.refreshInFlight = false;
  }
}

async function refreshForPage(page) {
  await refreshAll();
  if (page === "vault") await loadVault();
}

async function refreshAll() {
  const [health, status, settings, connectors, jobs, previews, runs, events, recent, sessions, intentLogs] = await Promise.all([
    getJson("/api/system/health"),
    getJson("/api/system/status").catch(() => null),
    getJson("/api/settings"),
    getJson("/api/connectors"),
    getJson("/api/ingest/jobs?limit=80"),
    getJson("/api/previews?limit=80"),
    getJson("/api/agent/runs?limit=50"),
    getJson("/api/connectors/logs?limit=100").catch(() => ({ logs: [] })),
    getJson("/api/vault/recent-files?limit=60").catch(() => ({ files: [] })),
    getJson("/api/agent/sessions?limit=30").catch(() => ({ sessions: [] })),
    getJson("/api/agent/intent-logs?limit=50").catch(() => ({ logs: [] }))
  ]);

  state.health = health;
  state.status = status;
  state.settings = settings;
  state.connectors = connectors.connectors || [];
  state.jobs = sortByTime(jobs.jobs || [], ["updatedAt", "createdAt"]);
  state.previews = sortByTime(previews.previews || [], ["updatedAt", "createdAt"]);
  state.runs = sortByTime(runs.runs || [], ["endedAt", "startedAt"]);
  state.platformEvents = sortByTime(events.logs || [], ["createdAt"]);
  state.recentFiles = sortByTime(recent.files || [], ["updatedAt", "createdAt"]);
  state.sessions = sortByTime(sessions.sessions || [], ["lastActiveAt", "updatedAt", "createdAt"]);
  state.intentLogs = sortByTime(intentLogs.logs || [], ["createdAt"]);
  state.lastUpdatedAt = new Date().toISOString();
  state.refreshError = "";

  if (!state.selectedPreviewId || !state.previews.some((item) => item.previewId === state.selectedPreviewId)) {
    state.selectedPreviewId = (state.previews.find((item) => item.status === "pending") || state.previews[0])?.previewId || "";
  }
  if (!state.selectedRunId || !state.runs.some((item) => item.id === state.selectedRunId)) {
    state.selectedRunId = state.runs[0]?.id || "";
  }
  if (!state.selectedJobId || !state.jobs.some((item) => item.id === state.selectedJobId)) {
    state.selectedJobId = state.jobs[0]?.id || "";
  }
  if (!state.connectors.some((item) => item.source === state.selectedConnector)) {
    state.selectedConnector = state.connectors.find((item) => item.source === "feishu")?.source || state.connectors[0]?.source || "feishu";
  }
  await loadRunDetails();
  state.lastSignature = signature();
}

async function loadVault() {
  const [vaultStatus, tree, recent] = await Promise.all([
    getJson("/api/vault/status"),
    getJson("/api/vault/tree"),
    getJson("/api/vault/recent-files?limit=80")
  ]);
  state.vaultStatus = vaultStatus;
  state.vaultTree = tree.tree || [];
  state.recentFiles = sortByTime(recent.files || [], ["updatedAt", "createdAt"]);
  state.lastSignature = signature();
}

async function loadRunDetails() {
  if (!state.selectedRunId) {
    state.steps = [];
    state.toolCalls = [];
    return;
  }
  const [steps, toolCalls] = await Promise.all([
    getJson(`/api/agent/runs/${encodeURIComponent(state.selectedRunId)}/steps`).catch(() => ({ steps: [] })),
    getJson(`/api/agent/runs/${encodeURIComponent(state.selectedRunId)}/tool-calls`).catch(() => ({ toolCalls: [] }))
  ]);
  state.steps = steps.steps || [];
  state.toolCalls = toolCalls.toolCalls || [];
}

function signature() {
  return JSON.stringify({
    page: state.page,
    health: [state.health?.ok, state.health?.vault?.writable, state.health?.model?.configured],
    connectors: state.connectors.map((item) => [item.source, item.enabled, item.lastRequestAt, item.lastError, item.longConnection?.running]),
    jobs: state.jobs.slice(0, 18).map((item) => [item.id, item.status, item.currentNode, item.previewId, item.updatedAt]),
    previews: state.previews.slice(0, 18).map((item) => [item.previewId, item.status, item.noteCount, item.updatedAt]),
    runs: state.runs.slice(0, 12).map((item) => [item.id, item.status, item.endedAt]),
    events: state.platformEvents.slice(0, 18).map((item) => [item.id, item.status, item.message, item.createdAt]),
    files: state.recentFiles.slice(0, 14).map((item) => [item.id, item.path, item.updatedAt])
  });
}

function render() {
  renderNav();
  renderShell();
  const app = $("#app");
  if (!app) return;
  if (state.page === "home") app.innerHTML = renderHome();
  else if (state.page === "setup") app.innerHTML = renderSetup();
  else if (state.page === "feishu") app.innerHTML = renderFeishu();
  else if (state.page === "tasks") app.innerHTML = renderTasks();
  else if (state.page === "vault") app.innerHTML = renderVault();
  else if (state.page === "diagnostics") app.innerHTML = renderDiagnostics();
}

function renderNav() {
  const nav = $("#nav");
  if (!nav) return;
  nav.innerHTML = pages.map((page) => `
    <button class="nav-button ${state.page === page.id ? "active" : ""}" data-nav="${page.id}">
      ${icon(page.icon)}
      <span>${escapeHtml(page.label)}</span>
    </button>
  `).join("");
}

function renderShell() {
  const current = pages.find((page) => page.id === state.page) || pages[0];
  $("#page-title").textContent = current.title;
  $("#page-subtitle").textContent = current.subtitle;
  $("#title-icon").innerHTML = icon(current.icon);
  const ok = serviceOk();
  $("#side-dot").className = `dot ${ok ? "ok" : "bad"}`;
  $("#side-status").textContent = ok ? "服务运行中" : "需要检查";
  $("#side-version").textContent = `v${state.health?.version || "0.1.0"}`;
  $("#refresh-pill").innerHTML = `<i class="dot ${state.refreshError ? "bad" : "ok"}"></i>${state.refreshError ? escapeHtml(state.refreshError) : `已同步 ${formatTime(state.lastUpdatedAt)}`}`;
  $("#bottom-bar").innerHTML = `
    <span><i class="dot ${ok ? "ok" : "bad"}"></i> 本地服务：${ok ? "正常" : "异常"}</span>
    <span>Vault：${escapeHtml(state.settings?.obsidianVaultPath || state.health?.vault?.path || "未配置")}</span>
    <span>模型：${escapeHtml(state.settings?.openaiModel || state.health?.model?.model || "未配置")}</span>
    <span>数据库：${databaseOk() ? "ok" : "需要检查"}</span>
  `;
}

function renderHome() {
  const cards = statusCards();
  const jobs = state.jobs.slice(0, 5);
  return `
    <div class="layout-home">
      <div class="grid">
        <div class="grid grid-3">
          ${cards.map(renderMetricCard).join("")}
        </div>
        ${renderSetupProgress()}
        <div class="card">
          <div class="card-head">
            <div><h2 class="card-title">最近任务</h2><p class="card-desc">来自飞书、网页测试和回调的真实 Agent 任务。</p></div>
            <button class="btn small" data-nav="tasks">查看全部</button>
          </div>
          <div class="card-body">
            ${jobs.length ? `
              <table class="table">
                <thead><tr><th>任务</th><th>来源</th><th>状态</th><th>节点</th><th>时间</th></tr></thead>
                <tbody>${jobs.map((job) => `
                  <tr class="selectable" data-job-id="${escapeAttr(job.id)}">
                    <td><strong>${escapeHtml(shortId(job.id))}</strong><div class="help">${escapeHtml(job.intentType || "new_ingest")}</div></td>
                    <td>${sourceLabel(job.source)}</td>
                    <td>${statusPill(job.status)}</td>
                    <td>${escapeHtml(nodeName(job.currentNode || "等待"))}</td>
                    <td>${formatTime(job.updatedAt || job.createdAt)}</td>
                  </tr>
                `).join("")}</tbody>
              </table>
            ` : empty("还没有任务。飞书发消息或在右侧网页测试里发送一条。")}
          </div>
        </div>
      </div>
      ${renderChatCard()}
    </div>
  `;
}

function renderMetricCard(card) {
  return `
    <div class="card metric-card">
      <div class="metric-check ${card.tone === "bad" ? "bad" : card.tone === "warn" ? "warn" : ""}">${card.ok ? "✓" : card.tone === "warn" ? "!" : "×"}</div>
      <div>
        <div class="metric-icon ${card.iconTone || ""}">${icon(card.icon)}</div>
        <div class="metric-title">${escapeHtml(card.title)}</div>
        <div class="metric-sub">${escapeHtml(card.subtitle)}</div>
      </div>
      <span class="pill ${card.ok ? "ok" : card.tone === "warn" ? "warn" : "bad"}">${escapeHtml(card.badge)}</span>
    </div>
  `;
}

function statusCards() {
  const feishu = feishuConnector();
  const longRunning = Boolean(feishu?.longConnection?.running);
  return [
    { icon: "server", iconTone: "green", ok: serviceOk(), tone: serviceOk() ? "ok" : "bad", title: serviceOk() ? "服务运行中" : "服务异常", subtitle: databaseOk() ? "本地服务和 SQLite 正常" : "数据库或配置需要检查", badge: serviceOk() ? "正常" : "检查" },
    { icon: "send", ok: longRunning, tone: longRunning ? "ok" : "warn", title: "飞书长连接", subtitle: feishu?.longConnection?.note || "用于收发消息和卡片按钮", badge: longRunning ? "已连接" : "未运行" },
    { icon: "vault", iconTone: "violet", ok: Boolean(state.health?.vault?.writable), tone: state.health?.vault?.exists ? "warn" : "bad", title: "Obsidian 可写", subtitle: state.health?.vault?.path || "Vault 路径未读取", badge: state.health?.vault?.writable ? "可写" : "不可写" },
    { icon: "brain", ok: Boolean(state.health?.model?.configured), tone: state.health?.model?.configured ? "ok" : "bad", title: `模型 ${state.settings?.openaiModel || "未配置"}`, subtitle: state.settings?.openaiBaseUrl || "OpenAI 兼容接口", badge: state.health?.model?.configured ? "可用" : "缺密钥" },
    { icon: "github", ok: Boolean(state.settings?.githubTokenConfigured), tone: state.settings?.githubTokenConfigured ? "ok" : "warn", title: "GitHub", subtitle: "用于项目研究、README 和搜索", badge: state.settings?.githubTokenConfigured ? "已配置" : "未配置" },
    { icon: "ocr", iconTone: "orange", ok: Boolean(state.health?.tools?.ffmpeg && state.health?.tools?.tesseract), tone: state.health?.tools?.ffmpeg ? "warn" : "bad", title: "视频 OCR", subtitle: "抖音视频抽帧、文字识别和临时文件清理", badge: state.health?.tools?.ffmpeg && state.health?.tools?.tesseract ? "可用" : "检查工具" }
  ];
}

function renderSetupProgress() {
  const steps = [
    { title: "选择 Vault", done: Boolean(state.health?.vault?.exists), sub: state.health?.vault?.writable ? "可写" : "待检查" },
    { title: "模型测试", done: Boolean(state.settings?.openaiConfigured), sub: state.settings?.openaiModel || "待配置" },
    { title: "GitHub 测试", done: Boolean(state.settings?.githubTokenConfigured), sub: state.settings?.githubTokenConfigured ? "已配置" : "可稍后" },
    { title: "飞书长连接", done: Boolean(feishuConnector()?.longConnection?.running), sub: feishuConnector()?.longConnection?.running ? "已连接" : "待启动" },
    { title: "开始聊天", done: state.jobs.length > 0, sub: state.jobs.length ? "已处理消息" : "就绪" }
  ];
  const firstTodo = steps.findIndex((step) => !step.done);
  return `
    <div class="card">
      <div class="card-head"><div><h2 class="card-title">配置进度</h2><p class="card-desc">软件可用前最关键的五个检查点。</p></div><button class="btn small" data-nav="setup">去配置</button></div>
      <div class="progress">
        <div class="progress-line">${steps.map((step, index) => `
          <div class="step ${step.done ? "done" : index === firstTodo ? "active" : ""}">
            <div class="step-badge">${step.done ? "✓" : index + 1}</div>
            <div class="step-title">${escapeHtml(step.title)}</div>
            <div class="step-sub">${escapeHtml(step.sub)}</div>
          </div>
        `).join("")}</div>
      </div>
    </div>
  `;
}

function renderChatCard() {
  return `
    <div class="card chat-panel">
      <div class="card-head">
        <div><h2 class="card-title">本地聊天测试</h2><p class="card-desc">不经过飞书，直接测试同一套 Agent 链路。</p></div>
        <span class="pill ${feishuConnector()?.longConnection?.running ? "ok" : "warn"}">${feishuConnector()?.longConnection?.running ? "飞书已连接" : "本地测试"}</span>
      </div>
      <div class="chat-stream">
        ${state.localChat.slice(-8).map((msg) => `
          <div class="bubble-row ${msg.role === "user" ? "user" : ""}">
            ${msg.role === "user" ? "" : `<div class="avatar">OL</div>`}
            <div class="bubble ${msg.role === "user" ? "user" : ""}">${escapeHtml(msg.text)}</div>
            ${msg.role === "user" ? `<div class="avatar">我</div>` : ""}
          </div>
        `).join("")}
      </div>
      <div class="composer">
        <textarea id="chat-text" placeholder="例如：去 GitHub 找 Docling 这个项目 / 我有个想法想做 PDF RAG 自动复测工具 / 粘贴抖音链接"></textarea>
        <div class="composer-actions">
          <span class="help">闲聊走普通回复；链接、项目名和明确保存才会进入预览或入库。</span>
          <div class="toolbar">
            <button class="btn" data-action="debug-intent">判别意图</button>
            <button class="btn" data-action="preview-message">生成预览</button>
            <button class="btn primary" data-action="send-message">发送测试</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSetup() {
  return `
    <div class="layout-wide">
      <div class="grid">
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">核心参数</h2><p class="card-desc">密钥留空表示不覆盖原配置，保存后会写入本机 .env。</p></div><button class="btn primary" data-action="save-settings">保存配置</button></div>
          <div class="card-body">
            <div class="form-grid">
              ${field("setting-obsidianVaultPath", "Obsidian Vault 路径", state.settings?.obsidianVaultPath || "", "text", "/Users/sky/Documents/obsidian/sky", "最终 Markdown 只写入这个目录。")}
              ${field("setting-openaiBaseUrl", "模型 API 地址", state.settings?.openaiBaseUrl || "", "url", "http://43.128.146.66:8317/v1", "OpenAI 兼容接口 baseUrl。")}
              ${field("setting-openaiModel", "模型名称", state.settings?.openaiModel || "", "text", "gpt-5.5", "用于意图识别、总结、分类和联想。")}
              ${field("setting-openaiApiKey", "模型密钥", "", "password", "留空则不修改", state.settings?.openaiConfigured ? "已配置；留空不覆盖。" : "未配置。")}
              ${field("setting-githubToken", "GitHub Token", "", "password", "留空则不修改", state.settings?.githubTokenConfigured ? "已配置；用于提高限流和读取 README。" : "未配置。")}
              ${field("setting-douyinParseApi", "抖音解析 API", state.settings?.douyinParseApi || "", "url", "https://api.bugpk.com/...", "用于先解析视频/图文，再抽帧 OCR。")}
              ${field("setting-ocrFrameIntervalSeconds", "OCR 抽帧间隔秒", state.settings?.ocrFrameIntervalSeconds || 2, "number", "2", "间隔越小越准，处理越慢。")}
              ${field("setting-ocrMaxFrames", "OCR 最大帧数", state.settings?.ocrMaxFrames || 12, "number", "12", "处理完成后临时视频和图片会清理。")}
            </div>
          </div>
        </div>
        ${renderFeishuConfigCard(true)}
      </div>
      <div class="grid">
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">真实测试</h2><p class="card-desc">这些按钮会调用真实后端接口，不做假成功。</p></div></div>
          <div class="card-body grid">
            ${testButton("openai", "模型连接", state.settings?.openaiConfigured ? "已配置密钥，可以测试 /models。" : "未配置密钥")}
            ${testButton("github", "GitHub Token", state.settings?.githubTokenConfigured ? "调用 GitHub rate_limit。" : "未配置 Token")}
            ${testButton("douyin", "抖音解析", state.settings?.douyinParseApi ? "可传入链接做真实测试。" : "未配置解析 API")}
            ${testButton("tools", "本机工具", "检查 ffmpeg 和 tesseract。")}
            ${testButton("ocr", "OCR 链路", "生成临时测试视频、抽帧 OCR、清理临时文件。")}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">部署提示</h2><p class="card-desc">第一次使用最容易卡住的地方。</p></div></div>
          <div class="card-body list">
            ${tip("飞书推荐长连接", "长连接不需要公网地址；卡片按钮也能通过 WSClient 收到。公网回调主要是备用。")}
            ${tip("公网回调要 HTTPS", "如果使用事件回调 URL，飞书开放平台通常要求有效 HTTP/HTTPS URL，内网穿透地址必须能返回 challenge。")}
            ${tip("密钥不会回显", "页面只显示已配置/未配置，密钥字段留空不会覆盖旧值。")}
            ${tip("先测试再接入", "先在本地聊天测试跑通意图，再启动飞书长连接。")}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderFeishu() {
  const connector = feishuConnector();
  const lc = connector?.longConnection || {};
  return `
    <div class="layout-wide">
      <div class="grid">
        <div class="card pad">
          <div class="split">
            <div>
              <h2 class="card-title">飞书运行状态</h2>
              <p class="card-desc">${escapeHtml(connector?.description || "飞书机器人长连接和回调状态。")}</p>
            </div>
            <span class="pill ${lc.running ? "ok" : lc.enabled ? "warn" : "bad"}"><i class="dot ${lc.running ? "ok" : lc.enabled ? "warn" : "bad"}"></i>${lc.running ? "长连接运行中" : lc.enabled ? "已启用未运行" : "未启用"}</span>
          </div>
          <div class="grid grid-4" style="margin-top:16px;">
            ${mini("启用", lc.enabled ? "是" : "否", lc.enabled ? "ok" : "warn")}
            ${mini("运行", lc.running ? "运行中" : "未运行", lc.running ? "ok" : "bad")}
            ${mini("最近事件", formatTime(lc.lastEventAt), lc.lastEventAt ? "ok" : "warn")}
            ${mini("最近回复", formatTime(lc.lastReplyAt), lc.lastReplyAt ? "ok" : "warn")}
          </div>
          ${lc.lastError ? `<div class="pill bad" style="margin-top:14px;">${escapeHtml(lc.lastError)}</div>` : ""}
          <div class="toolbar" style="margin-top:16px;">
            <button class="btn green" data-action="start-feishu">启动长连接</button>
            <button class="btn" data-action="stop-feishu">停止长连接</button>
            <button class="btn" data-action="test-feishu">测试智能体</button>
            <button class="btn" data-action="send-test-feishu">发送测试消息</button>
          </div>
        </div>
        ${renderFeishuConfigCard(false)}
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">飞书配置方式</h2><p class="card-desc">现在主链路是长连接；公网回调用于事件回调备用。</p></div></div>
          <div class="card-body list">
            ${tip("事件订阅：长连接", "在飞书开发者后台开启机器人事件，选择“使用长连接接收事件”，本机启动长连接即可收消息。")}
            ${tip("事件回调：公网地址", `如果改用开发者服务器，填写 ${escapeHtml(connector?.url || "/connectors/feishu/message")}，并确保公网地址可被飞书访问。`)}
            ${tip("回调配置", "卡片按钮回调同样进入飞书事件；当前代码能识别 card.action.trigger 并执行入库/取消/联想。")}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2 class="card-title">飞书事件日志</h2><p class="card-desc">最近收到的消息、异步回复、忽略事件和错误。</p></div><button class="btn small" data-action="refresh">刷新</button></div>
        <div class="card-body">
          ${renderEventList(state.platformEvents.filter((item) => item.source === "feishu").slice(0, 18))}
        </div>
      </div>
    </div>
  `;
}

function renderFeishuConfigCard(compact) {
  const connector = feishuConnector();
  if (!connector) return empty("没有读取到飞书 connector。");
  const fields = connector.configFields || [];
  return `
    <div class="card">
      <div class="card-head">
        <div><h2 class="card-title">飞书参数</h2><p class="card-desc">App ID、App Secret、Verification Token、Encrypt Key 和长连接开关。</p></div>
        <button class="btn primary" data-action="save-feishu">保存飞书</button>
      </div>
      <div class="card-body">
        <div class="form-grid">
          ${field("feishu-publicBaseUrl", "公网 Base URL", connector.publicBaseUrl || "", "url", "https://your-domain.com", "Webhook 模式才需要；长连接可不依赖公网。")}
          ${fields.map((item) => field(`feishu-${item.key}`, item.label || item.key, item.key === "longConnection" ? (connector.configuredFields?.longConnection ? "true" : "") : "", item.secret ? "password" : "text", item.placeholder || "", `${item.required ? "必填" : "可选"}；${connector.configuredFields?.[item.key] ? "已配置" : "未配置"}`)).join("")}
        </div>
        ${compact ? "" : `<div class="toolbar" style="margin-top:14px;"><button class="btn" data-action="copy-feishu-url">复制回调地址</button><span class="pill blue mono">${escapeHtml(connector.url || "")}</span></div>`}
      </div>
    </div>
  `;
}

function renderTasks() {
  const preview = selectedPreview();
  const run = selectedRun();
  return `
    <div class="layout-three">
      <div class="grid">
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">任务</h2><p class="card-desc">${state.jobs.length} 个任务</p></div></div>
          <div class="card-body list">${state.jobs.slice(0, 18).map((job) => `
            <div class="list-item selectable ${job.id === state.selectedJobId ? "active" : ""}" data-job-id="${escapeAttr(job.id)}">
              <div class="split"><strong>${escapeHtml(shortId(job.id))}</strong>${statusPill(job.status)}</div>
              <div class="help">${sourceLabel(job.source)} · ${escapeHtml(nodeName(job.currentNode || "等待"))}</div>
              <div class="help">${formatTime(job.updatedAt || job.createdAt)}</div>
            </div>
          `).join("") || empty("暂无任务")}</div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">预览</h2><p class="card-desc">${state.previews.length} 个预览</p></div></div>
          <div class="card-body list">${state.previews.slice(0, 18).map((item) => `
            <div class="list-item selectable ${item.previewId === state.selectedPreviewId ? "active" : ""}" data-preview-id="${escapeAttr(item.previewId)}">
              <div class="split"><strong>${escapeHtml(shortId(item.previewId))}</strong>${statusPill(item.status)}</div>
              <div>${escapeHtml(item.summary || "无摘要").slice(0, 92)}</div>
              <div class="help">计划写入 ${Number(item.noteCount || item.notesToWrite?.length || 0)} 个文件 · ${formatTime(item.updatedAt || item.createdAt)}</div>
            </div>
          `).join("") || empty("暂无预览")}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-head">
          <div><h2 class="card-title">预览详情</h2><p class="card-desc">确认后才会写入 Obsidian。</p></div>
          ${preview ? `<span class="pill blue">${escapeHtml(shortId(preview.previewId))}</span>` : ""}
        </div>
        <div class="card-body">
          ${preview ? renderPreviewDetail(preview) : empty("选择一个预览查看详情。")}
        </div>
      </div>
      <div class="grid">
        <div class="card">
          <div class="card-head">
            <div><h2 class="card-title">Agent Run</h2><p class="card-desc">${run ? shortId(run.id) : "未选择"}</p></div>
            ${run ? `<button class="btn small" data-action="retry-run">重试</button>` : ""}
          </div>
          <div class="card-body">${renderRunList()}</div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">节点流水线</h2><p class="card-desc">当前 Run 的节点日志和工具调用。</p></div></div>
          <div class="card-body">${renderTimeline()}</div>
        </div>
      </div>
    </div>
  `;
}

function renderPreviewDetail(preview) {
  const notes = preview.notesToWrite || preview.notes_to_write || [];
  const warnings = preview.warnings || [];
  return `
    <div class="grid">
      <div>
        <div class="split"><h3 class="card-title">${escapeHtml(preview.summary || "预览")}</h3>${statusPill(preview.status)}</div>
        ${warnings.length ? `<div class="list" style="margin-top:10px;">${warnings.map((item) => `<span class="pill warn">${escapeHtml(typeof item === "string" ? item : item.message || JSON.stringify(item))}</span>`).join("")}</div>` : ""}
      </div>
      <div class="toolbar">
        <button class="btn green" data-action="confirm-preview">确认入库</button>
        <button class="btn danger" data-action="cancel-preview">取消</button>
        <button class="btn" data-action="load-markdown">查看 Markdown</button>
      </div>
      <div class="list">
        ${notes.length ? notes.map((note) => `
          <div class="list-item">
            <div class="split"><strong>${escapeHtml(note.title || note.path || "待写入文件")}</strong><span class="pill blue">${escapeHtml(note.operation || note.type || "create")}</span></div>
            <div class="mono help">${escapeHtml(note.path || "")}</div>
            <div class="help">${escapeHtml(note.reason || "")}</div>
          </div>
        `).join("") : empty("这个预览没有可写入文件，通常说明已确认过、被取消，或需要重新生成。")}
      </div>
      <div class="field">
        <label>补充信息后重新生成</label>
        <textarea id="regenerate-text" placeholder="例如：这个视频不是 GitHub 项目，是一个提示词优化知识点，只写一张知识卡。"></textarea>
        <div class="toolbar"><button class="btn" data-action="regenerate-preview">重新生成</button></div>
      </div>
      ${state.selectedMarkdown ? `<div class="codebox">${escapeHtml(state.selectedMarkdown)}</div>` : ""}
    </div>
  `;
}

function renderRunList() {
  if (!state.runs.length) return empty("暂无 Agent Run。");
  return `<div class="list">${state.runs.slice(0, 12).map((run) => `
    <div class="list-item selectable ${run.id === state.selectedRunId ? "active" : ""}" data-run-id="${escapeAttr(run.id)}">
      <div class="split"><strong>${escapeHtml(shortId(run.id))}</strong>${statusPill(run.status)}</div>
      <div class="help">Job ${escapeHtml(shortId(run.jobId))} · ${escapeHtml(run.model || "model")}</div>
      <div class="help">${formatTime(run.startedAt)} - ${formatTime(run.endedAt)}</div>
    </div>
  `).join("")}</div>`;
}

function renderTimeline() {
  if (!state.steps.length && !state.toolCalls.length) return empty("选择一个 Run 后显示节点和工具调用。");
  return `
    <div class="timeline">
      ${state.steps.map((step) => `
        <div class="timeline-row">
          <div class="timeline-dot ${escapeAttr(step.status || "")}"></div>
          <div>
            <div class="split"><strong>${escapeHtml(nodeName(step.nodeName || step.node_name || "node"))}</strong><span class="help">${escapeHtml(step.durationMs || step.duration_ms || "")}ms</span></div>
            <div class="help">${escapeHtml(step.outputSummary || step.output_summary || step.error || step.inputSummary || "")}</div>
          </div>
        </div>
      `).join("")}
      ${state.toolCalls.length ? `<div class="codebox">${escapeHtml(JSON.stringify(state.toolCalls.slice(0, 8), null, 2))}</div>` : ""}
    </div>
  `;
}

function renderVault() {
  const status = state.vaultStatus || state.health?.vault || {};
  return `
    <div class="layout-wide">
      <div class="grid">
        <div class="card pad">
          <div class="split">
            <div><h2 class="card-title">Vault 状态</h2><p class="card-desc">${escapeHtml(status.path || state.settings?.obsidianVaultPath || "未读取到路径")}</p></div>
            <span class="pill ${status.writable ? "ok" : "bad"}">${status.writable ? "可写" : "不可写"}</span>
          </div>
          <div class="toolbar" style="margin-top:16px;">
            <button class="btn green" data-action="init-vault">初始化目录</button>
            <button class="btn" data-action="open-vault">打开 Vault</button>
            <button class="btn" data-action="check-links">检查断链</button>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">目录树</h2><p class="card-desc">最多读取 4 层，隐藏 .obsidian。</p></div></div>
          <div class="card-body"><div class="tree">${state.vaultTree.slice(0, 180).map((item) => `
            <div class="tree-row" style="padding-left:${8 + Math.min(item.path.split("/").length - 1, 4) * 18}px;">${item.type === "dir" ? icon("folder") : icon("file")}<span class="truncate">${escapeHtml(item.path)}</span></div>
          `).join("") || empty("暂无目录，点击初始化。")}</div></div>
        </div>
      </div>
      <div class="grid">
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">搜索 Vault</h2><p class="card-desc">按文件路径搜索，适合快速确认是否写入。</p></div></div>
          <div class="card-body">
            <div class="toolbar"><input id="vault-query" placeholder="搜索文件名或目录，例如 LangGraph / 提示词 / 飞书"><button class="btn primary" data-action="search-vault">搜索</button></div>
            <div class="list" style="margin-top:14px;">${state.searchResults.length ? state.searchResults.map((item) => `<div class="list-item"><strong>${escapeHtml(item.path)}</strong><div class="help">${escapeHtml(item.type)}</div></div>`).join("") : empty("输入关键词后搜索。")}</div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">最近写入</h2><p class="card-desc">来自数据库 vault_files 索引。</p></div></div>
          <div class="card-body">${renderFileList(state.recentFiles.slice(0, 18))}</div>
        </div>
      </div>
    </div>
  `;
}

function renderDiagnostics() {
  return `
    <div class="layout-wide">
      <div class="grid">
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">高级设置</h2><p class="card-desc">和首次配置相同接口，适合改模型、OCR、抖音解析。</p></div><button class="btn primary" data-action="save-settings">保存</button></div>
          <div class="card-body">
            <div class="form-grid">
              ${field("setting-openaiBaseUrl", "模型 API 地址", state.settings?.openaiBaseUrl || "", "url", "http://43.128.146.66:8317/v1")}
              ${field("setting-openaiModel", "模型名称", state.settings?.openaiModel || "", "text", "gpt-5.5")}
              ${field("setting-openaiApiKey", "模型密钥", "", "password", "留空不覆盖")}
              ${field("setting-douyinParseApi", "抖音解析 API", state.settings?.douyinParseApi || "", "url", "https://api.bugpk.com/...")}
              ${field("setting-ocrFrameIntervalSeconds", "OCR 抽帧间隔秒", state.settings?.ocrFrameIntervalSeconds || 2, "number", "2")}
              ${field("setting-ocrMaxFrames", "OCR 最大帧数", state.settings?.ocrMaxFrames || 12, "number", "12")}
            </div>
            <div class="toolbar" style="margin-top:14px;">
              <button class="btn" data-action="test-openai">测模型</button>
              <button class="btn" data-action="test-github">测 GitHub</button>
              <button class="btn" data-action="test-douyin">测抖音</button>
              <button class="btn" data-action="test-tools">测工具</button>
              <button class="btn" data-action="test-ocr">测 OCR</button>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">意图日志</h2><p class="card-desc">排查为什么一句话被当作闲聊、项目搜索或知识入库。</p></div></div>
          <div class="card-body">${renderIntentLogs()}</div>
        </div>
      </div>
      <div class="grid">
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">系统健康</h2><p class="card-desc">后端真实返回，方便截图排错。</p></div></div>
          <div class="card-body"><div class="codebox">${escapeHtml(JSON.stringify({ health: state.health, settings: maskSettings(state.settings), status: state.status }, null, 2))}</div></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">平台日志</h2><p class="card-desc">所有 connector 最近事件。</p></div></div>
          <div class="card-body">${renderEventList(state.platformEvents.slice(0, 24))}</div>
        </div>
      </div>
    </div>
  `;
}

async function runAction(action, button) {
  button.disabled = true;
  try {
    if (action === "refresh") {
      await refreshForPage(state.page);
      toast("状态已刷新。");
    } else if (action === "send-message") {
      await sendMessage(false);
    } else if (action === "preview-message") {
      await sendMessage(true);
    } else if (action === "debug-intent") {
      await debugIntent();
    } else if (action === "save-settings") {
      await saveSettings();
    } else if (action.startsWith("test-")) {
      await testSetting(action.replace("test-", ""));
    } else if (action === "save-feishu") {
      await saveFeishu();
    } else if (["start-feishu", "stop-feishu"].includes(action)) {
      await postJson(`/api/connectors/feishu/${action === "start-feishu" ? "start" : "stop"}`, {});
      toast(action === "start-feishu" ? "已请求启动飞书长连接。" : "已停止飞书长连接。");
    } else if (action === "test-feishu") {
      const text = $("#feishu-test-text")?.value || "连接测试：请只回复收到，不写入 Obsidian。";
      const result = await postJson("/api/connectors/feishu/test", { text, senderId: "desktop-test" });
      toast(result.ok ? "飞书智能体测试完成。" : result.error || "飞书测试失败。");
    } else if (action === "send-test-feishu") {
      const result = await postJson("/api/connectors/feishu/send-test", {});
      toast(result.platform?.message || result.error || "已执行发送测试。");
    } else if (action === "copy-feishu-url") {
      await navigator.clipboard.writeText(feishuConnector()?.url || "");
      toast("已复制飞书回调地址。");
    } else if (action === "confirm-preview") {
      const preview = selectedPreview();
      if (!preview) throw new Error("请选择一个预览");
      const result = await postJson(`/api/previews/${encodeURIComponent(preview.previewId)}/confirm`, {});
      toast(writeResultText(result));
    } else if (action === "cancel-preview") {
      const preview = selectedPreview();
      if (!preview) throw new Error("请选择一个预览");
      await postJson(`/api/previews/${encodeURIComponent(preview.previewId)}/cancel`, {});
      toast("已取消这个预览。");
    } else if (action === "regenerate-preview") {
      const preview = selectedPreview();
      const extraText = $("#regenerate-text")?.value?.trim();
      if (!preview || !extraText) throw new Error("请选择预览并填写补充信息");
      const result = await postJson(`/api/previews/${encodeURIComponent(preview.previewId)}/regenerate`, { extraText });
      state.selectedPreviewId = result.previewId || result.preview?.previewId || state.selectedPreviewId;
      toast("已根据补充信息重新生成。");
    } else if (action === "load-markdown") {
      const preview = selectedPreview();
      if (!preview) throw new Error("请选择一个预览");
      state.selectedMarkdown = await getText(`/api/previews/${encodeURIComponent(preview.previewId)}/markdown`);
    } else if (action === "retry-run") {
      if (!state.selectedRunId) throw new Error("请选择一个 Run");
      await postJson(`/api/agent/runs/${encodeURIComponent(state.selectedRunId)}/retry`, {});
      toast("已提交重试。");
    } else if (action === "init-vault") {
      await postJson("/api/vault/init", {});
      await loadVault();
      toast("Vault 目录已初始化。");
    } else if (action === "open-vault") {
      await postJson("/api/vault/open-path", {});
      toast("已打开 Vault。");
    } else if (action === "check-links") {
      const result = await postJson("/api/vault/check-broken-links", {});
      toast(`断链检查完成：${Array.isArray(result.brokenLinks) ? result.brokenLinks.length : 0} 个问题。`);
    } else if (action === "search-vault") {
      const query = $("#vault-query")?.value?.trim();
      if (!query) throw new Error("请输入搜索关键词");
      const result = await postJson("/api/vault/search", { query });
      state.searchResults = result.results || [];
      toast(`找到 ${state.searchResults.length} 个结果。`);
    }
    await refreshForPage(state.page);
    render();
  } catch (error) {
    toast(messageOf(error));
  } finally {
    button.disabled = false;
  }
}

async function sendMessage(asPreview) {
  const textarea = $("#chat-text");
  const text = textarea?.value?.trim();
  if (!text) throw new Error("请输入要测试的消息");
  state.localChat.push({ role: "user", text });
  textarea.value = "";
  if (asPreview) {
    const result = await postJson("/api/ingest/preview", { text, source: "web", senderId: "desktop-user", messageId: `desktop-${Date.now()}` });
    state.selectedPreviewId = result.previewId;
    state.localChat.push({ role: "assistant", text: `已生成预览：${shortId(result.previewId)}。你可以在“任务与预览”里确认入库。` });
  } else {
    const result = await postJson("/agent/message", { text, source: "web", senderId: "desktop-user", messageId: `desktop-${Date.now()}`, autoWrite: false });
    state.localChat.push({ role: "assistant", text: result.reply || `处理完成：${result.action}` });
  }
  toast("测试消息已处理。");
}

async function debugIntent() {
  const text = $("#chat-text")?.value?.trim();
  if (!text) throw new Error("请输入要判别的文本");
  const result = await postJson("/api/agent/debug-intent", { text, source: "web", senderId: "desktop-user", messageId: `debug-${Date.now()}`, autoWrite: false });
  state.localChat.push({ role: "user", text });
  state.localChat.push({ role: "assistant", text: `意图：${result.intent?.type || result.intent?.intent || "unknown"}\n原因：${result.intent?.reason || "未返回原因"}` });
}

async function saveSettings() {
  const body = {};
  readSetting("obsidianVaultPath", body);
  readSetting("openaiBaseUrl", body);
  readSetting("openaiApiKey", body);
  readSetting("openaiModel", body);
  readSetting("githubToken", body);
  readSetting("douyinParseApi", body);
  readSetting("ocrFrameIntervalSeconds", body, Number);
  readSetting("ocrMaxFrames", body, Number);
  if (!Object.keys(body).length) throw new Error("没有可保存的字段");
  await patchJson("/api/settings", body);
  toast("配置已保存。");
}

function readSetting(key, body, transform = (value) => value) {
  const value = $(`#setting-${key}`)?.value?.trim();
  if (value) body[key] = transform(value);
}

async function saveFeishu() {
  const connector = feishuConnector();
  if (!connector) throw new Error("未找到飞书 connector");
  const fields = {};
  for (const fieldDef of connector.configFields || []) {
    const value = $(`#feishu-${fieldDef.key}`)?.value?.trim();
    if (value) fields[fieldDef.key] = value;
  }
  const publicBaseUrl = $("#feishu-publicBaseUrl")?.value?.trim();
  const body = { enabled: true, fields };
  if (publicBaseUrl) body.publicBaseUrl = publicBaseUrl;
  await patchJson("/api/connectors/feishu/config", body);
  toast("飞书配置已保存。");
}

async function testSetting(kind) {
  const urlMap = {
    openai: "/api/settings/test/openai",
    github: "/api/settings/test/github",
    douyin: "/api/settings/test/douyin",
    tools: "/api/settings/test/tools",
    ocr: "/api/settings/test/ocr"
  };
  const result = await postJson(urlMap[kind], {});
  toast(result.ok ? `${kind} 测试通过。` : result.error || `${kind} 测试未通过。`);
}

function renderEventList(items) {
  if (!items.length) return empty("暂无平台日志。");
  return `<div class="list">${items.map((item) => `
    <div class="list-item">
      <div class="split"><strong>${escapeHtml(sourceLabel(item.source, true))} · ${escapeHtml(item.eventType || item.event_type || "event")}</strong>${statusPill(item.status)}</div>
      <div>${escapeHtml(item.message || "")}</div>
      <div class="help">${formatTime(item.createdAt || item.created_at)}</div>
    </div>
  `).join("")}</div>`;
}

function renderFileList(files) {
  if (!files.length) return empty("暂无写入索引。");
  return `<div class="list">${files.map((file) => `
    <div class="list-item">
      <div class="split"><strong>${escapeHtml(file.title || file.noteId || file.path)}</strong><span class="pill blue">${escapeHtml(file.type || "note")}</span></div>
      <div class="mono help">${escapeHtml(file.path || "")}</div>
      <div class="help">${formatTime(file.updatedAt || file.createdAt)}</div>
    </div>
  `).join("")}</div>`;
}

function renderIntentLogs() {
  if (!state.intentLogs.length) return empty("暂无意图判别日志。");
  return `<div class="list">${state.intentLogs.slice(0, 12).map((log) => `
    <div class="list-item">
      <div class="split"><strong>${escapeHtml(log.intent || log.intentType || "intent")}</strong><span class="pill blue">${escapeHtml(String(log.confidence ?? ""))}</span></div>
      <div>${escapeHtml(log.text || log.rawText || log.reason || "")}</div>
      <div class="help">${escapeHtml(log.reason || "")} · ${formatTime(log.createdAt || log.created_at)}</div>
    </div>
  `).join("")}</div>`;
}

function testButton(kind, title, desc) {
  return `<div class="list-item"><div class="split"><div><strong>${escapeHtml(title)}</strong><div class="help">${escapeHtml(desc)}</div></div><button class="btn small" data-action="test-${escapeAttr(kind)}">测试</button></div></div>`;
}

function tip(title, text) {
  return `<div class="list-item"><strong>${escapeHtml(title)}</strong><div class="help">${escapeHtml(text)}</div></div>`;
}

function field(id, label, value = "", type = "text", placeholder = "", help = "") {
  return `<div class="field"><label for="${escapeAttr(id)}">${escapeHtml(label)}</label><input id="${escapeAttr(id)}" type="${escapeAttr(type)}" value="${escapeAttr(String(value ?? ""))}" placeholder="${escapeAttr(placeholder)}">${help ? `<div class="help">${escapeHtml(help)}</div>` : ""}</div>`;
}

function mini(label, value, tone = "") {
  return `<div class="list-item"><span class="help">${escapeHtml(label)}</span><strong>${escapeHtml(String(value || "—"))}</strong><span class="pill ${tone}">${escapeHtml(tone || "状态")}</span></div>`;
}

function empty(text) {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function selectedPreview() {
  return state.previews.find((item) => item.previewId === state.selectedPreviewId);
}

function selectedRun() {
  return state.runs.find((item) => item.id === state.selectedRunId);
}

function feishuConnector() {
  return state.connectors.find((item) => item.source === "feishu");
}

function serviceOk() {
  return Boolean(state.health?.ok || databaseOk());
}

function databaseOk() {
  return state.health?.database === "ok" || state.health?.database?.ok || state.settings?.database?.ok;
}

function sourceLabel(source, textOnly = false) {
  const map = { web: "网页", feishu: "飞书", douyin: "抖音", github: "GitHub", qq: "QQ", wechat: "微信", telegram: "Telegram", generic: "Webhook" };
  const label = map[source] || source || "未知";
  return textOnly ? label : `<span class="pill blue">${escapeHtml(label)}</span>`;
}

function statusPill(status) {
  const value = String(status || "unknown");
  const tone = /(success|ok|completed|committed|confirmed|running|ready|pending|waiting)/i.test(value)
    ? /(running|pending|waiting)/i.test(value) ? "blue" : "ok"
    : /(fail|error|cancel|bad)/i.test(value) ? "bad" : "warn";
  return `<span class="pill ${tone}">${escapeHtml(value)}</span>`;
}

function nodeName(name) {
  const map = {
    load_context: "读取上下文",
    intent_router: "意图判断",
    intent_router_v2: "意图判断",
    parse_input: "解析输入",
    source_parser: "来源解析",
    douyin_pipeline: "抖音解析",
    github_pipeline: "GitHub 研究",
    github_project_lookup: "项目检索",
    vault_context_retriever: "检索知识库",
    knowledge_extractor: "提取知识",
    idea_generator: "生成联想",
    note_planner: "规划笔记",
    preview_builder: "生成预览",
    quality_checker: "质量检查",
    reply_builder: "生成回复",
    vault_commit: "写入 Vault"
  };
  return map[name] || name;
}

function sortByTime(items, keys) {
  return [...items].sort((a, b) => firstTime(b, keys) - firstTime(a, keys));
}

function firstTime(item, keys) {
  for (const key of keys) {
    const value = item?.[key] || item?.[snake(key)];
    if (!value) continue;
    const time = new Date(value).getTime();
    if (Number.isFinite(time)) return time;
  }
  return 0;
}

function snake(value) {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function shortId(id) {
  if (!id) return "—";
  const value = String(id);
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function writeResultText(result) {
  const files = result.writtenFiles || result.files || result.writes || [];
  if (Array.isArray(files)) return `已写入 Obsidian：${files.length} 个文件。`;
  return result.reply || "已确认入库。";
}

function maskSettings(settings) {
  if (!settings) return null;
  return {
    ...settings,
    openaiApiKey: settings.openaiConfigured ? "*** configured ***" : undefined,
    githubToken: settings.githubTokenConfigured ? "*** configured ***" : undefined
  };
}

function isEditing() {
  const active = document.activeElement;
  return Boolean(active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName));
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || json.message || `${url} ${response.status}`);
  return json;
}

async function getText(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(text || `${url} ${response.status}`);
  return text;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || json.message || `${url} ${response.status}`);
  return json;
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || json.message || `${url} ${response.status}`);
  return json;
}

function toast(message) {
  const element = $("#toast");
  if (!element) return;
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 4200);
}

function messageOf(error) {
  return error?.message || String(error);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function icon(name) {
  const icons = {
    home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>`,
    sliders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16"/><path d="M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/></svg>`,
    message: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>`,
    queue: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg>`,
    database: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>`,
    gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7A2 2 0 0 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>`,
    server: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="6" rx="2"/><rect x="4" y="14" width="16" height="6" rx="2"/><path d="M8 7h.01M8 17h.01"/></svg>`,
    send: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.7 3.3 2.9 10.9c-1.2.5-1.1 2.2.2 2.5l5.1 1.1 1.1 5.2c.3 1.3 2 1.5 2.6.3l9.3-17.7c.4-.8-.4-1.6-1.5-1Z"/></svg>`,
    vault: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 3h10l5 9-5 9H7l-5-9 5-9Zm5 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/></svg>`,
    brain: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6a3 3 0 0 0-5 2.2A3 3 0 0 0 5 13a3 3 0 0 0 3 5"/><path d="M16 6a3 3 0 0 1 5 2.2A3 3 0 0 1 19 13a3 3 0 0 1-3 5"/><path d="M8 6v12M16 6v12M8 12h8"/></svg>`,
    github: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .7a11.3 11.3 0 0 0-3.6 22c.6.1.8-.2.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.1.1 1.8 1.2 1.8 1.2 1 .1.8 2.8 3.5 2 .1-.8.4-1.3.7-1.6-2.6-.3-5.4-1.3-5.4-5.8 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.5-2.8 5.5-5.4 5.8.4.4.8 1.1.8 2.2v3.2c0 .4.2.7.8.6A11.3 11.3 0 0 0 12 .7Z"/></svg>`,
    ocr: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 4h4M15 4h4M5 20h4M15 20h4M4 5v4M20 5v4M4 15v4M20 15v4"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>`,
    folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`,
    file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/></svg>`
  };
  return icons[name] || icons.file;
}
