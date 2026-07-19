#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserManager } from "./browser-manager.js";
import { CookieBridge } from "./cookie-bridge.js";
import { errorText, FlowError } from "./errors.js";
import { FlowAdapter } from "./flow-adapter.js";
import { assertExistingFiles, requireAbsoluteDirectory } from "./paths.js";
import { FlowStore } from "./store.js";
import type { FlowJob, GenerationRequest, UiCapabilities } from "./types.js";

const store = new FlowStore();
await store.initialize();
const browsers = new BrowserManager(store);
const cookieBridge = new CookieBridge();
await cookieBridge.start();
const flow = new FlowAdapter(store, browsers, cookieBridge);

const server = new McpServer({
  name: "flow-mcp",
  version: "0.1.0",
  description: "Automates Google Flow through user-owned, persistent Chromium sessions and saves generated media locally.",
});

function ok(value: string | FlowJob | UiCapabilities | unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function failed(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: errorText(error) }], isError: true };
}

const accountId = z
  .string()
  .min(1)
  .max(48)
  .describe("Local account profile ID such as 'personal' or 'studio'. Each managed ID has an isolated persistent Chromium profile.");
const upscale = z
  .string()
  .min(2)
  .max(80)
  .describe("Exact normalized upscale ID returned by flow_inspect_account (for example 1080p, 2x, or 4k), none, or highest_available. Unsupported and unavailable choices fail explicitly.");
const referenceFiles = z
  .array(z.string())
  .default([])
  .describe("Absolute paths to optional local images or videos to attach as Flow references/ingredients/frames.");
const outputDirectory = z
  .string()
  .describe("Absolute directory where downloads and .flow.json manifests are saved, e.g. C:\\project\\public\\generated\\flow.");
const timeoutSeconds = z
  .number()
  .int()
  .min(15)
  .max(900)
  .default(600)
  .describe("Maximum seconds to wait for this generation or upscale. A timeout leaves a persistent job that can be polled.");
const confirmCreditSpend = z
  .literal(true)
  .describe("Must be true. Confirms the user explicitly authorized this operation to consume Google Flow/AI credits.");

server.registerTool(
  "flow_list_accounts",
  {
    title: "List Google Flow Accounts",
    description: "Lists locally configured Google Flow account profiles and the default account. This is read-only and never opens Chrome or contacts Google.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      return ok(await store.listAccounts());
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_login_bridge_status",
  {
    title: "Check Flow Login Bridge",
    description: "Reports whether the localhost Flow Login Bridge is running and waiting for the Chromium extension. This read-only diagnostic never reads cookies, opens a browser, contacts Google, or changes account state.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      return ok(cookieBridge.status());
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_connect_account",
  {
    title: "Connect a Google Flow Account",
    description: "Connects Google Flow using accounts already signed into the user's normal Chromium profile. The user clicks Connect Flow in the bridge extension; session cookies move only over localhost into an isolated Flow session, then Google shows the existing-account chooser. No email, password, 2FA, cookie JSON, browser restart, debug flag, or main-browser tab management is required. Call again to connect another existing Google account.",
    inputSchema: {
      accountId: accountId.optional().describe("Optional local ID. Omit for the simplest setup; a safe ID is created automatically."),
      label: z.string().max(100).optional().describe("Optional local label. Omit to reuse the selected normal browser profile's name."),
      browserMode: z.enum(["extension", "attach_cdp"]).default("extension").describe("Use extension for the simple no-password connection from normal Chromium. attach_cdp is an advanced troubleshooting mode."),
      cdpUrl: z.string().url().optional().describe("Required for attach_cdp. Localhost CDP URL such as http://127.0.0.1:9222. Remote hosts are rejected."),
      chooseGoogleAccount: z.boolean().default(true).describe("Shows Google's chooser populated with accounts already signed into the copied browser session. No credentials are requested. Set false to reuse the browser profile's currently active Google account immediately."),
      waitForLoginSeconds: z.number().int().min(0).max(900).default(300).describe("How long to watch for the existing-account click and Flow readiness. No terminal confirmation is needed."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ accountId: id, label, browserMode, cdpUrl, chooseGoogleAccount, waitForLoginSeconds }) => {
    try {
      if (browserMode === "attach_cdp" && !cdpUrl) {
        throw new FlowError("validation_error", "cdpUrl is required when browserMode is attach_cdp.");
      }
      return ok(await flow.connectAccount(id, label, {
        browserMode,
        chooseGoogleAccount,
        waitForLoginSeconds,
        ...(cdpUrl ? { cdpUrl } : {}),
      }));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_inspect_account",
  {
    title: "Inspect Google Flow Account UI",
    description: "Opens the specified Flow account without generating media and returns a language-independent live capability map: exact image/video model IDs and labels, selected models, ratios, output counts, selectable durations, available and unavailable upscale/download choices from existing assets, UI language, login state, URL, and a diagnostic screenshot. Call this before generation; empty option arrays mean the current Flow UI does not expose that setting.",
    inputSchema: { accountId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ accountId: id }) => {
    try {
      return ok(await flow.inspect(id));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_generate_video",
  {
    title: "Generate and Download a Google Flow Video",
    description: "Uses the selected signed-in Google Flow account to configure a text/reference-to-video generation, wait for the generated clip, optionally choose an exact live upscale ID or highest_available, and download the result plus a manifest. This consumes Flow/AI credits and must only be called after explicit user authorization.",
    inputSchema: {
      accountId,
      prompt: z.string().min(3).max(20_000).describe("Video prompt in any language, describing subject, action, setting, camera, lighting, style, and audio as desired."),
      flowProject: z.string().max(200).optional().describe("Existing Flow project name to open. If omitted, the current project is reused or a new project is created."),
      model: z.string().default("ui-default").describe("Normalized video model ID returned by flow_inspect_account, e.g. omni-flash, veo-3-1-lite, veo-3-1-fast, or veo-3-1-quality. Exact visible labels are also accepted. Use ui-default to keep the selected model."),
      aspectRatio: z.string().regex(/^(?:ui-default|\d+:\d+)$/).default("ui-default").describe("Exact video aspect ratio returned by flow_inspect_account, or ui-default."),
      durationSeconds: z.number().int().min(1).max(120).optional().describe("Requested clip length only when flow_inspect_account reports that exact value in visibleDurations. Omit when the current Flow Agent UI exposes no duration control."),
      outputs: z.number().int().min(1).max(4).default(1).describe("Number of generated video outputs requested from Flow. Credits are typically charged per generation."),
      referenceFiles,
      upscale: upscale.default("none"),
      outputDirectory,
      fileName: z.string().max(120).optional().describe("Optional safe file stem. The job ID and downloaded extension are added automatically."),
      download: z.boolean().default(true).describe("When true, download ready outputs immediately. When false, leave them in Flow and return the job."),
      timeoutSeconds,
      confirmCreditSpend,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async (input) => {
    try {
      const request: GenerationRequest = {
        accountId: input.accountId,
        mediaType: "video",
        prompt: input.prompt,
        outputs: input.outputs,
        referenceFiles: assertExistingFiles(input.referenceFiles),
        upscale: input.upscale,
        outputDirectory: requireAbsoluteDirectory(input.outputDirectory),
        download: input.download,
        timeoutSeconds: input.timeoutSeconds,
        ...(input.flowProject ? { flowProject: input.flowProject } : {}),
        ...(input.model !== "ui-default" ? { model: input.model } : {}),
        ...(input.aspectRatio !== "ui-default" ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}),
        ...(input.fileName ? { fileName: input.fileName } : {}),
      };
      return ok(await flow.generate(request));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_generate_image",
  {
    title: "Generate and Download a Google Flow Image",
    description: "Uses the selected signed-in Google Flow account to configure an image generation or edit with optional references, waits for the result, and downloads it with a reproducibility manifest. It may consume Flow/AI usage and must only be called after explicit user authorization.",
    inputSchema: {
      accountId,
      prompt: z.string().min(3).max(20_000).describe("Detailed image prompt or edit instruction in any language."),
      flowProject: z.string().max(200).optional().describe("Existing Flow project name to open. If omitted, the current project is reused or a new project is created."),
      model: z.string().default("ui-default").describe("Normalized image model ID returned by flow_inspect_account, e.g. nano-banana-pro, nano-banana-2, or nano-banana-2-lite. Exact visible labels are also accepted. Use ui-default to keep the selected model."),
      aspectRatio: z.string().regex(/^(?:ui-default|\d+:\d+)$/).default("ui-default").describe("Exact image aspect ratio returned by flow_inspect_account, or ui-default."),
      outputs: z.number().int().min(1).max(4).default(1).describe("Number of image outputs requested."),
      referenceFiles,
      outputDirectory,
      fileName: z.string().max(120).optional().describe("Optional safe file stem. The job ID and downloaded extension are added automatically."),
      download: z.boolean().default(true).describe("Download ready outputs when true; otherwise return the Flow job without downloading."),
      timeoutSeconds,
      confirmCreditSpend,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async (input) => {
    try {
      const request: GenerationRequest = {
        accountId: input.accountId,
        mediaType: "image",
        prompt: input.prompt,
        outputs: input.outputs,
        referenceFiles: assertExistingFiles(input.referenceFiles),
        upscale: "none",
        outputDirectory: requireAbsoluteDirectory(input.outputDirectory),
        download: input.download,
        timeoutSeconds: input.timeoutSeconds,
        ...(input.flowProject ? { flowProject: input.flowProject } : {}),
        ...(input.model !== "ui-default" ? { model: input.model } : {}),
        ...(input.aspectRatio !== "ui-default" ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.fileName ? { fileName: input.fileName } : {}),
      };
      return ok(await flow.generate(request));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_job_status",
  {
    title: "Check a Google Flow Job",
    description: "Loads a persistent Flow job, briefly checks the corresponding account/project for a finished asset, and returns its current state, diagnostics, chosen upscale, downloads, and media metadata. This does not spend credits.",
    inputSchema: {
      jobId: z.string().uuid().describe("UUID returned by flow_generate_video or flow_generate_image."),
      waitSeconds: z.number().int().min(0).max(60).default(10).describe("Seconds to poll before returning; use 0 for an immediate snapshot."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ jobId, waitSeconds }) => {
    try {
      return ok(waitSeconds === 0 ? await store.getJob(jobId) : await flow.refreshJob(jobId, waitSeconds));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_upscale_video",
  {
    title: "Upscale an Existing Google Flow Video Job",
    description: "Opens the video asset associated with an existing Flow job, discovers live factor/resolution choices, rejects unavailable/upgrade-only options, selects an exact ID or the highest available option, and captures either the upscaled download or new asset. This can consume Flow/AI credits and requires explicit authorization.",
    inputSchema: {
      jobId: z.string().uuid().describe("UUID of an existing video generation job."),
      factor: z.string().min(2).max(80).refine((value) => value !== "none", "Use a live upscale ID or highest_available, not none.").describe("Exact available upscale ID returned by flow_inspect_account, such as 1080p or 2x, or highest_available. Missing/unavailable options fail explicitly."),
      timeoutSeconds,
      confirmCreditSpend,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ jobId, factor, timeoutSeconds: timeout }) => {
    try {
      return ok(await flow.upscaleJob(jobId, factor, timeout));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_download_job",
  {
    title: "Download an Existing Google Flow Job",
    description: "Downloads the newest visible asset or outputs associated with an existing Flow job into its configured absolute output directory, validates files with ffprobe when installed, writes .flow.json manifests, and returns local paths. This does not start a new generation.",
    inputSchema: { jobId: z.string().uuid().describe("UUID of a ready Flow video or image job.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ jobId }) => {
    try {
      return ok(await flow.downloadJob(jobId));
    } catch (error) {
      return failed(error);
    }
  },
);

const shutdown = async (): Promise<void> => {
  await browsers.closeAll();
  await cookieBridge.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[flow-mcp] ready; data directory: ${store.dataDir}`);
