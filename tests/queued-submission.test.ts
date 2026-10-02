import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { FlowAdapter } from "../src/flow-adapter.js";
import { FlowStore } from "../src/store.js";
import { BrowserManager } from "../src/browser-manager.js";
import { CookieBridge } from "../src/cookie-bridge.js";

test("a queued video without a mounted player is submitted once and remains pollable", async (context) => {
  let elapsed = 0;
  let clicks = 0;
  context.mock.method(Date, "now", () => elapsed);
  class Control {
    constructor(readonly kind = "none") {}
    locator() { return this; }
    filter(options: {has?: Control; hasText?: RegExp}) {
      return new Control(options.has?.kind ?? (options.hasText?.test("tune") ? "tune" : options.hasText?.test("arrow_forward") ? "generate" : "none"));
    }
    last() { return this; }
    nth() { return this; }
    async count() { return ["tune", "generate"].includes(this.kind) ? 1 : 0; }
    async isVisible() { return true; }
    async isEnabled() { return true; }
    async click() { clicks += 1; }
    async innerText() { return "Your video is scheduled and currently in the queue."; }
  }
  const page = {
    locator: (selector: string, options?: {hasText?: RegExp}) => options?.hasText
      ? new Control(options.hasText.test("tune") ? "tune" : options.hasText.test("arrow_forward") ? "generate" : "none")
      : new Control(selector === "body" ? "body" : "none"),
    getByRole: () => new Control(),
    getByText: () => new Control(),
    waitForTimeout: async (milliseconds: number) => {elapsed += milliseconds;},
  } as unknown as Page;
  const store = new FlowStore();
  const adapter = new FlowAdapter(store, new BrowserManager(store), new CookieBridge()) as unknown as {
    clickGenerate(page: Page, type: "video", baseline: number): Promise<void>;
  };
  await assert.doesNotReject(adapter.clickGenerate(page, "video", 0));
  assert.equal(clicks, 1);
  assert.ok(elapsed < 20_000, "return promptly so status polling owns queue waits");
});
