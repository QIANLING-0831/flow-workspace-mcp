import type { APIRequestContext } from "playwright";
import type { FlowJob } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Verified in the current Google client quota category; throttling is not quota.
const QUOTA_CODES = new Set(["PUBLIC_ERROR_USER_QUOTA_REACHED","PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED","PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED_UPGRADEABLE","PUBLIC_ERROR_WORKSPACE_ACCOUNT_QUOTA_REACHED"]);

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
  const data = rpcData(raw, "as29s");
  // ponytail: observed positional RPC schema; fail closed on identity/schema changes.
  if (data[0] !== assetId) throw new Error("Flow returned a different asset");
  const value: unknown = data?.[7]?.[0]?.[8];
  if (typeof value !== "string") throw new Error("Flow original video unavailable");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "flow-content.google") throw new Error("Flow media host changed");
  return url.href;
}

function rpcData(raw: string, rpc: string): any {
  const rows: unknown[][] = raw.split("\n").flatMap(line => {
    try { const value = JSON.parse(line); return Array.isArray(value) ? value.filter(Array.isArray) : []; } catch { return []; }
  });
  const matches = rows.filter(row => Array.isArray(row) && row[0] === "wrb.fr" && row[1] === rpc);
  if (matches.length !== 1 || typeof matches[0]![2] !== "string") throw new Error("Flow asset response changed");
  return JSON.parse(matches[0]![2] as string);
}

async function readRpc(request: APIRequestContext, projectUrl: string, rpc: "as29s" | "mrlkwd" | "GN0Bre" | "nzlxg", args: unknown[]): Promise<string> {
  const project = new URL(projectUrl);
  const root = project.pathname.match(/^\/project\/([0-9a-f-]{36})(?:\/|$)/);
  if (project.protocol !== "https:" || project.hostname !== "flow.google.com" || !root || !UUID.test(root[1]!)) throw new Error("Invalid Flow project");
  project.pathname = `/project/${root[1]}`; project.search = ""; project.hash = "";
  const bootstrap = await request.get(project.href, { timeout: 15000 });
  let fields: Record<string, string>;
  try {
    if (!bootstrap.ok()) throw new Error("Flow HTTP session unavailable");
    fields = bootstrapFields(await bootstrap.text());
  } finally { await bootstrap.dispose(); }
  const endpoint = new URL("https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute");
  endpoint.search = new URLSearchParams({ rpcids: rpc, "source-path": project.pathname, bl: fields.cfb2h!, "f.sid": fields.FdrFJe!, hl: "en", rt: "c" }).toString();
  const body = new URLSearchParams({ "f.req": JSON.stringify([[[rpc, JSON.stringify(args), null, "generic"]]]), at: fields.SNlM0e! });
  const reply = await request.post(endpoint.href, { data: body.toString(), headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, timeout: 15000 });
  try {
    if (!reply.ok()) throw new Error("Flow asset read failed");
    return await reply.text();
  } finally { await reply.dispose(); }
}

export function backendCreditBalance(data: unknown): number | null {
  // ponytail: observed GetCredits fields must agree; unknown layouts use UI fallback.
  return Array.isArray(data) && Number.isSafeInteger(data[0]) && data[0] >= 0 && data[0] === data[5] ? data[0] : null;
}

export async function readBackendCredits(request: APIRequestContext, projectUrl: string): Promise<number | null> {
  return backendCreditBalance(rpcData(await readRpc(request,projectUrl,"nzlxg",[]),"nzlxg"));
}

/** Only structured video-tool results in a uniquely matching prompt turn count. */
export function conversationQuotaFailure(data: unknown, prompt: string): { matches: number; code: string | null } {
  if (!Array.isArray(data) || !Array.isArray(data[1])) throw new Error("Flow conversation schema changed");
  const turns = data[1].filter((turn: any) => turn?.[0]?.[0]?.[0]?.[0]?.[0] === `Create exactly one video: ${prompt}`);
  if (turns.length !== 1) return { matches: turns.length, code: null };
  const tools = turns[0]?.[1]?.flatMap((entry: any) => Array.isArray(entry?.[1]) ? entry[1].flatMap((call: any) => call?.[4]?.[1] === "generate_video_from_text" ? [call[4]] : []) : []) ?? [];
  if (tools.length !== 1) return { matches: 1, code: null };
  const pairs = tools[0]?.[2]?.[0];
  if (!Array.isArray(pairs)) return { matches: 1, code: null };
  const statuses = pairs.filter((pair: any) => pair?.[0] === "status");
  const codes = pairs.filter((pair: any) => pair?.[0] === "error_code");
  const candidate = codes[0]?.[1]?.[2];
  const code = statuses.length === 1 && statuses[0]?.[1]?.[2] === "error" && codes.length === 1 && typeof candidate === "string" && QUOTA_CODES.has(candidate) ? candidate : null;
  return { matches: 1, code };
}

/** Historical task read, no submission and no replay of captured requests. */
async function readConversations(request: APIRequestContext, projectUrl: string): Promise<Array<{id:string;data:any}>> {
  const projectId = new URL(projectUrl).pathname.split("/")[2]!;
  const listing = rpcData(await readRpc(request,projectUrl,"mrlkwd",[projectId]),"mrlkwd");
  if (!Array.isArray(listing?.[0]) || listing[0].length > 20) throw new Error("Unsupported Flow conversation listing");
  const ids: string[] = listing[0].map((entry: any) => entry?.[0]);
  if (ids.some(id => typeof id !== "string" || !UUID.test(id)) || new Set(ids).size !== ids.length) throw new Error("Invalid Flow conversation identity");
  const result: Array<{id:string;data:any}> = [];
  for (const id of ids) {
    const data = rpcData(await readRpc(request,projectUrl,"GN0Bre",[id]),"GN0Bre");
    if (data?.[0]?.[0] !== id || !Array.isArray(data[1])) throw new Error("Flow returned a different conversation or schema");
    result.push({id,data});
  }
  return result;
}

export async function readConversationBaseline(request: APIRequestContext, projectUrl: string): Promise<Record<string,number>> {
  return Object.fromEntries((await readConversations(request,projectUrl)).map(({id,data})=>[id,data[1].length]));
}

export async function readJobQuotaFailure(request: APIRequestContext, job: FlowJob): Promise<{code:string;conversationId:string} | null> {
  if (job.mediaType !== "video" || job.outputs !== 1 || !job.flowProjectUrl || !job.backendConversationBaseline) return null;
  let matches = 0; let found: {code:string;conversationId:string} | null = null;
  // ponytail: bounded sequential private-schema reads; replace with documented task API when available.
  for (const {id,data} of await readConversations(request,job.flowProjectUrl)) {
    const count = job.backendConversationBaseline?.[id] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0 || count > data[1].length) throw new Error("Flow conversation history changed");
    const result = conversationQuotaFailure([data[0],data[1].slice(count)],job.prompt);
    matches += result.matches;
    if (result.code) found = {code:result.code,conversationId:id};
  }
  return matches === 1 ? found : null;
}

/** Read-only HTTP path. No browser navigation, generation or persisted tokens. */
export async function readOriginalVideo(request: APIRequestContext, job: FlowJob): Promise<Buffer | null> {
  const assetId = trackedVideoId(job);
  if (!assetId || !job.flowProjectUrl) return null;
  const mediaUrl = originalVideoUrl(await readRpc(request,job.flowProjectUrl,"as29s",[assetId]), assetId);
  const media = await request.get(mediaUrl, { timeout: 120000 });
  try {
    if (!media.ok() || !media.headers()["content-type"]?.toLowerCase().startsWith("video/")) throw new Error("Flow original is not a video");
    const bytes = await media.body();
    if (!bytes.length) throw new Error("Flow original is empty");
    return bytes;
  } finally { await media.dispose(); }
}
