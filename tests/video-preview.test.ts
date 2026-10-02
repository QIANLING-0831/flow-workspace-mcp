import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Download, Locator, Page } from "playwright";
import { FlowAdapter } from "../src/flow-adapter.js";
import { FlowStore } from "../src/store.js";
import { BrowserManager } from "../src/browser-manager.js";
import { CookieBridge } from "../src/cookie-bridge.js";
import type { FlowJob } from "../src/types.js";
import type { MediaSnapshot } from "../src/media-selection.js";

test("a new video thumbnail downloads Original size from its own editor, never an upscale", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flow-video-preview-"));
  context.after(() => rm(directory, {recursive: true, force: true}));
  const store = new FlowStore(directory);
  const adapter = new FlowAdapter(store, new BrowserManager(store), new CookieBridge());
  const job = await store.createJob({accountId: "test", mediaType: "video", prompt: "wave once", outputs: 1,
    referenceFiles: [], upscale: "none", outputDirectory: directory, download: true, timeoutSeconds: 20});
  job.flowProjectUrl = "https://flow.google.com/project/test";
  const clicks: string[] = [];
  class Control {
    constructor(readonly kind: string) {}
    locator() {return new Control("preview");}
    filter(options: {hasText?: RegExp}) {return new Control(options.hasText ? "original" : "download");}
    nth() {return this;}
    first() {return this;}
    async count() {return this.kind === "video" ? 0 : 1;}
    async isVisible() {return true;}
    async isEnabled() {return true;}
    async waitFor() {}
    async evaluateAll() {return [];}
    async click() {clicks.push(this.kind);}
    async innerText() {return "Your video is queued.";}
  }
  const page = {locator: (selector: string) => new Control(selector === "video" ? "video" : "control"),
    url: () => "https://flow.google.com/project/test/edit/asset", waitForTimeout: async () => {},
    waitForEvent: async (event: string) => {assert.equal(event, "download"); return {} as Download;}} as unknown as Page;
  const preview: MediaSnapshot = {index: 0, keys: ["url:new-thumbnail"], ready: false, sourceUrl: "https://example.test/new-thumbnail"};
  const ui = adapter as unknown as {
    mediaSnapshots(page: Page, type: string): Promise<MediaSnapshot[]>;
    mediaLocator(page: Page, type: string): Locator;
    saveCapturedDownload(job: FlowJob, download: Download, suffix: string): Promise<void>;
    waitForNewMedia(page: Page, type: string, baseline: string[], count: number, timeout: number, job: FlowJob): Promise<MediaSnapshot[] | null>;
  };
  context.mock.method(ui, "mediaSnapshots", async () => [preview]);
  context.mock.method(ui, "mediaLocator", () => new Control("thumbnail") as unknown as Locator);
  context.mock.method(ui, "saveCapturedDownload", async (savedJob, _download, suffix) => {
    assert.equal(suffix, "original");
    assert.deepEqual(savedJob.generatedAssets, [{keys: preview.keys}]);
    await store.updateJob(savedJob, "completed");
  });
  assert.deepEqual(await ui.waitForNewMedia(page, "video", ["url:old-thumbnail"], 1, 20, job), []);
  assert.deepEqual(clicks, ["preview", "download", "original"]);
  assert.equal(job.status, "completed");
});
