#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const pidFile = path.join(dataDir, "obsidianlink.pid");
const logFile = path.join(dataDir, "obsidianlink.log");
const serverFile = path.join(root, "dist", "src", "server.js");
const env = loadEnv();
const port = Number(env.PORT || process.env.PORT || 38721);
const healthUrl = `http://127.0.0.1:${port}/api/system/health`;

const command = process.argv[2] || "status";

try {
  if (command === "start") await start();
  else if (command === "stop") await stop();
  else if (command === "restart") {
    await stop({ quiet: true });
    await start();
  } else if (command === "status") await status();
  else if (command === "doctor") await doctor();
  else {
    console.log("Usage: npm run service:start|service:stop|service:restart|service:status|doctor");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function start() {
  const health = await fetchHealth();
  if (health.ok) {
    console.log(`ObsidianLink already running: ${healthUrl}`);
    return;
  }
  if (!fs.existsSync(serverFile)) {
    throw new Error("dist/src/server.js not found. Run `npm run build` first.");
  }
  await fsp.mkdir(dataDir, { recursive: true });
  const log = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [serverFile], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, ...env }
  });
  child.unref();
  await fsp.writeFile(pidFile, String(child.pid), "utf8");
  const ready = await waitForHealth(12_000);
  if (!ready.ok) {
    throw new Error(`Started pid ${child.pid}, but health check did not pass. See ${logFile}`);
  }
  console.log(`ObsidianLink started: pid=${child.pid}, url=http://127.0.0.1:${port}/`);
  console.log(`Log: ${logFile}`);
}

async function stop(options = {}) {
  const pid = await readPid();
  if (!pid) {
    if (!options.quiet) console.log("ObsidianLink pid file not found.");
    return;
  }
  if (!isRunning(pid)) {
    await fsp.rm(pidFile, { force: true });
    if (!options.quiet) console.log("ObsidianLink was not running; cleaned stale pid file.");
    return;
  }
  process.kill(pid, "SIGTERM");
  const stopped = await waitUntilStopped(pid, 5000);
  if (!stopped) process.kill(pid, "SIGKILL");
  await fsp.rm(pidFile, { force: true });
  if (!options.quiet) console.log("ObsidianLink stopped.");
}

async function status() {
  const pid = await readPid();
  const listenerPid = listenerPidForPort(port);
  const health = await fetchHealth();
  console.log(`URL: http://127.0.0.1:${port}/`);
  console.log(`PID: ${pid ?? "none"}${pid && isRunning(pid) ? " (running)" : pid ? " (stale)" : ""}`);
  if (!pid && listenerPid) console.log(`Listener PID: ${listenerPid} (external or launchd-managed)`);
  console.log(`Health: ${health.ok ? "ok" : "down"}`);
  if (health.ok) {
    console.log(`Vault: ${health.data.vault?.exists ? "exists" : "missing"} / ${health.data.vault?.writable ? "writable" : "not writable"}`);
    console.log(`Database: ${health.data.database}`);
    console.log(`Model: ${health.data.model?.configured ? health.data.model.model : "not configured"}`);
  }
}

function listenerPidForPort(value) {
  try {
    const output = execFileSync("lsof", [`-tiTCP:${value}`, "-sTCP:LISTEN"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

async function doctor() {
  const envReport = {
    OBSIDIAN_VAULT_PATH: Boolean(env.OBSIDIAN_VAULT_PATH),
    OPENAI_BASE_URL: Boolean(env.OPENAI_BASE_URL),
    OPENAI_API_KEY: Boolean(env.OPENAI_API_KEY),
    OPENAI_MODEL: Boolean(env.OPENAI_MODEL),
    GITHUB_TOKEN: Boolean(env.GITHUB_TOKEN),
    DOUYIN_PARSE_API: Boolean(env.DOUYIN_PARSE_API)
  };
  console.log("Config:");
  for (const [key, ok] of Object.entries(envReport)) console.log(`  ${key}: ${ok ? "ok" : "missing"}`);
  console.log("");
  await status();
  console.log("");
  console.log("Useful commands:");
  console.log("  npm run build");
  console.log("  npm run service:start");
  console.log("  npm run service:status");
  console.log("  npm run service:stop");
  console.log("  npm run launchd:install");
  console.log("  npm run launchd:uninstall");
}

async function fetchHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, data };
  } catch {
    return { ok: false, data: {} };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const health = await fetchHealth();
    if (health.ok) return health;
    await sleep(500);
  }
  return { ok: false, data: {} };
}

async function waitUntilStopped(pid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isRunning(pid)) return true;
    await sleep(250);
  }
  return !isRunning(pid);
}

async function readPid() {
  try {
    const text = await fsp.readFile(pidFile, "utf8");
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadEnv() {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return {};
  const result = {};
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    result[key] = value;
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
