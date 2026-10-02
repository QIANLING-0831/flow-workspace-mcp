import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { BrowserManager } from "../src/browser-manager.js";
import { FlowStore } from "../src/store.js";

test("prepared Flow pages use a desktop viewport that exposes Agent controls", async () => {
  const operations: unknown[] = [];
  const page = {
    setViewportSize: async (size: unknown) => { operations.push(size); },
    setDefaultTimeout: (milliseconds: number) => { operations.push(milliseconds); },
    setDefaultNavigationTimeout: (milliseconds: number) => { operations.push(milliseconds); },
  } as unknown as Page;
  const manager = new BrowserManager(new FlowStore()) as unknown as { preparePage(page: Page): Promise<void> };
  await manager.preparePage(page);
  assert.deepEqual(operations, [{ width: 1920, height: 1080 }, 10_000, 45_000]);
});
