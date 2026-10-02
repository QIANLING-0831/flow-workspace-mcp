import type { APIRequestContext } from "playwright";
import type { FlowJob } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function trackedVideoId(job: FlowJob): string | null {
  if (job.mediaType !== "video" || job.outputs !== 1 || job.upscale !== "none" || job.generatedAssets?.length !== 1) return null;
  const ids = new Set<string>();
  for (const key of job.generatedAssets[0]!.keys) {
    if (!key.startsWith("url:") && !key.startsWith("url-stable:")) continue;
    try {
      const url = new URL(key.slice(key.indexOf(":") + 1));
      if (url.protocol !== "https:" || url.hostname !== "flow-content.google") continue;
      for (const part of url.pathname.split("/")) if (UUID.test(part)) ids.add(part);
    } catch { /* Unsupported keys stay on the existing UI path. */ }
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

export function bootstrapFields(html: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["SNlM0e", "cfb2h", "FdrFJe"]) {
    const encoded = html.match(new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`))?.[1];
    if (!encoded) throw new Error("Flow HTTP session bootstrap unavailable");
    const value: unknown = JSON.parse(encoded);
    if (typeof value !== "string" || !value) throw new Error("Flow HTTP session bootstrap changed");
    result[key] = value;
  }
  return result;
}

export function originalVideoUrl(raw: string, assetId: string): string {
  const rows: unknown[][] = raw.split("\n").flatMap(line => {
    try { const value = JSON.parse(line); return Array.isArray(value) ? value.filter(Array.isArray) : []; } catch { return []; }
  });
  const matches = rows.filter(row => Array.isArray(row) && row[0] === "wrb.fr" && row[1] === "as29s");
  if (matches.length !== 1 || typeof matches[0]![2] !== "string") throw new Error("Flow asset response changed");
  const data = JSON.parse(matches[0]![2] as string);
  // ponytail: observed positional RPC schema; fail closed on identity/schema changes.
  if (data[0] !== assetId) throw new Error("Flow returned a different asset");
  const value: unknown = data?.[7]?.[0]?.[8];
  if (typeof value !== "string") throw new Error("Flow original video unavailable");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "flow-content.google") throw new Error("Flow media host changed");
  return url.href;
}

/** Read-only HTTP path. No browser navigation, generation or persisted tokens. */
export async function readOriginalVideo(request: APIRequestContext, job: FlowJob): Promise<Buffer | null> {
  const assetId = trackedVideoId(job);
  if (!assetId || !job.flowProjectUrl) return null;
  const project = new URL(job.flowProjectUrl);
  if (project.protocol !== "https:" || project.hostname !== "flow.google.com" || !project.pathname.startsWith("/project/")) return null;
  const bootstrap = await request.get(project.href, { timeout: 15000 });
  let fields: Record<string, string>;
  try {
    if (!bootstrap.ok()) throw new Error("Flow HTTP session unavailable");
    fields = bootstrapFields(await bootstrap.text());
  } finally { await bootstrap.dispose(); }
  const endpoint = new URL("https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute");
  endpoint.search = new URLSearchParams({ rpcids: "as29s", "source-path": project.pathname, bl: fields.cfb2h!, "f.sid": fields.FdrFJe!, hl: "en", rt: "c" }).toString();
  const body = new URLSearchParams({ "f.req": JSON.stringify([[["as29s", JSON.stringify([assetId]), null, "generic"]]]), at: fields.SNlM0e! });
  const reply = await request.post(endpoint.href, { data: body.toString(), headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, timeout: 15000 });
  let mediaUrl: string;
  try {
    if (!reply.ok()) throw new Error("Flow asset read failed");
    mediaUrl = originalVideoUrl(await reply.text(), assetId);
  } finally { await reply.dispose(); }
  const media = await request.get(mediaUrl, { timeout: 120000 });
  try {
    if (!media.ok() || !media.headers()["content-type"]?.toLowerCase().startsWith("video/")) throw new Error("Flow original is not a video");
    const bytes = await media.body();
    if (!bytes.length) throw new Error("Flow original is empty");
    return bytes;
  } finally { await media.dispose(); }
}
