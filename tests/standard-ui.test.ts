import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { FlowAdapter } from "../src/flow-adapter.js";
import { FlowStore } from "../src/store.js";
import { BrowserManager } from "../src/browser-manager.js";
import { CookieBridge } from "../src/cookie-bridge.js";

test("Chinese account balance waits for loading and dismisses outside the panel", async (context) => {
  let elapsed = 0;
  let closePosition: unknown;
  context.mock.method(Date, "now", () => elapsed);
  class Control {
    constructor(readonly kind: string) {}
    async count() { return 1; }
    nth() { return this; }
    async isVisible() { return true; }
    async click(options?: { position?: unknown }) { if (this.kind === "backdrop") closePosition = options?.position; }
    async innerText() { return elapsed < 1_000 ? "正在加载" : "50 个 Google Flow 点数\n点数每天11:40 刷新"; }
  }
  const page = {
    getByRole: () => new Control("profile"),
    locator: (selector: string) => new Control(selector === ".cdk-overlay-backdrop" ? "backdrop" : "panel"),
    keyboard: { press: async () => {} },
    waitForTimeout: async (milliseconds: number) => { elapsed += milliseconds; },
  } as unknown as Page;
  const store = new FlowStore();
  const adapter = new FlowAdapter(store, new BrowserManager(store), new CookieBridge()) as unknown as {
    readCredits(page: Page): Promise<{ remainingCredits: number | null }>;
    ensureAgentAutoApprove(page: Page): Promise<string>;
  };
  assert.equal((await adapter.readCredits(page)).remainingCredits, 50);
  assert.ok(elapsed >= 1_000);
  assert.deepEqual(closePosition, { x: 5, y: 5 });
  assert.equal(await adapter.ensureAgentAutoApprove(page), "direct_submit", "ordinary composer has no Agent approval settings");
});
