# Read API feasibility probe

Local verification on 2026-10-02; diagnostic prototype, not production integration.

Run `node scripts/probe-flow-read-api.mjs <completed-job-id>` after building.
Requires a connected account and the original completed job with tracked asset
keys and an SHA-256 media probe. Does not submit generation or update saved jobs.

Observed Flow asset read RPC `as29s` on the batchexecute transport. Replayed the
single observed read with the existing local session, without clicking buttons:
HTTP 200. Response identity matched the tracked job. Direct original-video GET
returned HTTP 200, video content type, 673015 bytes and exactly the same SHA-256
as the previously verified 4-second original download. Repeated successfully.
Initial checks rejected a thumbnail URL as image/jpeg; never accepted it as video.

Follow-up: independently constructed requests now pass using an HTTP GET for
session bootstrap followed by the read RPC. Cookies alone returned 400; ordinary
HTTP bootstrap supplies the required session/build/validation fields. A separate
HTTP request context borrowed the connected session cookies in memory and returned
the same original hash without browser navigation or observing requests.

The public adapter download path was also tested: `downloadTransport=http`,
673015 bytes, original SHA-256 unchanged and no editor navigation. A separate
HTTP cookie context isolates bootstrap updates from the browser request context.

Production `flow_download_job` now tries this path for exactly identified single
original videos, then falls back to existing exact-identity UI retrieval if the
read path is unsupported/unavailable. Session management still uses BrowserManager.
No production pending/failed status or generation submission paths were replaced.
Browser-free login and long-term session expiry behavior remain unverified.
The positional RPC fields are undocumented. Tokens remain in memory only; no
credentials, signed URLs or raw request/response payloads are stored in this repository.
