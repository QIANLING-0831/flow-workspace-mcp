// Read-only acceptance check; never generates media or changes saved jobs.
// Usage: node scripts/verify-flow-chain.mjs <original-job-id> <replacement-job-id>
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { FlowStore } from '../dist/store.js';
import { probeMedia } from '../dist/media.js';
const store = new FlowStore();
const original = await store.getJob(process.argv[2]);
const replacement = await store.getJob(process.argv[3]);
assert.equal(original.status, 'failed');
assert.equal(original.creditFailureConfirmed, true);
assert.equal(original.replacementJobId, replacement.id);
assert.equal(replacement.retryOfJobId, original.id);
assert.notEqual(original.accountId, replacement.accountId);
for (const key of ['prompt','model','aspectRatio','outputs','upscale']) assert.equal(original[key], replacement[key]);
assert.equal(replacement.status, 'completed');
assert.equal(replacement.downloadTransport, 'http');
assert.equal(replacement.downloadedFiles?.length, 1);
const file = replacement.downloadedFiles[0];
await access(file);
const probe = await probeMedia(file);
assert.equal(probe.sha256, replacement.mediaProbe[0].sha256);
assert.equal(probe.ffprobeAvailable, true);
assert.ok(probe.durationSeconds > 0 && probe.width > 0 && probe.height > 0);
assert.ok(probe.durationSeconds <= 6);
assert.equal(probe.width * 9, probe.height * 16);
console.log(JSON.stringify({creditFallback:true,linkedJobs:true,samePromptAndSettings:true,httpDownload:true,mediaProbe:probe}));
