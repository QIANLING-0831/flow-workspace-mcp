// Read-only historical evidence; never submits, navigates, or changes jobs.
// Usage: node scripts/probe-flow-quota-api.mjs <quota-failed-job-id>
import assert from 'node:assert/strict';
import { request } from 'playwright';
import { BrowserManager } from '../dist/browser-manager.js';
import { FlowStore } from '../dist/store.js';
import { readConversationBaseline, readJobQuotaFailure } from '../dist/read-api.js';
const store = new FlowStore();
const job = await store.getJob(process.argv[2]);
const saved = JSON.stringify(job);
const page = await new BrowserManager(store).pageFor(job.accountId);
const url = page.url();
const client = await request.newContext({storageState:{cookies:await page.context().cookies(),origins:[]}});
try {
  // Explicit empty historical boundary is diagnostic only, never persisted for routing.
  const evidence = await readJobQuotaFailure(client,{...job,backendConversationBaseline:{}});
  assert.equal(evidence?.code,'PUBLIC_ERROR_USER_QUOTA_REACHED');
  const baseline = await readConversationBaseline(client,job.flowProjectUrl);
  assert.equal(await readJobQuotaFailure(client,{...job,backendConversationBaseline:baseline}),null,'Existing failure must not be borrowed for a new submission');
  assert.equal(page.url(),url);
  assert.equal(JSON.stringify(await store.getJob(job.id)),saved);
  console.log(JSON.stringify({backendCode:evidence.code,exactPrompt:true,oldFailureExcluded:true,navigation:false,jobMutation:false,generation:false}));
} finally { await client.dispose(); }
process.exit(0);
