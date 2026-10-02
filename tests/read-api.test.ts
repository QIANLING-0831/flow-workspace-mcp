import test from "node:test";
import assert from "node:assert/strict";
import { bootstrapFields, originalVideoUrl, trackedVideoId } from "../src/read-api.js";
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
