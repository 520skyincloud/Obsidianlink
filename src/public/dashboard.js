const pages = [
  { id: "assistant", label: "助手", title: "今天想记录什么？", subtitle: "发抖音链接、GitHub 项目名、网页，或直接说一个想法。", icon: "message" },
  { id: "pending", label: "待确认", title: "待我确认", subtitle: "只在你点入库后写入 Obsidian。", icon: "queue" },
  { id: "vault", label: "知识库", title: "知识库", subtitle: "最近写入、搜索和打开本地 Vault。", icon: "database" },
  { id: "settings", label: "设置", title: "设置", subtitle: "首次配置、飞书连接和高级诊断都在这里。", icon: "gear" }
];

const pageIds = new Set(pages.map((page) => page.id));

const state = {
  page: pageIds.has(location.hash.slice(1)) ? location.hash.slice(1) : "assistant",
  health: null,
  settings: null,
  status: null,
  connectors: [],
  previews: [],
  recentFiles: [],
  jobs: [],
  runs: [],
  platformEvents: [],
  vaultStatus: null,
  vaultTree: [],
  searchResults: [],
  selectedPreviewId: "",
  selectedPreviewIds: new Set(),
  selectedMarkdown: "",
  chat: [
    { role: "user", text: "去 GitHub 找 LangGraph", time: "刚刚" },
    { role: "assistant", text: "找到项目，已准备项目卡，等你确认入库。", time: "刚刚" },
    { role: "user", text: "我有个想法：自动化测试需求收集工具", time: "13:20" },
    { role: "assistant", text: "已记录想法线索。聊清楚后你说“保存这个”，我再写入 Obsidian。", time: "13:20" }
  ],
  lastUpdatedAt: "",
  refreshError: "",
  refreshInFlight: false,
  lastSignature: ""
};

const $ = (selector, root = document) => root.querySelector(selector);

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  renderNav();
  renderShell();
  try {
    await refreshAll();
  } catch (error) {
    toast(`读取状态失败：${messageOf(error)}`);
  }
  render();
  setInterval(refreshRealtime, 3000);
});

function bindEvents() {
  document.addEventListener("click", async (event) => {
    const nav = event.target.closest("[data-nav]");
    if (nav) {
      state.page = nav.dataset.nav;
      location.hash = state.page;
      await refreshForPage(state.page);
      render();
      return;
    }

    const selector = event.target.closest("[data-select-preview]");
    if (selector) {
      const previewId = selector.dataset.selectPreview;
      if (selector.checked) state.selectedPreviewIds.add(previewId);
      else state.selectedPreviewIds.delete(previewId);
      render();
      return;
    }

    const preview = event.target.closest("[data-preview-id]");
    if (preview && !event.target.closest("[data-action]")) {
      state.selectedPreviewId = preview.dataset.previewId;
      state.selectedMarkdown = "";
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
}

async function refreshRealtime(force = false) {
  if (document.hidden || state.refreshInFlight) return;
  state.refreshInFlight = true;
  const before = state.lastSignature;
  try {
    await refreshForPage(state.page);
    if ((force || before !== state.lastSignature) && !isEditing()) render();
    else renderShell();
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
  const [health, settings, status, connectors, previews, recentFiles, jobs, runs, logs] = await Promise.all([
    getJson("/api/system/health"),
    getJson("/api/settings"),
    getJson("/api/system/status").catch(() => null),
    getJson("/api/connectors"),
    getJson("/api/previews?status=pending&limit=60"),
    getJson("/api/vault/recent-files?limit=40").catch(() => ({ files: [] })),
    getJson("/api/ingest/jobs?limit=30").catch(() => ({ jobs: [] })),
    getJson("/api/agent/runs?limit=10").catch(() => ({ runs: [] })),
    getJson("/api/connectors/logs?limit=50").catch(() => ({ logs: [] }))
  ]);

  state.health = health;
  state.settings = settings;
  state.status = status;
  state.connectors = connectors.connectors || [];
  state.previews = sortByTime(previews.previews || [], ["updatedAt", "createdAt"]);
  for (const previewId of [...state.selectedPreviewIds]) {
    if (!state.previews.some((item) => item.previewId === previewId)) state.selectedPreviewIds.delete(previewId);
  }
  state.recentFiles = sortByTime(recentFiles.files || [], ["updatedAt", "createdAt"]);
  state.jobs = sortByTime(jobs.jobs || [], ["updatedAt", "createdAt"]);
  state.runs = sortByTime(runs.runs || [], ["endedAt", "startedAt"]);
  state.platformEvents = sortByTime(logs.logs || [], ["createdAt"]);
  state.selectedPreviewId ||= state.previews.find((item) => item.status === "pending")?.previewId || state.previews[0]?.previewId || "";
  if (!state.previews.some((item) => item.previewId === state.selectedPreviewId)) {
    state.selectedPreviewId = state.previews.find((item) => item.status === "pending")?.previewId || state.previews[0]?.previewId || "";
  }
  state.lastUpdatedAt = new Date().toISOString();
  state.refreshError = "";
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
}

function signature() {
  return JSON.stringify({
    page: state.page,
    health: [state.health?.ok, state.health?.vault?.writable, feishuConnector()?.longConnection?.running],
    previews: state.previews.slice(0, 12).map((item) => [item.previewId, item.status, item.noteCount, item.updatedAt]),
    files: state.recentFiles.slice(0, 12).map((item) => [item.id, item.path, item.updatedAt]),
    logs: state.platformEvents.slice(0, 8).map((item) => [item.id, item.message, item.createdAt])
  });
}

function render() {
  renderNav();
  renderShell();
  const app = $("#app");
  if (state.page === "assistant") app.innerHTML = renderAssistant();
  if (state.page === "pending") app.innerHTML = renderPending();
  if (state.page === "vault") app.innerHTML = renderVault();
  if (state.page === "settings") app.innerHTML = renderSettings();
}

function renderNav() {
  const nav = $("#nav");
  if (!nav) return;
  nav.innerHTML = pages.map((page) => `
    <button class="nav-button ${page.id === state.page ? "active" : ""}" data-nav="${page.id}">
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
  const ok = Boolean(state.health?.ok);
  $("#side-dot").className = `dot ${ok ? "ok" : "bad"}`;
  $("#side-status").textContent = ok ? "服务正常" : "需要检查";
  $("#side-version").textContent = `v${state.health?.version || "0.1.0"}`;
  $("#refresh-pill").innerHTML = `<i class="dot ${state.refreshError ? "bad" : "ok"}"></i>${state.refreshError ? escapeHtml(state.refreshError) : `已同步 ${formatTime(state.lastUpdatedAt)}`}`;
  $("#bottom-bar").innerHTML = `
    <span><i class="dot ${feishuConnector()?.longConnection?.running ? "ok" : "warn"}"></i> 飞书：${feishuConnector()?.longConnection?.running ? "已连接" : "未运行"}</span>
    <span><i class="dot ${state.health?.vault?.writable ? "ok" : "bad"}"></i> Vault：${state.health?.vault?.writable ? "可写" : "不可写"}</span>
    <span>模型：${escapeHtml(state.settings?.openaiModel || "未配置")}</span>
  `;
}

function renderAssistant() {
  return `
    <div class="assistant-grid">
      <section class="assistant-hero">
        <h2>今天想记录什么？</h2>
        <p>发抖音链接、GitHub 项目名、网页，或直接说一个想法。</p>
        <div class="big-composer">
          <textarea id="assistant-input" placeholder="粘贴链接，或直接说：帮我找 Docling 这个项目…"></textarea>
          <div class="split" style="margin-top:10px;">
            <span class="help">普通闲聊只聊天；需要保存时才生成待确认卡片。</span>
            <div class="toolbar">
              <button class="btn" data-action="debug-intent">只判别意图</button>
              <button class="btn primary" data-action="send-message">发送给助手</button>
            </div>
          </div>
        </div>
        <div class="conversation-list">
          ${state.chat.slice(-8).map((item) => `
            <div class="simple-message ${item.role === "user" ? "user" : ""}">
              <div class="avatar">${item.role === "user" ? "我" : "OL"}</div>
              <div>${escapeHtml(item.text)}</div>
              <span class="help">${escapeHtml(item.time || "")}</span>
            </div>
          `).join("")}
        </div>
        <div class="card recent-panel">
          <div class="card-head">
            <div><h2 class="card-title">最近写入 Obsidian</h2><p class="card-desc">确认入库后的内容会出现在这里。</p></div>
            <button class="btn small" data-nav="vault">查看全部</button>
          </div>
          <div class="card-body">${renderRecentFiles(5)}</div>
        </div>
      </section>
      <aside class="pending-column card">
        <div class="card-head">
          <div><h2 class="card-title">待我确认</h2><p class="card-desc">助手准备好了，但还没有写入。</p></div>
          <button class="btn small" data-nav="pending">全部</button>
        </div>
        <div class="card-body list">
          ${pendingPreviews().slice(0, 3).map((item) => renderPreviewCard(item, { selectable: false })).join("") || empty("现在没有待确认内容。")}
        </div>
      </aside>
    </div>
  `;
}

function renderPending() {
  const preview = selectedPreview();
  const previews = pendingPreviews();
  const selectedCount = state.selectedPreviewIds.size;
  return `
    <div class="layout-wide">
      <div class="card">
        <div class="card-head">
          <div><h2 class="card-title">待确认内容</h2><p class="card-desc">点“入库”才写文件；点“先不存”会直接删除这条待确认记录。</p></div>
          <div class="toolbar">
            <button class="btn small" data-action="select-all-previews" ${previews.length ? "" : "disabled"}>全选</button>
            <button class="btn small" data-action="clear-selected-previews" ${selectedCount ? "" : "disabled"}>取消选择</button>
            <button class="btn small danger" data-action="cancel-selected-previews" ${previews.length ? "" : "disabled"}>批量取消 ${selectedCount ? selectedCount : "全部"}</button>
            <button class="btn small danger" data-action="cancel-all-previews" ${previews.length ? "" : "disabled"}>清空全部</button>
          </div>
        </div>
        <div class="card-body list">
          ${previews.map((item) => renderPreviewCard(item, { selectable: true })).join("") || empty("暂无待确认预览。")}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2 class="card-title">预览详情</h2><p class="card-desc">确认前最后看一眼。</p></div></div>
        <div class="card-body">${preview ? renderPreviewDetail(preview) : empty("选择一条内容查看详情。")}</div>
      </div>
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
            <div><h2 class="card-title">本地知识库</h2><p class="card-desc">${escapeHtml(status.path || state.settings?.obsidianVaultPath || "未读取到路径")}</p></div>
            <span class="pill ${status.writable ? "ok" : "bad"}">${status.writable ? "可写" : "不可写"}</span>
          </div>
          <div class="toolbar" style="margin-top:16px;">
            <button class="btn green" data-action="open-vault">打开 Obsidian 文件夹</button>
            <button class="btn" data-action="init-vault">初始化目录</button>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">搜索</h2><p class="card-desc">按标题或路径找刚写进去的内容。</p></div></div>
          <div class="card-body">
            <div class="toolbar"><input id="vault-query" placeholder="搜索：LangGraph / 提示词 / 飞书"><button class="btn primary" data-action="search-vault">搜索</button></div>
            <div class="list" style="margin-top:14px;">${state.searchResults.map((item) => `<div class="list-item"><strong>${escapeHtml(item.path)}</strong><div class="help">${escapeHtml(item.type)}</div></div>`).join("") || empty("输入关键词后搜索。")}</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2 class="card-title">最近写入</h2><p class="card-desc">用户真正关心的是写进去了什么。</p></div></div>
        <div class="card-body">${renderRecentFiles(20)}</div>
      </div>
    </div>
  `;
}

function renderSettings() {
  return `
    <div class="layout-wide">
      <div class="grid">
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">基础设置</h2><p class="card-desc">密钥留空表示不覆盖。</p></div><button class="btn primary" data-action="save-settings">保存设置</button></div>
          <div class="card-body form-grid">
            ${field("setting-obsidianVaultPath", "Obsidian Vault", state.settings?.obsidianVaultPath || "", "text", "/Users/sky/Documents/obsidian/sky")}
            ${field("setting-openaiBaseUrl", "模型 API 地址", state.settings?.openaiBaseUrl || "", "url", "http://43.128.146.66:8317/v1")}
            ${field("setting-openaiModel", "模型名称", state.settings?.openaiModel || "", "text", "gpt-5.5")}
            ${field("setting-openaiApiKey", "模型密钥", "", "password", state.settings?.openaiConfigured ? "已配置，留空不覆盖" : "未配置")}
            ${field("setting-githubToken", "GitHub Token", "", "password", state.settings?.githubTokenConfigured ? "已配置，留空不覆盖" : "未配置")}
            ${field("setting-douyinParseApi", "抖音解析 API", state.settings?.douyinParseApi || "", "url", "https://api.bugpk.com/...")}
          </div>
        </div>
        ${renderFeishuSettings()}
      </div>
      <div class="grid">
        <div class="card">
          <div class="card-head"><div><h2 class="card-title">连通性检查</h2><p class="card-desc">有问题时再来这里看。</p></div></div>
          <div class="card-body toolbar">
            <button class="btn" data-action="test-openai">测模型</button>
            <button class="btn" data-action="test-github">测 GitHub</button>
            <button class="btn" data-action="test-douyin">测抖音</button>
            <button class="btn" data-action="test-tools">测本机工具</button>
            <button class="btn" data-action="test-ocr">测 OCR</button>
          </div>
        </div>
        <details class="card">
          <summary class="card-head" style="cursor:pointer;"><div><h2 class="card-title">高级诊断</h2><p class="card-desc">开发排错用，默认不用看。</p></div></summary>
          <div class="card-body">
            <div class="codebox">${escapeHtml(JSON.stringify({
              health: state.health,
              recentJobs: state.jobs.slice(0, 8),
              recentRuns: state.runs.slice(0, 5),
              connectorLogs: state.platformEvents.slice(0, 10)
            }, null, 2))}</div>
          </div>
        </details>
      </div>
    </div>
  `;
}

function renderFeishuSettings() {
  const connector = feishuConnector();
  const fields = connector?.configFields || [];
  return `
    <div class="card">
      <div class="card-head">
        <div><h2 class="card-title">飞书助手</h2><p class="card-desc">推荐长连接，配置好后点启动。</p></div>
        <span class="pill ${connector?.longConnection?.running ? "ok" : "warn"}">${connector?.longConnection?.running ? "已连接" : "未运行"}</span>
      </div>
      <div class="card-body">
        <div class="form-grid">
          ${field("feishu-publicBaseUrl", "公网 Base URL（备用）", connector?.publicBaseUrl || "", "url", "长连接可不填公网地址")}
          ${fields.map((item) => field(`feishu-${item.key}`, item.label || item.key, item.key === "longConnection" ? (connector?.configuredFields?.longConnection ? "true" : "") : "", item.secret ? "password" : "text", item.placeholder || (connector?.configuredFields?.[item.key] ? "已配置" : ""))).join("")}
        </div>
        <div class="toolbar" style="margin-top:14px;">
          <button class="btn primary" data-action="save-feishu">保存飞书</button>
          <button class="btn green" data-action="start-feishu">启动长连接</button>
          <button class="btn" data-action="stop-feishu">停止</button>
        </div>
      </div>
    </div>
  `;
}

function renderPreviewCard(preview, options = {}) {
  const noteCount = Number(preview.noteCount || preview.notesToWrite?.length || 0);
  const title = previewTitle(preview);
  const kind = previewKind(preview);
  const selectable = options.selectable !== false;
  const selected = state.selectedPreviewIds.has(preview.previewId);
  return `
    <div class="preview-card ${preview.previewId === state.selectedPreviewId ? "active" : ""}" data-preview-id="${escapeAttr(preview.previewId)}">
      <div class="preview-top ${selectable ? "with-check" : ""}">
        ${selectable ? `<label class="preview-check" title="选择这条"><input type="checkbox" data-select-preview="${escapeAttr(preview.previewId)}" ${selected ? "checked" : ""}></label>` : ""}
        <div class="preview-logo">${kind.logo}</div>
        <div>
          <strong>${escapeHtml(title)}</strong>
          <div class="help">${escapeHtml(preview.summary || "待确认内容").slice(0, 84)}</div>
        </div>
        <span class="help">${formatTime(preview.updatedAt || preview.createdAt)}</span>
      </div>
      <div class="split">
        <span class="pill ${kind.tone}">${escapeHtml(kind.label)}</span>
        <span class="help">计划写入 ${noteCount} 个文件</span>
      </div>
      <div class="preview-actions">
        <button class="btn small primary" data-action="confirm-preview">入库</button>
        <button class="btn small danger" data-action="cancel-preview">先不存</button>
      </div>
    </div>
  `;
}

function renderPreviewDetail(preview) {
  const notes = preview.notesToWrite || [];
  return `
    <div class="grid">
      <div>
        <div class="split"><h3 class="card-title">${escapeHtml(previewTitle(preview))}</h3>${statusPill(preview.status)}</div>
        <p class="muted">${escapeHtml(preview.summary || "无摘要")}</p>
      </div>
      <div class="list">
        ${notes.length ? notes.map((note) => `
          <div class="list-item">
            <strong>${escapeHtml(note.title || note.path || "待写入文件")}</strong>
            <div class="mono help">${escapeHtml(note.path || "")}</div>
          </div>
        `).join("") : empty("没有可写入文件。")}
      </div>
      <div class="toolbar">
        <button class="btn green" data-action="confirm-preview">确认入库</button>
        <button class="btn" data-action="load-markdown">查看 Markdown</button>
        <button class="btn danger" data-action="cancel-preview">取消</button>
      </div>
      ${state.selectedMarkdown ? `<div class="codebox">${escapeHtml(state.selectedMarkdown)}</div>` : ""}
    </div>
  `;
}

function renderRecentFiles(limit) {
  const files = state.recentFiles.slice(0, limit);
  if (!files.length) return empty("还没有写入记录。");
  return files.map((file) => `
    <div class="recent-row">
      <div><strong>${escapeHtml(file.title || file.noteId || file.path)}</strong><div class="mono help">${escapeHtml(file.path || "")}</div></div>
      <span class="pill blue">${escapeHtml(file.type || "note")}</span>
      <span class="help">${formatTime(file.updatedAt || file.createdAt)}</span>
    </div>
  `).join("");
}

async function runAction(action, button) {
  button.disabled = true;
  try {
    if (action === "refresh") await refreshForPage(state.page);
    else if (action === "send-message") await sendMessage();
    else if (action === "debug-intent") await debugIntent();
    else if (action === "confirm-preview") await confirmPreview(button);
    else if (action === "cancel-preview") await cancelPreview(button);
    else if (action === "select-all-previews") selectAllPreviews();
    else if (action === "clear-selected-previews") clearSelectedPreviews();
    else if (action === "cancel-selected-previews") await cancelSelectedPreviews();
    else if (action === "cancel-all-previews") await cancelAllPreviews();
    else if (action === "load-markdown") await loadMarkdown();
    else if (action === "save-settings") await saveSettings();
    else if (action === "save-feishu") await saveFeishu();
    else if (action === "start-feishu") await postJson("/api/connectors/feishu/start", {});
    else if (action === "stop-feishu") await postJson("/api/connectors/feishu/stop", {});
    else if (action === "open-vault") await postJson("/api/vault/open-path", {});
    else if (action === "init-vault") await postJson("/api/vault/init", {});
    else if (action === "search-vault") await searchVault();
    else if (action.startsWith("test-")) await testSetting(action.replace("test-", ""));
    await refreshForPage(state.page);
    render();
    if (!["debug-intent", "send-message", "confirm-preview", "cancel-preview", "cancel-selected-previews", "cancel-all-previews", "test-openai", "test-github", "test-douyin", "test-tools", "test-ocr"].includes(action)) toast("操作完成。");
  } catch (error) {
    toast(messageOf(error));
  } finally {
    button.disabled = false;
  }
}

async function sendMessage() {
  const text = $("#assistant-input")?.value?.trim();
  if (!text) throw new Error("先输入一句话或粘贴链接");
  $("#assistant-input").value = "";
  state.chat.push({ role: "user", text, time: "现在" });
  const result = await postJson("/agent/message", {
    text,
    source: "web",
    senderId: "desktop-user",
    messageId: `desktop-${Date.now()}`,
    autoWrite: false
  });
  state.chat.push({ role: "assistant", text: result.reply || "我收到了，已经处理。", time: "现在" });
}

async function debugIntent() {
  const text = $("#assistant-input")?.value?.trim();
  if (!text) throw new Error("先输入一句话");
  const result = await postJson("/api/agent/debug-intent", {
    text,
    source: "web",
    senderId: "desktop-user",
    messageId: `debug-${Date.now()}`,
    autoWrite: false
  });
  state.chat.push({ role: "user", text, time: "现在" });
  state.chat.push({ role: "assistant", text: `我判断这是：${result.intent?.type || result.intent?.intent || "unknown"}。${result.intent?.reason || ""}`, time: "现在" });
}

async function confirmPreview(button) {
  const previewId = button.closest("[data-preview-id]")?.dataset.previewId || state.selectedPreviewId;
  if (!previewId) throw new Error("没有选中的待确认内容");
  const result = await postJson(`/api/previews/${encodeURIComponent(previewId)}/confirm`, {});
  toast(writeResultText(result));
}

async function cancelPreview(button) {
  const previewId = button.closest("[data-preview-id]")?.dataset.previewId || state.selectedPreviewId;
  if (!previewId) throw new Error("没有选中的待确认内容");
  await postJson(`/api/previews/${encodeURIComponent(previewId)}/cancel`, {});
  state.selectedPreviewIds.delete(previewId);
  if (state.selectedPreviewId === previewId) state.selectedPreviewId = "";
  toast("已取消并删除这条待确认记录。");
}

function selectAllPreviews() {
  pendingPreviews().forEach((preview) => state.selectedPreviewIds.add(preview.previewId));
}

function clearSelectedPreviews() {
  state.selectedPreviewIds.clear();
}

async function cancelSelectedPreviews() {
  const pending = pendingPreviews();
  const selectedIds = [...state.selectedPreviewIds].filter((previewId) => pending.some((item) => item.previewId === previewId));
  const previewIds = selectedIds.length ? selectedIds : pending.map((preview) => preview.previewId);
  if (!previewIds.length) throw new Error("没有待确认内容可取消");
  if (!selectedIds.length && !window.confirm(`当前没有勾选内容。确定删除全部 ${previewIds.length} 条待确认记录吗？这不会删除 Obsidian 文件。`)) return;
  await cancelPreviewIds(previewIds);
}

async function cancelAllPreviews() {
  const previewIds = pendingPreviews().map((preview) => preview.previewId);
  if (!previewIds.length) throw new Error("没有待确认内容可清空");
  if (!window.confirm(`确定删除全部 ${previewIds.length} 条待确认记录吗？这不会删除 Obsidian 文件。`)) return;
  await cancelPreviewIds(previewIds);
}

async function cancelPreviewIds(previewIds) {
  const result = await postJson("/api/previews/cancel", { previewIds });
  state.selectedPreviewIds.clear();
  if (previewIds.includes(state.selectedPreviewId)) state.selectedPreviewId = "";
  if (result.failed?.length) {
    toast(`已取消 ${result.cancelled?.length || 0} 条，${result.failed.length} 条失败。`);
    return;
  }
  toast(`已取消并删除 ${result.cancelled?.length || previewIds.length} 条待确认记录。`);
}

async function loadMarkdown() {
  const preview = selectedPreview();
  if (!preview) throw new Error("请选择一条内容");
  state.selectedMarkdown = await getText(`/api/previews/${encodeURIComponent(preview.previewId)}/markdown`);
}

async function saveSettings() {
  const body = {};
  readSetting("obsidianVaultPath", body);
  readSetting("openaiBaseUrl", body);
  readSetting("openaiApiKey", body);
  readSetting("openaiModel", body);
  readSetting("githubToken", body);
  readSetting("douyinParseApi", body);
  if (!Object.keys(body).length) throw new Error("没有要保存的内容");
  await patchJson("/api/settings", body);
}

function readSetting(key, body) {
  const value = $(`#setting-${key}`)?.value?.trim();
  if (value) body[key] = value;
}

async function saveFeishu() {
  const connector = feishuConnector();
  if (!connector) throw new Error("未读取到飞书配置");
  const fields = {};
  for (const item of connector.configFields || []) {
    const value = $(`#feishu-${item.key}`)?.value?.trim();
    if (value) fields[item.key] = value;
  }
  const publicBaseUrl = $("#feishu-publicBaseUrl")?.value?.trim();
  const body = { enabled: true, fields };
  if (publicBaseUrl) body.publicBaseUrl = publicBaseUrl;
  await patchJson("/api/connectors/feishu/config", body);
}

async function searchVault() {
  const query = $("#vault-query")?.value?.trim();
  if (!query) throw new Error("请输入搜索词");
  const result = await postJson("/api/vault/search", { query });
  state.searchResults = result.results || [];
}

async function testSetting(kind) {
  const map = {
    openai: "/api/settings/test/openai",
    github: "/api/settings/test/github",
    douyin: "/api/settings/test/douyin",
    tools: "/api/settings/test/tools",
    ocr: "/api/settings/test/ocr"
  };
  const result = await postJson(map[kind], {});
  toast(result.ok ? `${kind} 测试通过。` : result.error || `${kind} 测试失败。`);
}

function pendingPreviews() {
  return state.previews.filter((item) => item.status === "pending" || item.status === "waiting_user");
}

function selectedPreview() {
  return state.previews.find((item) => item.previewId === state.selectedPreviewId) || state.previews[0];
}

function previewTitle(preview) {
  const notes = preview.notesToWrite || [];
  return notes[0]?.title || preview.detectedProjects?.[0]?.name || preview.knowledge?.[0]?.title || preview.summary || "待确认内容";
}

function previewKind(preview) {
  const text = `${preview.summary || ""} ${(preview.notesToWrite || []).map((item) => `${item.type} ${item.path}`).join(" ")}`.toLowerCase();
  if (text.includes("github") || text.includes("项目")) return { label: "GitHub 项目", logo: "GH", tone: "blue" };
  if (text.includes("抖音") || text.includes("douyin")) return { label: "抖音知识", logo: "抖", tone: "blue" };
  if (text.includes("想法") || text.includes("创意") || text.includes("灵感")) return { label: "灵感想法", logo: "灯", tone: "warn" };
  return { label: "知识笔记", logo: "知", tone: "ok" };
}

function feishuConnector() {
  return state.connectors.find((item) => item.source === "feishu");
}

function field(id, label, value = "", type = "text", placeholder = "") {
  return `<div class="field"><label for="${escapeAttr(id)}">${escapeHtml(label)}</label><input id="${escapeAttr(id)}" type="${escapeAttr(type)}" value="${escapeAttr(String(value ?? ""))}" placeholder="${escapeAttr(placeholder)}"></div>`;
}

function statusPill(status) {
  const value = String(status || "unknown");
  const tone = /(pending|waiting|running)/i.test(value) ? "blue" : /(fail|error|cancel)/i.test(value) ? "bad" : "ok";
  return `<span class="pill ${tone}">${escapeHtml(value)}</span>`;
}

function empty(text) {
  return `<div class="empty">${escapeHtml(text)}</div>`;
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

function writeResultText(result) {
  const files = result.writtenFiles || result.files || result.writes || [];
  return Array.isArray(files) ? `已入库：${files.length} 个文件。` : "已入库 Obsidian。";
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
    message: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>`,
    queue: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
    database: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>`,
    gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7A2 2 0 0 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>`
  };
  return icons[name] || icons.message;
}
