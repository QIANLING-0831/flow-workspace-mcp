// Read-only diagnostic; no navigation, generation, token logging or job mutation.
// Usage: node scripts/probe-flow-read-api.mjs <completed-job-id>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'playwright';
import { BrowserManager } from '../dist/browser-manager.js';
import { FlowStore } from '../dist/store.js';
import { readOriginalVideo } from '../dist/read-api.js';
const job = await new FlowStore().getJob(process.argv[2]);
assert.equal(job.status, 'completed');
const page = await new BrowserManager(new FlowStore()).pageFor(job.accountId);
const before = page.url();
// Only borrow the existing session. All reads use a separate HTTP context.
const client = await request.newContext({storageState:{cookies:await page.context().cookies(),origins:[]}});
try {
  const bytes = await readOriginalVideo(client, job);
  assert.ok(bytes, 'Tracked original must be supported');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),job.mediaProbe[0].sha256);
  assert.equal(page.url(),before,'Must not navigate the editor');
  console.log(JSON.stringify({bytes:bytes.length,originalHashMatch:true,editorNavigation:false}));
} finally { await client.dispose(); }
process.exit(0);
