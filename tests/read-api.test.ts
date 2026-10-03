import test from "node:test";
import assert from "node:assert/strict";
import { backendCreditBalance, bootstrapFields, conversationQuotaFailure, originalVideoUrl, trackedVideoId } from "../src/read-api.js";
import type { FlowJob } from "../src/types.js";

test("HTTP asset reads fail closed on identity, host and bootstrap changes", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const url = `https://flow-content.google/media/${id}/original.mp4`;
  const job = { mediaType: "video", outputs: 1, upscale: "none", generatedAssets: [{keys:[`url:${url}`]}] } as FlowJob;
  assert.equal(trackedVideoId(job), id);
  assert.equal(trackedVideoId({...job, outputs: 2}), null);
  assert.equal(trackedVideoId({...job, generatedAssets:[{keys:[`url:https://evil.example/${id}`]}]}), null);
  const data = [id, null, null, null, null, null, null, [[null,null,null,null,null,null,null,null,url]]];
  const raw = JSON.stringify([["wrb.fr","as29s",JSON.stringify(data)]]);
  assert.equal(originalVideoUrl(raw, id), url);
  assert.throws(()=>originalVideoUrl(raw, "22222222-2222-2222-2222-222222222222"));
  assert.throws(()=>originalVideoUrl(raw.replace("flow-content.google","evil.example"), id));
  assert.throws(()=>originalVideoUrl(raw.replace("https:","http:"), id));
  assert.deepEqual(bootstrapFields('{"SNlM0e":"token","cfb2h":"build","FdrFJe":"session"}'),{SNlM0e:"token",cfb2h:"build",FdrFJe:"session"});
  assert.throws(()=>bootstrapFields('{"SNlM0e":"token"}'));
});

test("backend quota requires the exact unique turn and structured error, never prose or another task", () => {
  const response = (status:string,code:string) => [null,[[null,null,null,null,["call","generate_video_from_text",[[["status",[null,null,status]],["error_code",[null,null,code]]]],"result"]]],"event"];
  const turn = (prompt:string,status="error",code="PUBLIC_ERROR_USER_QUOTA_REACHED") => [[[[[`Create exactly one video: ${prompt}`]]]], [response(status,code)]];
  const data = (turns:unknown[]) => [["conversation"],turns];
  assert.deepEqual(conversationQuotaFailure(data([turn("old"),turn("current")]),"current"),{matches:1,code:"PUBLIC_ERROR_USER_QUOTA_REACHED"});
  assert.deepEqual(conversationQuotaFailure(data([turn("old")]),"current"),{matches:0,code:null});
  assert.deepEqual(conversationQuotaFailure(data([turn("current"),turn("current")]),"current"),{matches:2,code:null});
  assert.deepEqual(conversationQuotaFailure(data([turn("current","queued")]),"current"),{matches:1,code:null});
  assert.deepEqual(conversationQuotaFailure(data([turn("current","error","PUBLIC_ERROR_RATE_LIMITED")]),"current"),{matches:1,code:null});
  assert.deepEqual(conversationQuotaFailure(data([turn("current","error","INSUFFICIENT_CREDITS")]),"current"),{matches:1,code:null});
  for(const code of ["PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED","PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED_UPGRADEABLE","PUBLIC_ERROR_WORKSPACE_ACCOUNT_QUOTA_REACHED"]) assert.deepEqual(conversationQuotaFailure(data([turn("current","error",code)]),"current"),{matches:1,code});
  assert.deepEqual(conversationQuotaFailure(data([turn("current","error","PUBLIC_ERROR_USER_REQUESTS_THROTTLED")]),"current"),{matches:1,code:null});
  assert.throws(()=>conversationQuotaFailure({},"current"));
});

test("backend balance accepts observed agreeing fields, never unknown as zero", () => {
  assert.equal(backendCreditBalance([3,3,8,1,null,3]),3);
  assert.equal(backendCreditBalance([29,3,8,1,null,29]),29);
  assert.equal(backendCreditBalance([0,3,8,1,null,0]),0);
  for (const data of [null,{},[],[3],[3,3],[-1,3,8,1,null,-1],["3",3,8,1,null,"3"],[3,3,8,1,null,4]]) assert.equal(backendCreditBalance(data),null);
});
