const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, Menu, shell } = require("electron");

const DEFAULT_PORT = 38721;
let mainWindow;
let serverHandle;

function runtimeDir() {
  return app.getPath("userData");
}

function ensureRuntimeEnv() {
  const dir = runtimeDir();
  fs.mkdirSync(dir, { recursive: true });
  process.chdir(dir);
  process.env.PORT ||= String(DEFAULT_PORT);
  process.env.OBSIDIANLINK_DB_PATH ||= path.join(dir, "data", "obsidianlink.sqlite");
  process.env.OBSIDIANLINK_PUBLIC_DIR = app.isPackaged
    ? path.join(process.resourcesPath, "public")
    : path.resolve(__dirname, "..", "src", "public");
}

async function startLocalServer() {
  ensureRuntimeEnv();
  const port = Number(process.env.PORT || DEFAULT_PORT);
  if (await isHealthy(port)) return { port, reusedExistingServer: true };

  const serverModulePath = path.join(app.getAppPath(), "dist", "src", "server.js");
  const serverModule = await import(pathToFileURL(serverModulePath).href);

  try {
    serverHandle = serverModule.startObsidianLinkServer(port, "127.0.0.1");
    await waitForHealth(port);
  } catch (error) {
    if (error && error.code === "EADDRINUSE") {
      await waitForHealth(port);
      return { port, reusedExistingServer: true };
    }
    throw error;
  }

  return { port, reusedExistingServer: false };
}

async function isHealthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/system/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(port) {
  const deadline = Date.now() + 12000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/system/health`);
      if (response.ok) return true;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw lastError || new Error("本地服务启动超时");
}

function createMenu(port) {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "ObsidianLink",
      submenu: [
        { label: "关于 ObsidianLink", role: "about" },
        { type: "separator" },
        {
          label: "打开本地网页",
          click: () => shell.openExternal(`http://127.0.0.1:${port}/`)
        },
        {
          label: "打开应用数据目录",
          click: () => shell.openPath(runtimeDir())
        },
        { type: "separator" },
        { label: "退出", role: "quit" }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" }
      ]
    },
    {
      label: "显示",
      submenu: [
        { role: "reload", label: "重新载入" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "进入全屏" }
      ]
    }
  ]));
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1040,
    minHeight: 720,
    title: "ObsidianLink",
    backgroundColor: "#f7f9fc",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(async () => {
  const { port } = await startLocalServer();
  createMenu(port);
  createWindow(port);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
}).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  serverHandle?.server?.close?.();
});
