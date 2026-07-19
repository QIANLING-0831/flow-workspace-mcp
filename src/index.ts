#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserManager } from "./browser-manager.js";
import { errorText, FlowError } from "./errors.js";
import { FlowAdapter } from "./flow-adapter.js";
import { assertExistingFiles, requireAbsoluteDirectory } from "./paths.js";
import { FlowStore } from "./store.js";
import type { FlowJob, GenerationRequest, UiCapabilities } from "./types.js";

const store = new FlowStore();
await store.initialize();
const browsers = new BrowserManager(store);
const flow = new FlowAdapter(store, browsers);

const server = new McpServer({
  name: "flow-mcp",
  version: "0.1.0",
  description: "Automates Google Flow through user-owned, persistent Chrome sessions and saves generated media locally.",
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
  .enum(["none", "1x", "2x", "4x", "highest_available"])
  .describe("Flow asset-menu upscale choice. 'highest_available' discovers the choices shown for this account/video and selects the largest; it never assumes 4x exists.");
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
  "flow_connect_account",
  {
    title: "Connect a Google Flow Account",
    description: "Creates or opens a persistent Chromium profile, navigates to Google Flow, and automatically detects when authentication is complete—no terminal confirmation is needed. It can alternatively attach to an explicitly configured localhost Chromium CDP endpoint to reuse that browser's signed-in session. Credentials and cookies are never requested by the MCP tool.",
    inputSchema: {
      accountId,
      label: z.string().max(100).optional().describe("Human-readable label used only in local metadata, e.g. 'Personal Google Pro'."),
      browserMode: z.enum(["managed", "attach_cdp"]).default("managed").describe("managed launches detected Chromium with an isolated persistent profile; attach_cdp reuses a Chromium instance the user explicitly started with a localhost remote-debugging endpoint."),
      cdpUrl: z.string().url().optional().describe("Required for attach_cdp. Localhost CDP URL such as http://127.0.0.1:9222. Remote hosts are rejected."),
      waitForLoginSeconds: z.number().int().min(0).max(900).default(600).describe("How long to automatically watch for successful Flow login. Use 0 to open/attach and return immediately for troubleshooting."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ accountId: id, label, browserMode, cdpUrl, waitForLoginSeconds }) => {
    try {
      if (browserMode === "attach_cdp" && !cdpUrl) {
        throw new FlowError("validation_error", "cdpUrl is required when browserMode is attach_cdp.");
      }
      return ok(await flow.connectAccount(id, label, {
        browserMode,
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
    description: "Opens the specified Flow account without generating media and reports visible models, ratios, durations, upscale labels, login state, URL, and a diagnostic screenshot. Use before relying on an option whose availability may differ by account or region.",
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
    description: "Uses the selected signed-in Google Flow account to configure a text/reference-to-video generation, wait for the generated clip, optionally choose 1x/2x/4x or the highest upscale actually offered in the asset menu, and download the result plus a manifest. This consumes Flow/AI credits and must only be called after explicit user authorization.",
    inputSchema: {
      accountId,
      prompt: z.string().min(3).max(20_000).describe("Detailed English video prompt describing subject, action, setting, camera, lighting, style, and audio as desired."),
      flowProject: z.string().max(200).optional().describe("Existing Flow project name to open. If omitted, the current project is reused or a new project is created."),
      model: z.string().default("ui-default").describe("Exact model label shown by Flow, such as 'Veo 3.1 - Fast' or 'Gemini Omni Flash'. Use 'ui-default' to keep Flow's current choice."),
      aspectRatio: z.enum(["ui-default", "16:9", "9:16"]).default("ui-default").describe("Video aspect ratio. Use ui-default to keep the account's current setting."),
      durationSeconds: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional().describe("Requested clip length. Flow validates whether the chosen model supports 4, 6, 8, or 10 seconds."),
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
      prompt: z.string().min(3).max(20_000).describe("Detailed image prompt or edit instruction."),
      flowProject: z.string().max(200).optional().describe("Existing Flow project name to open. If omitted, the current project is reused or a new project is created."),
      model: z.string().default("ui-default").describe("Exact image model label shown by Flow, e.g. 'Nano Banana 2'. Use ui-default to keep Flow's choice."),
      aspectRatio: z.enum(["ui-default", "16:9", "9:16", "1:1", "4:3", "3:4"]).default("ui-default").describe("Requested image aspect ratio or ui-default."),
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
    description: "Opens the video asset associated with an existing Flow job, discovers the upscale choices in its context menu, selects 1x/2x/4x or the highest option actually available, and waits for the new asset. This can consume Flow/AI credits and requires explicit authorization.",
    inputSchema: {
      jobId: z.string().uuid().describe("UUID of an existing video generation job."),
      factor: z.enum(["1x", "2x", "4x", "highest_available"]).describe("Requested UI option. Missing options produce an explicit error; they are never silently downgraded."),
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
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[flow-mcp] ready; data directory: ${store.dataDir}`);
