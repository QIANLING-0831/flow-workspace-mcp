import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FlowStore } from "../src/store.js";
import { BrowserManager } from "../src/browser-manager.js";
import { FlowAdapter } from "../src/flow-adapter.js";
import { CookieBridge } from "../src/cookie-bridge.js";
import { FlowSequences } from "../src/sequence.js";
import { FlowError } from "../src/errors.js";
import type { GenerationRequest } from "../src/types.js";

test("serial shots preserve completed outputs, retry only current shot and continue on backup after restart", async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(),"flow-sequence-"));
  context.after(()=>rm(directory,{recursive:true,force:true}));
  const store = new FlowStore(directory);
  const browsers = new BrowserManager(store);
  const flow = new FlowAdapter(store,browsers,new CookieBridge());
  const submitted: string[] = [];
  const requests: GenerationRequest[] = [1,2,3].map(index=>({accountId:"a",mediaType:"video",prompt:`shot ${index}`,outputs:1,upscale:"none",referenceFiles:[],download:false,timeoutSeconds:15,outputDirectory:directory}));
  context.mock.method(flow,"generate",async (input:GenerationRequest,skipped:string[],onCreated?:(job:Awaited<ReturnType<FlowStore["createJob"]>>)=>Promise<void>)=> {
    assert.equal(input.download,true);
    submitted.push(`${input.prompt}:${input.accountId}`);
    if (input.prompt === "shot 3") assert.deepEqual(skipped,["a"]);
    const created = await store.createJob(input);
    await onCreated?.(created);
    return store.updateJob(created,"processing");
  });
  context.mock.method(flow,"refreshJob",async (id:string)=> {
    const original = await store.getJob(id);
    if (original.replacementJobId) return store.getJob(original.replacementJobId);
    if (original.prompt === "shot 2") {
      assert.equal(original.accountId,"a");
      await store.updateJob(original,"failed",{creditFailureConfirmed:true});
      submitted.push("shot 2:b");
      const replacement = await store.updateJob(await store.createJob({...requests[1]!,accountId:"b",fileName:original.fileName}),"completed",{retryOfJobId:original.id,skippedCreditAccounts:["a"]});
      await store.updateJob(original,"failed",{replacementJobId:replacement.id});
      return replacement;
    }
    return store.updateJob(original,"completed");
  });
  context.mock.method(flow,"downloadJob",async (id:string)=> {
    const job = await store.getJob(id);
    const file = path.join(directory,`${job.fileName}.mp4`);
    await writeFile(file,"fake fixture bytes, not a real video");
    return store.updateJob(job,"completed",{downloadedFiles:[file],downloadTransport:"http"});
  });
  const runner = new FlowSequences(store,flow,browsers);
  const start = await runner.start(requests);
  assert.equal(start.cursor,0); assert.deepEqual(submitted,["shot 1:a"]);
  assert.equal(start.submissionPending,false);
  assert.ok(start.jobIds[0]);
  const afterOne = await runner.advance(start.id);
  const firstJob = JSON.stringify(await store.getJob(afterOne.results[0]!.jobId));
  assert.equal(afterOne.cursor,1); assert.deepEqual(submitted,["shot 1:a","shot 2:a"]);
  const restarted = new FlowSequences(new FlowStore(directory),flow,browsers);
  // Concurrent polls serialize: second poll advances the already-recorded job, never duplicates it.
  const results = await Promise.all([restarted.advance(start.id),restarted.advance(start.id)]);
  assert.equal(results.at(-1)!.status,"completed");
  assert.deepEqual(submitted,["shot 1:a","shot 2:a","shot 2:b","shot 3:b"]);
  const done = await store.getSequence(start.id);
  assert.deepEqual(done.results.map(r=>r.shot),[1,2,3]);
  assert.equal(JSON.stringify(await store.getJob(done.results[0]!.jobId)),firstJob);
  await restarted.advance(start.id);
  assert.equal(submitted.length,4);
});

test("unknown in-flight submissions and download failures never start the next shot", async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(),"flow-sequence-stop-"));
  context.after(()=>rm(directory,{recursive:true,force:true}));
  const store = new FlowStore(directory); const browsers = new BrowserManager(store);
  const flow = new FlowAdapter(store,browsers,new CookieBridge());
  const request:GenerationRequest = {accountId:"a",mediaType:"video",prompt:"shot",outputs:1,upscale:"none",download:false,referenceFiles:[],timeoutSeconds:15,outputDirectory:directory};
  let calls = 0;
  context.mock.method(flow,"generate",async input=>{calls++;return store.updateJob(await store.createJob(input),"processing");});
  context.mock.method(flow,"refreshJob",async id=>store.updateJob(await store.getJob(id),"completed"));
  context.mock.method(flow,"downloadJob",async ()=>{throw new FlowError("download_failed","fixture");});
  const runner = new FlowSequences(store,flow,browsers);
  const sequence = await runner.start([request,request]);
  assert.equal((await runner.advance(sequence.id)).status,"failed"); assert.equal(calls,1);
  await runner.advance(sequence.id); assert.equal(calls,1);
  const interrupted = await runner.start([request]);
  interrupted.submissionPending = true; await store.saveSequence(interrupted);
  assert.equal((await runner.advance(interrupted.id)).status,"needs_attention"); assert.equal(calls,2);
  await assert.rejects(runner.start([{...request,outputs:2}]), /single-output/);
  await assert.rejects(store.getSequence("../../accounts"), /UUID/);
});
