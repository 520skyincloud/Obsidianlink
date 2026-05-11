#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const label = "com.obsidianlink.local";
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
const nodePath = process.execPath;
const command = process.argv[2] || "print";

try {
  if (command === "print") {
    console.log(plist());
  } else if (command === "install") {
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.mkdir(path.join(root, "data"), { recursive: true });
    await fs.writeFile(plistPath, plist(), "utf8");
    launchctl(["bootout", `gui/${process.getuid()}`, plistPath], { ignoreError: true });
    launchctl(["bootstrap", `gui/${process.getuid()}`, plistPath]);
    launchctl(["enable", `gui/${process.getuid()}/${label}`], { ignoreError: true });
    launchctl(["kickstart", "-k", `gui/${process.getuid()}/${label}`], { ignoreError: true });
    console.log(`Installed LaunchAgent: ${plistPath}`);
    console.log("Open http://127.0.0.1:38721/ after a few seconds.");
  } else if (command === "uninstall") {
    launchctl(["bootout", `gui/${process.getuid()}`, plistPath], { ignoreError: true });
    await fs.rm(plistPath, { force: true });
    console.log(`Uninstalled LaunchAgent: ${plistPath}`);
  } else {
    console.log("Usage: npm run launchd:print|launchd:install|launchd:uninstall");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function launchctl(args, options = {}) {
  try {
    execFileSync("launchctl", args, { stdio: options.ignoreError ? "ignore" : "inherit" });
  } catch (error) {
    if (!options.ignoreError) throw error;
  }
}

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(root)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(path.join(root, "dist", "src", "server.js"))}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(root, "data", "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(root, "data", "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
