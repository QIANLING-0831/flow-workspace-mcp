#!/usr/bin/env node
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, "..");

function fail(message) {
  throw new Error(`Antigravity setup refused: ${message}`);
}

export function assertStableCleanClone(repoRoot) {
  const normalized = path.resolve(repoRoot);
  if (/[\\/]\.gemini[\\/]antigravity[\\/]scratch(?:[\\/]|$)/i.test(normalized)) {
    fail("the repository is inside Antigravity's disposable scratch directory. Clone it to a stable directory such as %LOCALAPPDATA%\\google-flow-mcp.");
  }
  if (!existsSync(path.join(normalized, "package.json"))) fail(`package.json was not found in ${normalized}`);
  if (existsSync(path.join(normalized, ".git"))) {
    const status = execFileSync("git", ["-C", normalized, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
    if (status) {
      fail(`tracked repository files were modified. Restore or reclone the published source; installers must never patch it.\n${status}`);
    }
  }
  return normalized;
}

export function detectSystemBrowser(environment = process.env) {
  const local = environment.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    environment.FLOW_MCP_BROWSER_EXECUTABLE,
    path.join(local, "Chromium", "Application", "chrome.exe"),
    "C:\\Program Files\\Chromium\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

export async function writeAntigravityConfig({ repoRoot, configPath, nodeExecutable = process.execPath }) {
  const distEntry = path.join(repoRoot, "dist", "index.js");
  if (!existsSync(distEntry)) fail("dist/index.js is missing. Run npm run check before configuration.");
  let config = { mcpServers: {} };
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      fail(`the existing Antigravity MCP config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) fail("the MCP config root must be a JSON object.");
  if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) config.mcpServers = {};
  config.mcpServers["google-flow"] = {
    command: path.resolve(nodeExecutable),
    args: [path.resolve(distEntry)],
    cwd: path.resolve(repoRoot),
    env: { FLOW_MCP_HEADLESS: "0" },
  };
  await mkdir(path.dirname(configPath), { recursive: true });
  if (existsSync(configPath)) await copyFile(configPath, `${configPath}.bak`);
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await stat(temporary);
  await writeFile(configPath, await readFile(temporary));
  await rm(temporary, { force: true });
  return config.mcpServers["google-flow"];
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed with exit code ${result.status}.`);
}

export function npmInvocation(environment = process.env) {
  const candidates = [
    environment.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (npmCli) return { command: process.execPath, prefix: [npmCli] };
  if (process.platform === "win32") fail("npm-cli.js could not be located beside the current Node.js installation.");
  return { command: "npm", prefix: [] };
}

export async function setupAntigravity({ repoRoot = defaultRepoRoot, configPath } = {}) {
  const stableRoot = assertStableCleanClone(repoRoot);
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < 20) fail(`Node.js 20 or newer is required; current version is ${process.version}.`);
  const browser = detectSystemBrowser();
  if (!browser) {
    fail("no system Chromium or Google Chrome installation was found. Install a normal desktop Chromium/Chrome browser; do not run `npx playwright install chromium`.");
  }
  const npm = npmInvocation();
  run(npm.command, [...npm.prefix, "ci"], stableRoot);
  run(npm.command, [...npm.prefix, "run", "check"], stableRoot);
  run(npm.command, [...npm.prefix, "pack", "--dry-run"], stableRoot);
  assertStableCleanClone(stableRoot);
  const destination = configPath ?? path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
  const entry = await writeAntigravityConfig({ repoRoot: stableRoot, configPath: destination });
  const extensionDirectory = path.join(stableRoot, "extension");
  console.log(JSON.stringify({
    status: "INSTALL_COMPLETE_USER_SETUP_REQUIRED",
    configPath: destination,
    mcpEntry: entry,
    detectedBrowser: browser,
    extensionDirectory,
    nextSteps: [
      "In Antigravity: Settings > Customizations > Installed MCP Servers > Refresh.",
      "In normal Chromium: remove any Flow Login Bridge loaded from a different folder, open chrome://extensions, enable Developer mode, choose Load unpacked, and select extensionDirectory.",
      "Ask the agent: Connect my Google Flow account.",
      "The agent must call flow_begin_account_connection and then tell you to open Flow Login Bridge and click Connect Flow.",
      "Reply connected only after the extension popup says the session was sent; then select your existing Google account in the temporary chooser.",
    ],
    forbiddenInstallerActions: [
      "Do not edit repository source files.",
      "Do not run npx playwright install chromium.",
      "Do not generate or copy MCP tool schemas; Antigravity discovers them after Refresh.",
      "Do not place this repository under an Antigravity scratch directory.",
    ],
  }, null, 2));
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  setupAntigravity().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
