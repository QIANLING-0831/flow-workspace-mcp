import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FlowStore } from "../src/store.js";

test("accounts use isolated profile directories and a stable default", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "flow-mcp-store-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const store = new FlowStore(temporary);

  await store.ensureAccount("personal", "Personal");
  await store.ensureAccount("studio", "Studio");
  const accounts = await store.listAccounts();

  assert.equal(accounts.defaultAccountId, "personal");
  assert.deepEqual(accounts.accounts.map((account) => account.id), ["personal", "studio"]);
  assert.notEqual(store.profileDir("personal"), store.profileDir("studio"));
  assert.equal((await store.requireAccount()).id, "personal");
  await store.setHeadlessAfterLogin("personal", true);
  assert.equal((await store.requireAccount("personal")).headlessAfterLogin, true);
});

test("jobs persist without browser state", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "flow-mcp-job-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const store = new FlowStore(temporary);
  await store.ensureAccount("personal");
  const job = await store.createJob({
    accountId: "personal",
    mediaType: "video",
    prompt: "A slow camera move through a miniature city",
    outputs: 1,
    referenceFiles: [],
    upscale: "2x",
    outputDirectory: path.join(temporary, "output"),
    download: true,
    timeoutSeconds: 60,
  });

  await store.updateJob(job, "processing", { baselineMediaCount: 3 });
  const restored = await store.getJob(job.id);
  assert.equal(restored.status, "processing");
  assert.equal(restored.baselineMediaCount, 3);
  assert.equal(restored.upscale, "2x");
});

test("CDP account attachment is localhost-only and persisted", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "flow-mcp-cdp-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const store = new FlowStore(temporary);

  const account = await store.ensureAccount("main", "Main Chromium", {
    browserMode: "attach_cdp",
    cdpUrl: "http://127.0.0.1:9222/",
  });
  assert.equal(account.browserMode, "attach_cdp");
  assert.equal(account.cdpUrl, "http://127.0.0.1:9222");
  await assert.rejects(
    () => store.ensureAccount("remote", "Unsafe", { browserMode: "attach_cdp", cdpUrl: "https://browser.example.com" }),
    /localhost/,
  );
});
