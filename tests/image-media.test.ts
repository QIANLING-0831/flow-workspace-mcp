import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { FlowAdapter } from "../src/flow-adapter.js";
import { FlowStore } from "../src/store.js";
import { BrowserManager } from "../src/browser-manager.js";
import { CookieBridge } from "../src/cookie-bridge.js";
import { uniqueMediaSources, resolveMediaIdentities, type MediaSnapshot } from "../src/media-selection.js";

test("gallery and chat previews of the same source remain one exact asset", () => {
  const images: MediaSnapshot[] = [0, 1].map(index => ({index, keys: ["url:robot"], ready: true, sourceUrl: "https://example.test/robot.png"}));
  const unique = uniqueMediaSources(images);
  assert.equal(unique.length, 1);
  assert.equal(resolveMediaIdentities(unique, [{keys: ["url:robot"]}])?.[0]?.index, 0);
  assert.equal(uniqueMediaSources([...images, {...images[0]!, index: 2, sourceUrl: "https://example.test/other.png"}]).length, 2);
});

test("HTTP success cannot bypass decoded image dimensions for avatars", async () => {
  const store = new FlowStore();
  const adapter = new FlowAdapter(store, new BrowserManager(store), new CookieBridge());
  const ui = adapter as unknown as {isMediaSourceReady(page: Page, media: MediaSnapshot, type: "image"): Promise<boolean>};
  const page = {context: () => {throw Error("Image readiness must not make HTTP requests");}} as unknown as Page;
  assert.equal(await ui.isMediaSourceReady(page, {index: 0, keys: ["avatar"], ready: false, sourceUrl: "https://example.test/avatar.png"}, "image"), false);
});
