const pageDefs = [
  { id: "dashboard", title: "今日摄入", subtitle: "从聊天入口到 Obsidian 的本机智能体流水线" },
  { id: "chat", title: "对话测试", subtitle: "本地模拟聊天入口，验证意图判别、预览、确认和写入链路" },
  { id: "connectors", title: "接入通道", subtitle: "真实平台 SDK、长连接、回调地址和连接测试" },
  { id: "previews", title: "预览确认", subtitle: "只把主知识/主项目写入 Obsidian，额外联想只回到对话" },
  { id: "pipeline", title: "处理流水线", subtitle: "查看 Job、Agent Run、节点日志和工具调用" },
  { id: "vault", title: "知识库", subtitle: "Vault 目录、最近写入、搜索和断链检查" },
  { id: "settings", title: "配置", subtitle: "模型、GitHub、抖音解析、OCR 和本机工具检查" }
];

const state = {
  page: location.hash.replace("#", "") || "dashboard",
  source: "web",
  health: null,
  status: null,
  settings: null,
  connectors: [],
  jobs: [],
  previews: [],
  runs: [],
  activity: [],
  platformEvents: [],
  steps: [],
  toolCalls: [],
  vaultStatus: null,
  vaultTree: [],
  recentFiles: [],
  selectedConnector: "feishu",
  selectedPreviewId: "",
  selectedRunId: "",
  selectedJobId: "",
  selectedMarkdown: "",
  chatLog: [],
  autoFollowPreview: true,
  autoFollowRun: true,
  autoFollowJob: true,
  lastUpdatedAt: "",
  lastDataSignature: "",
  pendingVisualRefresh: false,
  refreshInFlight: false,
  refreshError: ""
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", () => {
  prepareShell();
  bindGlobalEvents();
  refreshAll().then(() => render()).catch((error) => toast(`启动页面失败：${error.message}`));
  setInterval(() => refreshRealtime(), 3000);
});

function prepareShell() {
  $$(".nav-item").forEach((item, index) => {
    item.dataset.page = pageDefs[index]?.id || "dashboard";
    const text = item.childNodes[item.childNodes.length - 1];
    if (text?.nodeType === Node.TEXT_NODE) {
      const span = document.createElement("span");
      span.textContent = text.textContent.trim();
      item.replaceChild(span, text);
    }
  });
  $(".content-area").classList.add("page-mode");
}

function bindGlobalEvents() {
  document.addEventListener("click", async (event) => {
    const nav = event.target.closest(".nav-item");
    if (nav) {
      event.preventDefault();
      state.page = nav.dataset.page || "dashboard";
      location.hash = state.page;
      await refreshForPage(state.page);
      render();
      return;
    }

    const button = event.target.closest("[data-action]");
    if (!button) return;
    event.preventDefault();
    await runAction(button.dataset.action, button);
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target.matches("[data-source]")) {
      state.source = target.dataset.source;
      render();
    }
    if (target.matches("[data-select-connector]")) {
      state.selectedConnector = target.value;
      render();
    }
    if (target.matches("[data-select-run]")) {
      state.selectedRunId = target.value;
      state.autoFollowRun = false;
      loadRunDetails().then(render).catch((error) => toast(error.message));
    }
  });

  window.addEventListener("hashchange", () => {
    const next = location.hash.replace("#", "") || "dashboard";
    if (pageDefs.some((page) => page.id === next)) {
      state.page = next;
      refreshForPage(next).then(render).catch((error) => toast(error.message));
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshRealtime(true);
  });

  window.addEventListener("focus", () => refreshRealtime(true));
}

async function refreshAll() {
  const [health, status, settings, connectors, jobs, previews, runs, activity, platformEvents, recentFiles] = await Promise.all([
    getJson("/api/system/health"),
    getJson("/api/system/status").catch(() => null),
    getJson("/api/settings"),
    getJson("/api/connectors"),
    getJson("/api/ingest/jobs?limit=60"),
    getJson("/api/previews?limit=60"),
    getJson("/api/agent/runs?limit=30"),
    getJson("/activity?limit=80").catch(() => ({ activity: [] })),
    getJson("/api/connectors/logs?limit=80").catch(() => ({ logs: [] })),
    getJson("/api/vault/recent-files?limit=50").catch(() => ({ files: [] }))
  ]);

  state.health = health;
  state.status = status;
  state.settings = settings;
  state.connectors = connectors.connectors || [];
  state.jobs = sortByTime(jobs.jobs || [], ["createdAt", "updatedAt"]);
  state.previews = sortByTime(previews.previews || [], ["createdAt", "updatedAt"]);
  state.runs = sortByTime(runs.runs || [], ["startedAt", "endedAt"]);
  state.activity = sortByTime(activity.activity || [], ["createdAt"]);
  state.platformEvents = sortByTime(platformEvents.logs || [], ["createdAt"]);
  state.recentFiles = sortByTime(recentFiles.files || [], ["updatedAt", "createdAt"]);
  state.lastUpdatedAt = new Date().toISOString();
  state.refreshError = "";

  if (!state.selectedConnector || !state.connectors.some((item) => item.source === state.selectedConnector)) {
    state.selectedConnector = state.connectors.find((item) => item.source === "feishu")?.source || state.connectors[0]?.source || "web";
  }
  const latestPreview = state.previews.find((item) => item.status === "pending") || state.previews[0];
  if (state.autoFollowPreview || !state.selectedPreviewId || !state.previews.some((item) => item.previewId === state.selectedPreviewId)) {
    state.selectedPreviewId = latestPreview?.previewId || "";
  }
  if (state.autoFollowRun || !state.selectedRunId || !state.runs.some((item) => item.id === state.selectedRunId)) {
    state.selectedRunId = state.runs[0]?.id || "";
  }
  if (state.autoFollowJob || !state.selectedJobId || !state.jobs.some((item) => item.id === state.selectedJobId)) {
    state.selectedJobId = state.jobs[0]?.id || "";
  }

  await loadRunDetails();
  if (["vault"].includes(state.page)) await loadVault();
  state.lastDataSignature = dataSignature();
}

async function refreshForPage(page) {
  if (["dashboard", "chat", "connectors", "previews", "pipeline", "settings"].includes(page)) {
    await refreshAll();
  }
  if (page === "vault") {
    await refreshAll();
    await loadVault();
  }
}

async function refreshRealtime(force = false) {
  if (state.refreshInFlight || document.hidden) return;
  state.refreshInFlight = true;
  const before = state.lastDataSignature;
  try {
    await refreshForPage(state.page);
    const changed = force || before !== state.lastDataSignature;
    if (state.pendingVisualRefresh && !isEditing()) {
      state.pendingVisualRefresh = false;
      render();
      return;
    }
    if (changed) {
      if (isEditing()) {
        state.pendingVisualRefresh = true;
        renderHeader();
      } else {
        state.pendingVisualRefresh = false;
        render();
      }
    } else {
      renderHeader();
    }
  } catch (error) {
    state.refreshError = error.message || String(error);
    renderHeader();
  } finally {
    state.refreshInFlight = false;
  }
}

function dataSignature() {
  return JSON.stringify({
    page: state.page,
    health: state.health?.ok,
    connectors: state.connectors.map((item) => [item.source, item.enabled, item.lastRequestAt, item.lastError, item.setupStatus?.configured]),
    jobs: state.jobs.slice(0, 20).map((item) => [item.id, item.status, item.currentNode, item.previewId, item.updatedAt]),
    previews: state.previews.slice(0, 20).map((item) => [item.previewId, item.status, item.updatedAt, item.notesToWrite?.length, item.ideas?.length]),
    runs: state.runs.slice(0, 10).map((item) => [item.id, item.status, item.endedAt]),
    activity: state.activity.slice(0, 12).map((item) => [item.id, item.status, item.createdAt, item.detail]),
    platformEvents: state.platformEvents.slice(0, 12).map((item) => [item.id, item.source, item.eventType, item.status, item.message, item.createdAt]),
    recentFiles: state.recentFiles.slice(0, 12).map((item) => [item.id, item.type, item.title, item.path, item.updatedAt]),
    steps: state.steps.slice(0, 20).map((item) => [item.id, item.status, item.nodeName || item.node_name, item.createdAt || item.created_at]),
    toolCalls: state.toolCalls.slice(0, 20).map((item) => [item.id, item.status, item.toolName || item.tool_name]),
    vault: state.page === "vault" ? [state.vaultTree.length, state.recentFiles.length, state.vaultStatus?.writable] : undefined
  });
}

function sortByTime(items, keys) {
  return [...items].sort((left, right) => {
    const leftTime = firstTime(left, keys);
    const rightTime = firstTime(right, keys);
    return rightTime - leftTime;
  });
}

function firstTime(item, keys) {
  for (const key of keys) {
    const value = item?.[key];
    if (!value) continue;
    const time = new Date(value).getTime();
    if (Number.isFinite(time)) return time;
  }
  return 0;
}

function isEditing() {
  const active = document.activeElement;
  if (!active) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
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

async function loadVault() {
  const [vaultStatus, tree, recent] = await Promise.all([
    getJson("/api/vault/status"),
    getJson("/api/vault/tree"),
    getJson("/api/vault/recent-files?limit=50")
  ]);
  state.vaultStatus = vaultStatus;
  state.vaultTree = tree.tree || [];
  state.recentFiles = sortByTime(recent.files || [], ["updatedAt", "createdAt"]);
}

function render() {
  renderHeader();
  renderNav();
  const page = pageDefs.find((item) => item.id === state.page) || pageDefs[0];
  const content = $(".content-area");
  content.innerHTML = `
    <div class="page-shell">
      ${renderPage(page)}
    </div>
  `;
}

function renderHeader() {
  const ok = Boolean(state.health?.ok);
  const vaultPath = state.health?.vault?.path || state.settings?.obsidianVaultPath || "/Users/sky/Documents/obsidian/sky";
  const model = state.health?.model?.model || state.settings?.openaiModel || "未配置";
  const liveText = state.refreshError
    ? `同步异常：${state.refreshError.slice(0, 40)}`
    : state.pendingVisualRefresh
      ? "有新数据，输入结束后刷新"
      : `实时同步 ${formatTime(state.lastUpdatedAt)}`;
  $(".header").innerHTML = `
    <div class="header-item"><span class="status-dot ${ok ? "green" : "red"}"></span>${ok ? "服务在线" : "服务异常"}</div>
    <div class="header-divider"></div>
    <div class="header-item live-indicator ${state.refreshError ? "error" : ""}"><span class="live-pulse"></span>${escapeHtml(liveText)}</div>
    <div class="header-divider"></div>
    <div class="header-item">本地模式</div>
    <div class="header-divider"></div>
    <div class="header-item">${folderIcon()}${escapeHtml(vaultPath)}</div>
    <div class="header-divider"></div>
    <div class="header-item">模型 ${escapeHtml(model)}</div>
    <div class="avatar">S</div>
  `;
  $(".sidebar-footer").innerHTML = `
    <div class="status"><span class="status-dot ${ok ? "green" : "red"}"></span>${ok ? "服务在线" : "服务异常"}</div>
    <div class="text-tertiary">v0.3.0</div>
  `;
}

function renderNav() {
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === state.page));
}

function renderPage(page) {
  const views = {
    dashboard: renderDashboard,
    chat: renderChat,
    connectors: renderConnectors,
    previews: renderPreviews,
    pipeline: renderPipeline,
    vault: renderVault,
    settings: renderSettings
  };
  return views[page.id]();
}

function pageTitle(title, subtitle, action = "") {
  return `
    <div class="section-header">
      <div>
        <h1 class="page-title">${escapeHtml(title)}</h1>
        <p class="page-subtitle">${escapeHtml(subtitle)}</p>
      </div>
      <div class="title-actions">
        <span class="refresh-chip ${state.pendingVisualRefresh ? "pending" : ""}">${state.pendingVisualRefresh ? "有新数据待显示" : `更新 ${formatTime(state.lastUpdatedAt)}`}</span>
        ${action || `<button class="btn btn-default btn-small" data-action="refresh">刷新</button>`}
      </div>
    </div>
  `;
}

function renderDashboard() {
  const page = pageDefs[0];
  return `
    <div class="wide-col">
      ${pageTitle(page.title, page.subtitle)}
      <div class="status-tags-container">${healthTags()}</div>
      ${quickIngestCard("快速投喂")}
      ${statsGrid()}
      ${jobsTable(state.jobs.slice(0, 8))}
    </div>
    <div class="compact-col">
      ${currentRunPanel()}
      ${recentWritesPanel()}
      ${platformEventsPanel()}
    </div>
  `;
}

function renderChat() {
  const page = pageDefs[1];
  const messages = state.chatLog.length ? state.chatLog.map((item) => `
    <div class="chat-bubble ${item.role}">${escapeHtml(item.text)}</div>
  `).join("") : `
    <div class="chat-bubble agent">这里模拟飞书、网页和 API 的自然对话入口。普通寒暄不会入库，明确链接或知识输入才会进入预览。</div>
  `;

  return `
    <div class="wide-col">
      ${pageTitle(page.title, page.subtitle)}
      <div class="detail-card">
        <div class="chat-log">${messages}</div>
        ${quickIngestCard("发送一条本地测试消息", true)}
      </div>
      ${jobsTable(state.jobs.slice(0, 5))}
    </div>
    <div class="compact-col">
      <div class="right-panel">
        <div class="panel-header"><div class="panel-title">对话策略</div><span class="running-badge">已启用</span></div>
        <div class="detail-text">寒暄和讨论只正常回复；抖音、GitHub、网页、明确知识点才触发预览卡片。额外联想只回到聊天，不额外写 Obsidian。</div>
        <div class="info-box">${infoIcon()}<div>网页测试走同一套 /api/ingest/preview 链路，可复现飞书入口前的 Agent 行为。</div></div>
      </div>
    </div>
  `;
}

function renderConnectors() {
  const page = pageDefs[2];
  const selected = selectedConnector();
  return `
    <div class="wide-col">
      ${pageTitle(page.title, page.subtitle, `<button class="btn btn-default" data-action="refresh">刷新状态</button>`)}
      <div class="connector-grid">
        ${state.connectors.map((connector) => connectorCard(connector)).join("")}
      </div>
    </div>
    <div class="compact-col">
      ${connectorDetail(selected)}
      ${platformEventsPanel(selected?.source)}
    </div>
  `;
}

function renderPreviews() {
  const page = pageDefs[3];
  const selected = selectedPreview();
  return `
    <div class="compact-col">
      ${pageTitle(page.title, page.subtitle, `<button class="btn btn-default btn-small" data-action="follow-latest-preview">${state.autoFollowPreview ? "正在跟随最新" : "跟随最新"}</button>`)}
      <div class="record-list">
        ${state.previews.length ? state.previews.map(previewRecord).join("") : `<div class="empty-state">暂无预览。</div>`}
      </div>
    </div>
    <div class="wide-col">
      ${previewDetail(selected)}
    </div>
  `;
}

function renderPipeline() {
  const page = pageDefs[4];
  const run = selectedRun();
  return `
    <div class="wide-col">
      ${pageTitle(page.title, page.subtitle, `${runSelector()}<button class="btn btn-default btn-small" data-action="follow-latest-run">${state.autoFollowRun ? "正在跟随最新" : "跟随最新"}</button>`)}
      <div class="detail-card">
        <div class="panel-header"><div class="panel-title">节点日志</div><span class="running-badge">${escapeHtml(statusName(run?.status))}</span></div>
        <div class="timeline">${timelineItems(run)}</div>
      </div>
      <div class="detail-card">
        <div class="section-header"><div class="section-title">工具调用</div><button class="btn btn-default btn-small" data-action="retry-run">重跑当前 Run</button></div>
        ${toolCallsTable()}
      </div>
    </div>
    <div class="compact-col">
      ${runDetailPanel(run)}
    </div>
  `;
}

function renderVault() {
  const page = pageDefs[5];
  const files = state.vaultTree.filter((item) => item.type === "file").length;
  const dirs = state.vaultTree.filter((item) => item.type === "dir").length;
  return `
    <div class="wide-col">
      ${pageTitle(page.title, page.subtitle, `
        <div class="btn-group">
          <button class="btn btn-default" data-action="init-vault">初始化目录</button>
          <button class="btn btn-primary" data-action="open-vault">${folderIcon()}打开 Vault</button>
        </div>
      `)}
      <div class="mini-grid">
        ${miniCard("Vault", state.vaultStatus?.writable ? "可写" : "异常", state.vaultStatus?.writable ? "c-success" : "c-error")}
        ${miniCard("目录", dirs, "c-primary")}
        ${miniCard("文件", files, "c-success")}
      </div>
      <div class="detail-card" style="margin-top:16px;">
        <div class="section-header">
          <div class="section-title">Vault 搜索</div>
          <button class="btn btn-default btn-small" data-action="check-links">检查断链</button>
        </div>
        <div class="field"><input id="vaultSearch" placeholder="搜索文件路径，例如 LangGraph / 飞书 / FRP" autocomplete="off" spellcheck="false"></div>
        <div class="action-row"><button class="btn btn-primary" data-action="search-vault">搜索</button><span id="vaultSearchResult" class="muted"></span></div>
      </div>
      <div class="table-card tree-list">${vaultTreeList()}</div>
    </div>
    <div class="compact-col">
      <div class="right-panel">
        <div class="panel-header"><div class="panel-title">最近写入计划</div><span class="running-badge">${state.recentFiles.length}</span></div>
        <div class="record-list">
          ${state.recentFiles.slice(0, 10).map((file) => `
            <div class="record-item">
              <div class="record-title">${escapeHtml(file.title || file.path || "未命名")}</div>
              <div class="record-meta">${escapeHtml(file.path || file.type || "")}</div>
            </div>
          `).join("") || `<div class="empty-state">暂无记录。</div>`}
        </div>
      </div>
    </div>
  `;
}

function renderSettings() {
  const page = pageDefs[6];
  const settings = state.settings || {};
  return `
    <div class="wide-col">
      ${pageTitle(page.title, page.subtitle)}
      <div class="detail-card">
        <div class="section-header"><div class="section-title">基础配置</div><span class="muted">密钥留空表示不修改</span></div>
        <div class="form-grid">
          ${inputField("obsidianVaultPath", "Obsidian Vault 路径", settings.obsidianVaultPath || "")}
          ${inputField("openaiBaseUrl", "OpenAI 兼容 API 地址", settings.openaiBaseUrl || "")}
          ${inputField("openaiModel", "模型", settings.openaiModel || "")}
          ${inputField("openaiApiKey", `模型密钥（${settings.openaiConfigured ? "已配置" : "未配置"}）`, "", "password")}
          ${inputField("githubToken", `GitHub Token（${settings.githubTokenConfigured ? "已配置" : "未配置"}）`, "", "password")}
          ${inputField("douyinParseApi", "抖音解析接口", settings.douyinParseApi || "")}
          ${inputField("ocrFrameIntervalSeconds", "OCR 抽帧间隔秒", settings.ocrFrameIntervalSeconds || 4, "number")}
          ${inputField("ocrMaxFrames", "OCR 最大帧数", settings.ocrMaxFrames || 8, "number")}
        </div>
        <div class="action-row">
          <button class="btn btn-primary" data-action="save-settings">保存配置</button>
          <button class="btn btn-default" data-action="test-openai">测试模型</button>
          <button class="btn btn-default" data-action="test-github">测试 GitHub</button>
          <button class="btn btn-default" data-action="test-douyin">测试抖音</button>
          <button class="btn btn-default" data-action="test-tools">测试本机工具</button>
          <button class="btn btn-default" data-action="test-ocr">测试 OCR</button>
        </div>
      </div>
    </div>
    <div class="compact-col">
      <div class="right-panel">
        <div class="panel-header"><div class="panel-title">当前状态</div><span class="running-badge">${state.health?.ok ? "正常" : "异常"}</span></div>
        <div class="info-grid">
          <div class="info-label">数据库</div><div class="info-value">${state.health?.database || settings.database?.path || "—"}</div>
          <div class="info-label">Vault</div><div class="info-value">${state.health?.vault?.writable ? "可写" : "不可写"}</div>
          <div class="info-label">ffmpeg</div><div class="info-value">${state.health?.tools?.ffmpeg ? "可用" : "不可用"}</div>
          <div class="info-label">OCR</div><div class="info-value">${state.health?.tools?.tesseract ? "可用" : "不可用"}</div>
        </div>
        <div class="info-box">${infoIcon()}<div>配置写入本机 .env，前端不会回显密钥明文。</div></div>
      </div>
    </div>
  `;
}

function quickIngestCard(title, chatMode = false) {
  return `
    <div class="card input-card">
      <h2 class="input-title">${escapeHtml(title)}</h2>
      <div class="textarea-wrapper">
        <textarea id="quickText" placeholder="粘贴抖音链接、GitHub 链接，或直接说一个想法"></textarea>
      </div>
      <div class="input-actions">
        <div class="source-tags">
          来源
          ${sourceButton("web", "网页", globeIcon())}
          ${sourceButton("feishu", "飞书", paperPlaneIcon())}
          ${sourceButton("telegram", "Telegram", bellIcon())}
          ${sourceButton("api", "API", `<span class="icon-api" style="width:24px;height:14px;border-radius:2px;">API</span>`)}
        </div>
        <div class="btn-group">
          <button class="btn btn-default" data-action="submit-preview">${chatMode ? "生成预览" : "生成预览"}</button>
          <button class="btn btn-primary" data-action="submit-agent">${paperPlaneIcon()}发送给智能体</button>
        </div>
      </div>
    </div>
  `;
}

function sourceButton(source, label, iconSvg) {
  return `<div class="source-tag ${state.source === source ? "selected" : ""}" data-source="${source}">${iconSvg}<span>${escapeHtml(label)}</span></div>`;
}

function healthTags() {
  const feishu = state.connectors.find((item) => item.source === "feishu");
  const feishuOnline = Boolean(feishu?.setupStatus?.configured && feishu?.lastRequestAt);
  const tools = state.health?.tools || {};
  return [
    tag("服务在线", state.health?.ok),
    tag("Vault 可写", state.health?.vault?.writable),
    tag("飞书回调", feishuOnline),
    tag(`模型 ${state.health?.model?.model || "未配置"}`, state.health?.model?.configured),
    tag("OCR 可用", tools.ffmpeg && tools.tesseract)
  ].join("");
}

function statsGrid() {
  const todayChina = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const todayJobs = state.jobs.filter((job) => (job.createdAt || "").startsWith(todayChina)).length;
  const pending = state.previews.filter((preview) => preview.status === "pending").length;
  const failed = state.jobs.filter((job) => job.status === "failed").length;
  const committed = state.jobs.filter((job) => job.status === "committed").length;
  return `
    <div class="stats-grid">
      ${stat("待确认", pending, "c-warning")}
      ${stat("失败", failed, "c-error")}
      ${stat("今日消息", todayJobs || state.jobs.length, "c-primary")}
      ${stat("已写入", committed, "c-success")}
    </div>
  `;
}

function jobsTable(jobs) {
  const rows = jobs.map((job) => {
    const preview = state.previews.find((item) => item.previewId === job.previewId);
    return `
      <tr>
        <td><div class="source-cell">${sourceIcon(job.source)}${sourceName(job.source)}</div></td>
        <td><span class="status-badge ${statusBadge(job.status)}">${statusName(job.status)}</span></td>
        <td>${escapeHtml(nodeName(job.currentNode || "-"))}</td>
        <td>${preview ? `<a class="link" data-action="select-preview" data-id="${escapeAttr(preview.previewId)}">预览 ${shortId(preview.previewId)}</a>` : "—"}</td>
        <td class="text-gray">${formatTime(job.updatedAt || job.createdAt)}</td>
      </tr>
    `;
  }).join("");
  return `
    <div class="table-card">
      <table>
        <thead><tr><th>来源</th><th>状态</th><th>当前节点</th><th>预览</th><th>时间</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="text-gray">暂无任务，粘贴一条抖音或 GitHub 链接试试。</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

function currentRunPanel() {
  const run = state.runs[0];
  const job = run ? state.jobs.find((item) => item.id === run.jobId) : state.jobs[0];
  return `
    <div class="right-panel">
      <div class="panel-header"><div class="panel-title">当前运行</div><div class="running-badge">${run ? statusName(run.status) : "空闲"}</div></div>
      <div class="info-grid">
        <div class="info-label">任务</div><div class="info-value">${shortId(job?.id || run?.jobId || "—")}</div>
        <div class="info-label">来源</div><div class="info-value">${sourceIcon(job?.source || run?.inputState?.job?.source || "web")}${sourceName(job?.source || run?.inputState?.job?.source || "web")}</div>
        <div class="info-label">接收时间</div><div class="info-value">${formatTime(job?.createdAt || run?.startedAt)}</div>
      </div>
      <div class="timeline">${timelineItems(run)}</div>
      ${activityPanelMini()}
      <div class="info-box">${infoIcon()}<div>主知识 / 项目进入 Obsidian，应用想法只返回对话。</div></div>
    </div>
  `;
}

function platformEventsPanel(source) {
  const events = (source ? state.platformEvents.filter((item) => item.source === source) : state.platformEvents).slice(0, 8);
  return `
    <div class="right-panel" style="margin-top:16px;">
      <div class="panel-header"><div class="panel-title">平台事件</div><span class="running-badge">${events.length}</span></div>
      <div class="record-list">
        ${events.map((event) => `
          <div class="event-row">
            <div class="event-head">
              <span class="status-dot ${event.status === "failed" ? "red" : "green"}"></span>
              <strong>${escapeHtml(sourceName(event.source))}</strong>
              <span>${escapeHtml(event.eventType)}</span>
              <span class="muted">${formatTime(event.createdAt)}</span>
            </div>
            <div class="event-message">${escapeHtml(formatEventMessage(event))}</div>
          </div>
        `).join("") || `<div class="empty-state">暂无平台事件。</div>`}
      </div>
    </div>
  `;
}

function formatEventMessage(event) {
  if (event.eventType === "ignored_callback") return event.message || "已忽略非文本事件";
  if (event.eventType === "request") return "收到平台 HTTP 回调";
  if (event.eventType === "reply") return event.message || "已回复平台";
  return event.message || "平台事件";
}

function activityPanelMini() {
  const items = state.activity.slice(0, 5);
  if (!items.length) return "";
  return `
    <div class="mini-activity">
      <div class="mini-activity-title">最新动态</div>
      ${items.map((item) => `
        <div class="mini-activity-item">
          <span class="status-dot ${item.status === "error" ? "red" : "green"}"></span>
          <div>
            <div class="mini-activity-step">${escapeHtml(item.step || "处理")}</div>
            <div class="mini-activity-detail">${escapeHtml(item.detail || "")}</div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function recentWritesPanel() {
  const files = state.recentFiles.slice(0, 8);
  return `
    <div class="right-panel" style="margin-top:16px;">
      <div class="panel-header"><div class="panel-title">最近入库</div><span class="running-badge">${files.length}</span></div>
      <div class="record-list">
        ${files.map((file) => `
          <div class="event-row">
            <div class="event-head">
              <span class="status-dot green"></span>
              <strong>${escapeHtml(noteTypeLabel(file.type))}</strong>
              <span class="muted">${formatTime(file.updatedAt || file.createdAt)}</span>
            </div>
            <div class="event-message"><strong>${escapeHtml(file.title || "未命名")}</strong><br>${escapeHtml(file.path || "")}</div>
          </div>
        `).join("") || `<div class="empty-state">暂无入库文件。</div>`}
      </div>
    </div>
  `;
}

function connectorCard(connector) {
  const configured = connector.setupStatus?.configured;
  const active = connector.source === state.selectedConnector;
  return `
    <button class="connector-card ${active ? "active" : ""}" data-action="select-connector" data-id="${escapeAttr(connector.source)}">
      <div class="source-cell">${sourceIcon(connector.source)}<h3>${escapeHtml(connector.label)}</h3></div>
      <p>${escapeHtml(connector.description || "")}</p>
      <div class="pill-row">
        <span class="status-badge ${configured ? "badge-success" : "badge-warning"}">${configured ? "配置完整" : "待配置"}</span>
        <span class="pill">${escapeHtml(connector.mode || "protocol")}</span>
        <span class="pill">${connector.enabled ? "已启用" : "已停用"}</span>
      </div>
    </button>
  `;
}

function connectorDetail(connector) {
  if (!connector) return `<div class="right-panel"><div class="empty-state">请选择一个接入通道。</div></div>`;
  const fields = connector.configFields || [];
  return `
    <div class="right-panel">
      <div class="panel-header"><div class="panel-title">${escapeHtml(connector.label)}</div><span class="running-badge">${connector.setupStatus?.configured ? "可用" : "待配置"}</span></div>
      <div class="detail-text">${escapeHtml(connector.description || "")}</div>
      <div class="detail-card" style="padding:12px;margin-top:16px;">
        <div class="mini-label">回调地址</div>
        <div class="code-block">${escapeHtml(connector.url || connector.endpoint || "")}</div>
        <div class="action-row"><button class="btn btn-default btn-small" data-action="copy-connector-url">复制地址</button></div>
      </div>
      <div class="form-grid" style="grid-template-columns:1fr;margin-top:16px;">
        ${fields.map((field) => inputField(`connector-${field.key}`, field.label || field.key, "", field.secret ? "password" : "text", field.placeholder || "")).join("")}
      </div>
      <div class="action-row">
        <button class="btn btn-primary" data-action="save-connector">保存配置</button>
        <button class="btn btn-default" data-action="test-connector">测试连接</button>
        <button class="btn btn-default" data-action="send-test-connector" ${connector.controls?.asyncReply ? "" : "disabled"}>发送测试</button>
        <button class="btn btn-default" data-action="start-connector" ${connector.controls?.start ? "" : "disabled"}>启动</button>
        <button class="btn btn-danger" data-action="stop-connector" ${connector.controls?.stop ? "" : "disabled"}>停止</button>
      </div>
      <div class="info-box">${infoIcon()}<div>${escapeHtml((connector.setupStatus?.notes || ["未返回额外说明。"]).join("；"))}</div></div>
    </div>
  `;
}

function previewRecord(preview) {
  const active = preview.previewId === state.selectedPreviewId;
  return `
    <button class="record-item ${active ? "active" : ""}" data-action="select-preview" data-id="${escapeAttr(preview.previewId)}">
      <div class="record-title">${escapeHtml(preview.summary || preview.previewId)}</div>
      <div class="record-meta">
        <span class="status-badge ${preview.status === "pending" ? "badge-warning" : "badge-success"}">${previewStatus(preview.status)}</span>
        <span>${sourceName(preview.source)}</span>
        <span>${formatTime(preview.updatedAt || preview.createdAt)}</span>
      </div>
    </button>
  `;
}

function previewDetail(preview) {
  if (!preview) return `<div class="detail-card"><div class="empty-state">暂无预览。</div></div>`;
  const notes = preview.notesToWrite || [];
  const ideas = preview.ideas || [];
  const warnings = preview.warnings || [];
  return `
    <div class="detail-card">
      <div class="section-header">
        <div>
          <div class="detail-title">预览 ${shortId(preview.previewId)}</div>
          <div class="record-meta"><span>${sourceName(preview.source)}</span><span>${previewStatus(preview.status)}</span><span>${formatTime(preview.createdAt)}</span></div>
        </div>
        <div class="btn-group">
          <button class="btn btn-primary" data-action="confirm-preview" ${preview.status === "pending" ? "" : "disabled"}>确认入库</button>
          <button class="btn btn-danger" data-action="cancel-preview" ${preview.status === "pending" ? "" : "disabled"}>取消</button>
        </div>
      </div>
      <div class="detail-text">${escapeHtml(preview.summary || "")}</div>
      ${warnings.length ? `<div class="info-box">${infoIcon()}<div>${warnings.map((item) => escapeHtml(String(item))).join("<br>")}</div></div>` : ""}
    </div>
    <div class="detail-card">
      <div class="section-title">将写入 Obsidian</div>
      <div class="note-plan">
        ${notes.map((note) => `
          <div class="note-row">
            <strong>${escapeHtml(note.title || note.path)}</strong>
            <div class="record-meta"><span>${escapeHtml(note.type || "note")}</span><span>${escapeHtml(note.operation || "create")}</span><span>${Math.round((note.confidence || 0) * 100)}%</span></div>
            <div class="detail-text">${escapeHtml(note.path || "")}</div>
            <div class="detail-text">${escapeHtml(note.reason || "")}</div>
          </div>
        `).join("") || `<div class="empty-state">没有写入计划。</div>`}
      </div>
    </div>
    <div class="detail-card">
      <div class="section-header"><div class="section-title">联想只回聊天</div><button class="btn btn-default btn-small" data-action="load-markdown">查看 Markdown</button></div>
      <div class="note-plan">
        ${ideas.slice(0, 5).map((idea) => `<div class="note-row"><strong>${escapeHtml(idea.title)}</strong><div class="detail-text">${escapeHtml(idea.productConcept || idea.nextAction || "")}</div></div>`).join("") || `<div class="empty-state">没有额外联想。</div>`}
      </div>
      ${state.selectedMarkdown ? `<pre class="code-block" style="margin-top:16px;">${escapeHtml(state.selectedMarkdown)}</pre>` : ""}
      <div class="action-row">
        <textarea id="regenerateText" placeholder="补充要求后重新生成，例如：这次只保留一个知识卡"></textarea>
        <button class="btn btn-default" data-action="regenerate-preview">补充重生成</button>
      </div>
    </div>
  `;
}

function runSelector() {
  return `
    <select data-select-run>
      ${state.runs.map((run) => `<option value="${escapeAttr(run.id)}" ${run.id === state.selectedRunId ? "selected" : ""}>${shortId(run.id)} · ${statusName(run.status)}</option>`).join("")}
    </select>
  `;
}

function runDetailPanel(run) {
  if (!run) return `<div class="right-panel"><div class="empty-state">暂无运行记录。</div></div>`;
  return `
    <div class="right-panel">
      <div class="panel-header"><div class="panel-title">Run 详情</div><span class="running-badge">${statusName(run.status)}</span></div>
      <div class="info-grid">
        <div class="info-label">Run</div><div class="info-value">${shortId(run.id)}</div>
        <div class="info-label">Job</div><div class="info-value">${shortId(run.jobId)}</div>
        <div class="info-label">模型</div><div class="info-value">${escapeHtml(run.model || "—")}</div>
        <div class="info-label">开始</div><div class="info-value">${formatTime(run.startedAt)}</div>
        <div class="info-label">结束</div><div class="info-value">${formatTime(run.endedAt)}</div>
      </div>
      <pre class="code-block">${escapeHtml(JSON.stringify(run.finalState || run.inputState || {}, null, 2))}</pre>
    </div>
  `;
}

function toolCallsTable() {
  const rows = state.toolCalls.map((call) => `
    <tr>
      <td>${escapeHtml(call.toolName || call.tool_name || "-")}</td>
      <td><span class="status-badge ${statusBadge(call.status)}">${statusName(call.status)}</span></td>
      <td>${escapeHtml(nodeName(call.nodeName || call.node_name || "-"))}</td>
      <td class="text-gray">${call.durationMs || call.duration_ms || 0}ms</td>
    </tr>
  `).join("");
  return `
    <div class="table-card">
      <table><thead><tr><th>工具</th><th>状态</th><th>节点</th><th>耗时</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="text-gray">暂无工具调用记录。</td></tr>`}</tbody></table>
    </div>
  `;
}

function vaultTreeList(items = state.vaultTree) {
  return `
    <div class="tree-list">
      ${items.slice(0, 180).map((item) => `
        <div class="tree-item">
          <span class="tree-path">${item.type === "dir" ? "📁" : "📄"} ${escapeHtml(item.path)}</span>
          <span class="muted">${escapeHtml(item.type)}</span>
        </div>
      `).join("") || `<div class="empty-state">Vault 目录为空。</div>`}
    </div>
  `;
}

function inputField(id, label, value = "", type = "text", placeholder = "") {
  const autocomplete = type === "password" ? "new-password" : "off";
  return `
    <div class="field">
      <label for="${escapeAttr(id)}">${escapeHtml(label)}</label>
      <input id="${escapeAttr(id)}" name="${escapeAttr(id)}-${Date.now()}" type="${escapeAttr(type)}" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}" autocomplete="${autocomplete}" autocapitalize="off" spellcheck="false">
    </div>
  `;
}

async function runAction(action, button) {
  if (button.disabled) return;
  const original = button.innerHTML;
  button.disabled = true;
  let shouldRefresh = true;
  try {
    if (action === "refresh") await refreshAll();
    if (action === "submit-preview" || action === "submit-agent") await submitIngest();
    if (action === "select-connector") state.selectedConnector = button.dataset.id;
    if (action === "save-connector") await saveConnector();
    if (action === "test-connector") await connectorCommand("test");
    if (action === "send-test-connector") await connectorCommand("send-test");
    if (action === "start-connector") await connectorCommand("start");
    if (action === "stop-connector") await connectorCommand("stop");
    if (action === "copy-connector-url") await copyText(selectedConnector()?.url || "");
    if (action === "select-preview") {
      state.selectedPreviewId = button.dataset.id;
      state.autoFollowPreview = false;
      state.selectedMarkdown = "";
      state.page = "previews";
      location.hash = "previews";
    }
    if (action === "follow-latest-preview") {
      state.autoFollowPreview = true;
      state.selectedPreviewId = (state.previews.find((item) => item.status === "pending") || state.previews[0])?.previewId || "";
    }
    if (action === "follow-latest-run") {
      state.autoFollowRun = true;
      state.selectedRunId = state.runs[0]?.id || "";
      await loadRunDetails();
    }
    if (action === "confirm-preview") await previewCommand("confirm");
    if (action === "cancel-preview") await previewCommand("cancel");
    if (action === "regenerate-preview") await regeneratePreview();
    if (action === "load-markdown") {
      await loadMarkdown();
      shouldRefresh = false;
    }
    if (action === "retry-run") await retryRun();
    if (action === "init-vault") await postJson("/api/vault/init", {});
    if (action === "open-vault") await postJson("/api/vault/open-path", {});
    if (action === "check-links") await checkLinks();
    if (action === "search-vault") {
      await searchVault();
      shouldRefresh = false;
    }
    if (action === "save-settings") await saveSettings();
    if (action?.startsWith("test-")) await testSettings(action.replace("test-", ""));
    if (shouldRefresh) await refreshForPage(state.page);
    render();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

async function submitIngest() {
  const textarea = $("#quickText");
  const text = textarea?.value.trim();
  if (!text) throw new Error("先粘贴链接或输入想法。");
  state.chatLog.push({ role: "user", text });
  toast("已收到，智能体开始处理。");
  const result = await postJson("/api/ingest/preview", {
    text,
    source: state.source,
    senderId: "web-dashboard",
    messageId: `web-${Date.now()}`
  });
  textarea.value = "";
  if (result.reply) state.chatLog.push({ role: "agent", text: result.reply });
  if (result.previewId) {
    state.selectedPreviewId = result.previewId;
    state.autoFollowPreview = true;
  }
  toast(result.previewId ? `预览已生成：${shortId(result.previewId)}` : "任务已创建。");
}

async function saveConnector() {
  const connector = selectedConnector();
  const fields = {};
  (connector.configFields || []).forEach((field) => {
    const value = $(`#connector-${cssEscape(field.key)}`)?.value.trim();
    if (value) fields[field.key] = value;
  });
  await patchJson(`/api/connectors/${encodeURIComponent(connector.source)}/config`, {
    enabled: true,
    publicBaseUrl: state.connectors.publicBaseUrl,
    fields
  });
  toast("接入配置已保存。");
}

async function connectorCommand(command) {
  const connector = selectedConnector();
  const result = await postJson(`/api/connectors/${encodeURIComponent(connector.source)}/${command}`, {});
  toast(result.message || result.status || "操作完成。");
}

async function previewCommand(command) {
  const preview = selectedPreview();
  if (!preview) throw new Error("请选择预览。");
  const result = await postJson(`/api/previews/${encodeURIComponent(preview.previewId)}/${command}`, {});
  toast(result.reply || `${command === "confirm" ? "已入库" : "已取消"}。`);
}

async function regeneratePreview() {
  const preview = selectedPreview();
  const extraText = $("#regenerateText")?.value.trim();
  if (!preview) throw new Error("请选择预览。");
  if (!extraText) throw new Error("请输入补充要求。");
  const result = await postJson(`/api/previews/${encodeURIComponent(preview.previewId)}/regenerate`, { extraText });
  if (result.previewId) {
    state.selectedPreviewId = result.previewId;
    state.autoFollowPreview = true;
  }
  toast("已重新生成预览。");
}

async function loadMarkdown() {
  const preview = selectedPreview();
  if (!preview) throw new Error("请选择预览。");
  state.selectedMarkdown = await getText(`/api/previews/${encodeURIComponent(preview.previewId)}/markdown`);
}

async function retryRun() {
  if (!state.selectedRunId) throw new Error("请选择 Run。");
  await postJson(`/api/agent/runs/${encodeURIComponent(state.selectedRunId)}/retry`, {});
  toast("已提交重跑。");
}

async function checkLinks() {
  const result = await postJson("/api/vault/check-broken-links", {});
  toast(`断链检查完成：${JSON.stringify(result).slice(0, 180)}`);
}

async function searchVault() {
  const query = $("#vaultSearch")?.value.trim();
  if (!query) throw new Error("请输入搜索词。");
  const result = await postJson("/api/vault/search", { query });
  state.vaultTree = result.results || [];
  $("#vaultSearchResult").textContent = `找到 ${state.vaultTree.length} 条`;
}

async function saveSettings() {
  const body = {};
  ["obsidianVaultPath", "openaiBaseUrl", "openaiModel", "openaiApiKey", "githubToken", "douyinParseApi", "ocrFrameIntervalSeconds", "ocrMaxFrames"].forEach((key) => {
    const value = $(`#${key}`)?.value.trim();
    if (value) body[key] = ["ocrFrameIntervalSeconds", "ocrMaxFrames"].includes(key) ? Number(value) : value;
  });
  await patchJson("/api/settings", body);
  toast("配置已保存。");
}

async function testSettings(kind) {
  const route = {
    openai: "/api/settings/test/openai",
    github: "/api/settings/test/github",
    douyin: "/api/settings/test/douyin",
    tools: "/api/settings/test/tools",
    ocr: "/api/settings/test/ocr"
  }[kind];
  if (!route) return;
  const result = await postJson(route, {});
  toast(result.ok === false ? JSON.stringify(result) : "测试通过。");
}

function selectedConnector() {
  return state.connectors.find((connector) => connector.source === state.selectedConnector) || state.connectors[0];
}

function selectedPreview() {
  return state.previews.find((preview) => preview.previewId === state.selectedPreviewId) || state.previews[0];
}

function selectedRun() {
  return state.runs.find((run) => run.id === state.selectedRunId) || state.runs[0];
}

function timelineItems(run) {
  const fallback = [
    ["接收消息", "等待新的投喂", "waiting"],
    ["解析输入", "识别链接与意图", "waiting"],
    ["调用工具", "抖音/GitHub/OCR", "waiting"],
    ["知识抽取", "生成主知识", "waiting"],
    ["生成预览", "等待确认", "waiting"]
  ];
  const steps = state.steps.length ? state.steps : fallback.map(([nodeName, outputSummary, status]) => ({ nodeName, outputSummary, status }));
  return steps.slice(0, 10).map((step, index) => {
    const stateClass = step.status === "success" ? "done" : step.status === "running" ? "active" : step.status === "failed" ? "error" : index === 0 && run ? "done" : "waiting";
    return `
      <div class="timeline-item">
        <div class="timeline-dot ${stateClass}"></div>
        <div class="timeline-content">
          <div class="timeline-header">
            <span>${escapeHtml(nodeName(step.nodeName || step.node_name || "-"))}</span>
            <span class="timeline-time">${step.durationMs || step.duration_ms ? `${step.durationMs || step.duration_ms}ms` : formatTime(step.createdAt || step.created_at)}</span>
          </div>
          <div class="timeline-desc">${escapeHtml(step.outputSummary || step.output_summary || step.inputSummary || step.input_summary || step.error || "等待中")}</div>
        </div>
      </div>
    `;
  }).join("");
}

function tag(label, ok) {
  return `<div class="status-tag-item"><span class="status-dot ${ok ? "green" : "red"}"></span>${escapeHtml(label)}</div>`;
}

function stat(label, value, colorClass) {
  return `<div class="stat-item"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value ${colorClass}">${Number(value) || 0}</div></div>`;
}

function miniCard(label, value, colorClass) {
  return `<div class="mini-card"><div class="mini-label">${escapeHtml(label)}</div><div class="mini-value ${colorClass}">${escapeHtml(value)}</div></div>`;
}

function sourceIcon(source) {
  const normalized = source || "web";
  if (normalized === "feishu") return `<div class="source-icon icon-feishu">${paperPlaneIcon()}</div>`;
  if (normalized === "api") return `<div class="source-icon icon-api">API</div>`;
  if (normalized === "douyin") return `<div class="source-icon icon-tiktok">d</div>`;
  return `<div class="source-icon icon-web">${globeIcon()}</div>`;
}

function sourceName(source) {
  return {
    feishu: "飞书",
    api: "API",
    douyin: "抖音",
    web: "网页",
    wechat: "微信",
    wecom: "企业微信",
    telegram: "Telegram",
    dingtalk: "钉钉"
  }[source] || source || "网页";
}

function statusName(status) {
  return {
    received: "已接收",
    queued: "排队中",
    running: "运行中",
    waiting_user: "待确认",
    confirmed: "已确认",
    cancelled: "已取消",
    failed: "失败",
    committed: "已写入",
    created: "已创建",
    tool_calling: "调用工具",
    preview_generated: "已生成预览",
    need_clarification: "需补充",
    completed: "完成",
    success: "成功",
    warning: "警告",
    skipped: "跳过"
  }[status] || status || "未知";
}

function previewStatus(status) {
  return { pending: "待确认", confirmed: "已确认", cancelled: "已取消", expired: "已过期" }[status] || status || "未知";
}

function noteTypeLabel(type) {
  return {
    idea: "灵感",
    knowledge: "知识",
    project: "项目",
    source: "素材",
    action: "行动",
    output: "作品",
    inbox: "收件箱"
  }[type] || type || "文件";
}

function statusBadge(status) {
  if (["waiting_user", "queued", "pending", "warning"].includes(status)) return "badge-warning";
  if (["failed", "error"].includes(status)) return "badge-error";
  if (["running", "received", "preview_generated", "tool_calling", "created"].includes(status)) return "badge-info";
  return "badge-success";
}

function nodeName(name) {
  return {
    load_context: "加载上下文",
    intent_router: "意图判别",
    parse_input: "解析输入",
    source_type_router: "来源路由",
    douyin_pipeline: "抖音解析",
    github_pipeline: "GitHub 研究",
    webpage_pipeline: "网页提取",
    plain_text_pipeline: "文本分析",
    mixed_input_pipeline: "混合输入",
    research_collector: "研究汇总",
    vault_context_retriever: "检索 Vault",
    knowledge_extractor: "知识抽取",
    idea_generator: "联想生成",
    action_generator: "行动生成",
    note_planner: "写入规划",
    preview_builder: "生成预览",
    quality_checker: "质量检查",
    reply_builder: "生成回复",
    vault_writer: "写入 Obsidian"
  }[name] || name;
}

async function getJson(url) {
  const response = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function getText(url) {
  const response = await fetch(url, { headers: { "Accept": "text/plain" } });
  if (!response.ok) throw new Error(await response.text());
  return response.text();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  toast("已复制。");
}

function toast(message) {
  let node = $(".toast");
  if (!node) {
    node = document.createElement("div");
    node.className = "toast";
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 3600);
}

function shortId(value) {
  if (!value) return "—";
  const clean = String(value).replace(/^(job|run|pv|msg)_/, "");
  return `#${clean.slice(0, 8).toUpperCase()}`;
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function cssEscape(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function folderIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
}

function paperPlaneIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"></path></svg>`;
}

function globeIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line></svg>`;
}

function bellIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>`;
}

function infoIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
}
