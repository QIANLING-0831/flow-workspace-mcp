import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FlowAdapter } from "../src/flow-adapter.js";
import { FlowStore } from "../src/store.js";
import { BrowserManager } from "../src/browser-manager.js";
import { CookieBridge } from "../src/cookie-bridge.js";
import { FlowError } from "../src/errors.js";
import { parseCreditBalance } from "../src/credits.js";
import type { FlowJob, GenerationRequest } from "../src/types.js";

test("credit parser ignores daily promotional grants and preserves unknown", () => {
  assert.equal(parseCreditBalance("Remaining AI credits: 1,200"), 1200);
  assert.equal(parseCreditBalance("0 credits remaining"), 0);
  assert.equal(parseCreditBalance("剩余额度：7"), 7);
  assert.equal(parseCreditBalance("7 AI credits"), 7);
  assert.equal(parseCreditBalance("3 Google Flow credits\nCredits refresh daily at 2:27 AM"), 3);
  assert.equal(parseCreditBalance("Receive 50 additional Flow credits daily"), null);
  assert.equal(parseCreditBalance("Upgrade"), null);
  assert.equal(parseCreditBalance("Remaining credits: 10\n0 credits remaining"), null);
});

test("routing falls back only before submission on typed credit insufficiency", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flow-switch-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FlowStore(directory);
  for (const id of ["a", "b"]) {
    await store.ensureAccount(id);
    await store.markAccountConnected(id);
  }
  await assert.rejects(store.configureAccountSwitching(["a", "a"]), /unique/);
  await assert.rejects(store.configureAccountSwitching(["missing"]), /not configured/);
  await store.configureAccountSwitching(["a", "b"]);
  const adapter = new FlowAdapter(store, new BrowserManager(store), new CookieBridge());
  const seam = adapter as unknown as { generateOnAccount(request: GenerationRequest, check: boolean): Promise<FlowJob> };
  const request: GenerationRequest = { accountId: "a", mediaType: "video", prompt: "one shot", outputs: 1, referenceFiles: [], upscale: "none", outputDirectory: directory, download: false, timeoutSeconds: 15 };
  const attempted: string[] = [];
  let failure: FlowError | undefined = new FlowError("insufficient_credits", "before submission");
  context.mock.method(seam, "generateOnAccount", async (input: GenerationRequest, check: boolean) => {
    assert.equal(check, true);
    attempted.push(input.accountId);
    assert.equal(input.prompt, request.prompt);
    if (input.accountId === "a" && failure) throw failure;
    return store.updateJob(await store.createJob(input), "processing");
  });
  const routed = await adapter.generate(request);
  assert.deepEqual(attempted, ["a", "b"]);
  assert.equal(routed.accountId, "b");
  assert.deepEqual(routed.skippedCreditAccounts, ["a"]);
  for (const code of ["generation_timeout", "generation_failed", "login_required", "browser_error", "unsupported_option"] as const) {
    attempted.length = 0;
    failure = new FlowError(code, "not a credit rejection");
    await assert.rejects(adapter.generate(request), (error) => error === failure);
    assert.deepEqual(attempted, ["a"]);
  }
  attempted.length = 0;
  failure = undefined;
  assert.equal((await adapter.generate(request)).status, "processing");
  assert.deepEqual(attempted, ["a"], "accepted or queued jobs must not be resubmitted");
  await assert.rejects(adapter.generate({ ...request, outputs: 2 }), /outputs=1/);
  context.mock.method(seam, "generateOnAccount", async (input: GenerationRequest) => {
    attempted.push(input.accountId);
    throw new FlowError("insufficient_credits", "pre-submission rejection");
  });
  attempted.length = 0;
  await assert.rejects(adapter.generate(request), /No selected account can fund/);
  assert.deepEqual(attempted, ["a", "b"], "all exhausted accounts are tried at most once");
  await store.configureAccountSwitching([]);
  attempted.length = 0;
  await assert.rejects(adapter.generate(request), /No selected account can fund/);
  assert.deepEqual(attempted, ["a"], "empty whitelist disables fallback");
  assert.notEqual(store.profileDir("a"), store.profileDir("b"));
});

test("real generation preflight treats zero as exhausted but unknown as unknown", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flow-credit-preflight-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FlowStore(directory);
  await store.ensureAccount("a");
  await store.markAccountConnected("a");
  const browsers = new BrowserManager(store);
  context.mock.method(browsers, "runExclusive", async (_id: string, operation: () => Promise<unknown>) => operation());
  const adapter = new FlowAdapter(store, browsers, new CookieBridge());
  let balance: number | null = 0;
  let opened = 0;
  const seam = adapter as unknown as {
    generateOnAccount(request: GenerationRequest, check: boolean): Promise<FlowJob>;
    readyPage(): Promise<unknown>;
    readCredits(): Promise<unknown>;
    captureDiagnostic(): Promise<undefined>;
    openProject(): Promise<void>;
  };
  context.mock.method(seam, "readyPage", async () => ({ url: () => "https://flow.google.com/project/test" }));
  context.mock.method(seam, "readCredits", async () => ({ remainingCredits: balance }));
  context.mock.method(seam, "captureDiagnostic", async () => undefined);
  context.mock.method(seam, "openProject", async () => { opened++; throw new FlowError("browser_error", "stop test before submission"); });
  const request: GenerationRequest = { accountId: "a", mediaType: "video", prompt: "shot", outputs: 1, referenceFiles: [], upscale: "none", outputDirectory: directory, download: false, timeoutSeconds: 15 };
  await assert.rejects(seam.generateOnAccount(request, true), (error) => error instanceof FlowError && error.code === "insufficient_credits");
  assert.equal(opened, 0);
  balance = null;
  await assert.rejects(seam.generateOnAccount(request, true), (error) => error instanceof FlowError && error.code === "browser_error");
  assert.equal(opened, 1, "unknown balance does not reject as exhausted");
});
