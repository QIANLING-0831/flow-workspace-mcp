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
import { confirmedCreditRejection, parseCreditBalance } from "../src/credits.js";
import type { FlowJob, GenerationRequest } from "../src/types.js";

test("credit parser ignores daily promotional grants and preserves unknown", () => {
  assert.equal(parseCreditBalance("Remaining AI credits: 1,200"), 1200);
  assert.equal(parseCreditBalance("0 credits remaining"), 0);
  assert.equal(parseCreditBalance("剩余额度：7"), 7);
  assert.equal(parseCreditBalance("7 AI credits"), 7);
  assert.equal(parseCreditBalance("3 Google Flow credits\nCredits refresh daily at 2:27 AM"), 3);
  assert.equal(parseCreditBalance("50 个 Google Flow 点数\n点数每天11:40 刷新"), 50);
  assert.equal(parseCreditBalance("Receive 50 additional Flow credits daily"), null);
  assert.equal(parseCreditBalance("Upgrade"), null);
  assert.equal(parseCreditBalance("Remaining credits: 10\n0 credits remaining"), null);
});

test("terminal credit rejection requires this prompt and an accepted quota failure, not no-charge wording", () => {
  const reply = "robot shot\nFailed\nYou've reached your credit limit. You won't be charged any credits for this failed attempt.";
  assert.equal(confirmedCreditRejection(reply, "robot shot"), true);
  assert.equal(confirmedCreditRejection(reply, "other shot"), false);
  assert.equal(confirmedCreditRejection("Failed. Reached your credit limit. You won't be charged.\nrobot shot\nQueued", "robot shot"), false);
  assert.equal(confirmedCreditRejection("robot shot\nFailed. Reached your credit limit.", "robot shot"), true);
  assert.equal(confirmedCreditRejection("robot shot\nFailed. Insufficient AI credits.", "robot shot"), true);
  assert.equal(confirmedCreditRejection("robot shot\nFailed. You've reached your credit or daily limit.", "robot shot"), true);
  assert.equal(confirmedCreditRejection("robot shot\nQueued. Not enough credits.", "robot shot"), false);
  assert.equal(confirmedCreditRejection("robot shot\nFailed. Rate limit. Insufficient AI credits.", "robot shot"), false);
  assert.equal(confirmedCreditRejection("robot shot\nFailed. Policy blocked. You won't be charged.", "robot shot"), false);
});

test("confirmed credit-failed jobs reroute once and preserve their replacement link", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flow-terminal-retry-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FlowStore(directory);
  for (const id of ["a", "b"]) {
    await store.ensureAccount(id);
    await store.markAccountConnected(id);
  }
  await store.configureAccountSwitching(["a", "b"]);
  const request: GenerationRequest = { accountId: "a", mediaType: "video", prompt: "shot", model: "omni-1-1-flash", outputs: 1, referenceFiles: ["reference.png"], upscale: "none", outputDirectory: directory, download: false, timeoutSeconds: 15 };
  request.aspectRatio = "16:9";
  request.durationSeconds = 4;
  request.fileName = "shot-003";
  const previous = await Promise.all([1,2].map(async index => store.updateJob(
    await store.createJob({...request,prompt:`finished shot ${index}`,fileName:`shot-00${index}`}),
    "completed", {downloadedFiles:[path.join(directory,`shot-00${index}.mp4`)]},
  )));
  const previousSnapshots = previous.map(job=>JSON.stringify(job));
  const original = await store.updateJob(await store.createJob(request), "failed", { creditFailureConfirmed: true });
  const adapter = new FlowAdapter(store, new BrowserManager(store), new CookieBridge());
  let attempts = 0;
  context.mock.method(adapter, "generate", async (input: GenerationRequest, skipped: string[]) => {
    attempts++;
    assert.equal(input.accountId, "b");
    assert.equal(input.model, request.model);
    assert.equal(input.fileName, "shot-003");
    assert.equal(input.aspectRatio, request.aspectRatio);
    assert.equal(input.durationSeconds, request.durationSeconds);
    assert.equal(input.prompt, request.prompt);
    assert.deepEqual(input.referenceFiles, request.referenceFiles);
    assert.deepEqual(skipped, ["a"]);
    return store.updateJob(await store.createJob(input), "processing");
  });
  const replacement = await adapter.refreshJob(original.id);
  assert.equal(replacement.retryOfJobId, original.id);
  assert.equal((await store.getJob(original.id)).replacementJobId, replacement.id);
  // Querying the original ID follows its recorded replacement, never resubmits.
  const follow = adapter as unknown as { readyPage(): Promise<unknown>; waitForNewMedia(): Promise<null> };
  context.mock.method(follow, "readyPage", async () => ({}));
  context.mock.method(follow, "waitForNewMedia", async () => null);
  await store.updateJob(replacement, "processing", { baselineMediaKeys: [] });
  assert.equal((await adapter.refreshJob(original.id)).id, replacement.id);
  assert.equal(attempts, 1);
  for (let index=0; index<previous.length; index++) {
    assert.equal(JSON.stringify(await store.getJob(previous[index]!.id)),previousSnapshots[index], "completed shots stay untouched");
  }
});

test("an old failed shot must not abort the next shot", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flow-old-failed-shot-"));
  context.after(()=>rm(directory,{recursive:true,force:true}));
  const store = new FlowStore(directory);
  const adapter = new FlowAdapter(store,new BrowserManager(store),new CookieBridge());
  const job = await store.createJob({accountId:"a",mediaType:"video",prompt:"next shot",outputs:1,referenceFiles:[],upscale:"none",outputDirectory:directory,download:false,timeoutSeconds:15});
  const seam = adapter as unknown as {
    mediaLocator(...args:unknown[]):unknown;
    mediaSnapshots(...args:unknown[]):Promise<unknown>;
    waitForNewMedia(...args:unknown[]):Promise<unknown>;
  };
  const candidate = {index:0,keys:["url:new-shot"],ready:true};
  context.mock.method(seam,"mediaLocator",()=>({evaluateAll:async()=>{}}));
  context.mock.method(seam,"mediaSnapshots",async()=>[candidate]);
  const page = {locator:()=>({innerText:async()=>"old shot\nGeneration failed. Please try again.\nnext shot\nQueued",count:async()=>1})};
  assert.deepEqual(await seam.waitForNewMedia(page,"video",[],1,15,job),[candidate]);
});

test("current failed credit-or-daily-quota message permits fallback without old no-charge text", () => {
  const prompt = "new regression robot shot";
  const body = `Failed\nYou have not been charged for this generation.\nold prompt\n${prompt}\nFailed\nSomething went wrong. Please try again.\nI couldn't generate that video because you've reached your credit or daily limit.`;
  assert.equal(confirmedCreditRejection(body, prompt), true);
  assert.equal(confirmedCreditRejection(`${prompt}\nQueued\nYou've reached your credit or daily limit.`,prompt), false);
  assert.equal(confirmedCreditRejection(`${prompt}\nFailed\nYou've reached your credit or daily limit. Too many requests.`,prompt), false);
});

test("a current failed credit reply without no-charge text routes the actual poll path once", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flow-credit-without-charge-"));
  context.after(() => rm(directory, {recursive:true, force:true}));
  const store = new FlowStore(directory);
  for (const id of ["a", "b"]) { await store.ensureAccount(id); await store.markAccountConnected(id); }
  await store.configureAccountSwitching(["a","b"]);
  const input: GenerationRequest = {accountId:"a",mediaType:"video",prompt:"robot shot",outputs:1,upscale:"none",referenceFiles:[],outputDirectory:directory,download:false,timeoutSeconds:15};
  const original = await store.updateJob(await store.createJob(input), "processing", {baselineMediaKeys:[]});
  const browsers = new BrowserManager(store);
  context.mock.method(browsers,"runExclusive",async (_id:string, operation:()=>Promise<unknown>)=>operation());
  const adapter = new FlowAdapter(store,browsers,new CookieBridge());
  const seam = adapter as unknown as {readyPage():Promise<unknown>};
  context.mock.method(seam,"readyPage",async ()=>({locator:()=>({innerText:async ()=>"robot shot\nFailed\nInsufficient AI credits."})}));
  let submissions = 0;
  context.mock.method(adapter,"generate",async (request:GenerationRequest)=> {
    submissions++; assert.equal(request.accountId,"b"); assert.equal(request.prompt,input.prompt);
    return store.updateJob(await store.createJob(request),"completed");
  });
  const result = await adapter.refreshJob(original.id);
  assert.equal(result.accountId,"b"); assert.equal(result.retryOfJobId,original.id);
  assert.equal((await store.getJob(original.id)).creditFailureConfirmed,true);
  assert.equal((await adapter.refreshJob(original.id)).id,result.id);
  assert.equal(submissions,1);
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

test("credit warning is checked before submission and never after an accepted job", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flow-warning-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FlowStore(directory);
  await store.ensureAccount("a");
  await store.markAccountConnected("a");
  const browsers = new BrowserManager(store);
  context.mock.method(browsers, "runExclusive", async (_id: string, operation: () => Promise<unknown>) => operation());
  const adapter = new FlowAdapter(store, browsers, new CookieBridge());
  let warning = true;
  let submitted = 0;
  const page = { url: () => "https://flow.google.com/project/test", getByRole: () => ({ isVisible: async () => warning }) };
  const seam = adapter as unknown as Record<string, (...args: any[]) => Promise<any>>;
  context.mock.method(seam, "readyPage", async () => page);
  for (const method of ["openProject", "ensureAgentAutoApprove", "configureGeneration", "attachReferences", "fillPrompt", "captureDiagnostic"]) {
    context.mock.method(seam, method, async () => undefined);
  }
  context.mock.method(seam, "stableMediaBaseline", async () => []);
  context.mock.method(seam, "clickGenerate", async () => { submitted++; warning = true; });
  context.mock.method(seam, "waitForNewMedia", async () => undefined);
  const request: GenerationRequest = { accountId: "a", mediaType: "video", prompt: "shot", outputs: 1, referenceFiles: [], upscale: "none", outputDirectory: directory, download: false, timeoutSeconds: 15 };
  await assert.rejects(adapter.generate(request), /No selected account can fund/);
  assert.equal(submitted, 0);
  warning = false;
  const job = await adapter.generate(request);
  assert.equal(submitted, 1);
  assert.equal(job.status, "processing", "a post-submission warning cannot reroute a queued job");
});
