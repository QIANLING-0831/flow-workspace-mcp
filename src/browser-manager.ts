import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { FlowError } from "./errors.js";
import { FlowStore } from "./store.js";

interface AccountBrowser {
  context: BrowserContext;
  page: Page;
  managed: boolean;
}

function systemChromiumCandidates(): string[] {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  if (process.platform === "win32") {
    return [
      path.join(local, "Chromium", "Application", "chrome.exe"),
      "C:\\Program Files\\Chromium\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];
  }
  return [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
}

export function findBrowserExecutable(): string | undefined {
  const explicit = process.env.FLOW_MCP_BROWSER_EXECUTABLE;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new FlowError("browser_error", `FLOW_MCP_BROWSER_EXECUTABLE does not exist: ${explicit}`);
    }
    return path.resolve(explicit);
  }
  return systemChromiumCandidates().find(existsSync);
}

export class BrowserManager {
  private readonly browsers = new Map<string, AccountBrowser>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly store: FlowStore) {}

  async pageFor(accountId: string): Promise<Page> {
    const existing = this.browsers.get(accountId);
    if (existing && !existing.page.isClosed()) return existing.page;

    const account = await this.store.requireAccount(accountId);
    const headless = process.env.FLOW_MCP_HEADLESS === "1";
    try {
      if (account.browserMode === "attach_cdp") {
        if (!account.cdpUrl) {
          throw new FlowError("validation_error", `Account '${accountId}' uses attach_cdp but has no cdpUrl.`);
        }
        const browser = await chromium.connectOverCDP(account.cdpUrl);
        const context = browser.contexts()[0];
        if (!context) throw new FlowError("browser_error", `No browser context was exposed at ${account.cdpUrl}.`);
        const page = context.pages().find((candidate) => candidate.url().startsWith("https://labs.google/"))
          ?? (await context.newPage());
        page.setDefaultTimeout(10_000);
        page.setDefaultNavigationTimeout(45_000);
        this.browsers.set(accountId, { context, page, managed: false });
        return page;
      }

      const executablePath = findBrowserExecutable();
      const context = await chromium.launchPersistentContext(this.store.profileDir(accountId), {
        ...(executablePath
          ? { executablePath }
          : { channel: process.env.FLOW_MCP_CHROME_CHANNEL || "chrome" }),
        headless,
        acceptDownloads: true,
        viewport: null,
        locale: "en-US",
      });
      const page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(45_000);
      this.browsers.set(accountId, { context, page, managed: true });
      return page;
    } catch (error) {
      throw new FlowError(
        "browser_error",
        `Could not launch Chromium for Flow account '${accountId}': ${error instanceof Error ? error.message : String(error)}`,
        [
          "Install Chromium/Chrome, or set FLOW_MCP_BROWSER_EXECUTABLE to its absolute executable path.",
          "Close another browser process if it is already using this account's dedicated profile.",
        ],
      );
    }
  }

  async runExclusive<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.queues.set(accountId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(accountId) === tail) this.queues.delete(accountId);
    }
  }

  async reset(accountId: string): Promise<void> {
    const existing = this.browsers.get(accountId);
    if (!existing) return;
    this.browsers.delete(accountId);
    if (existing.managed) await existing.context.close();
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.browsers.values()]
        .filter(({ managed }) => managed)
        .map(({ context }) => context.close()),
    );
    this.browsers.clear();
  }
}
