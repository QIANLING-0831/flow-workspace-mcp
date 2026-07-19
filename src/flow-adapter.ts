import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { BrowserManager } from "./browser-manager.js";
import { FlowError } from "./errors.js";
import { probeMedia } from "./media.js";
import { safeFileStem } from "./paths.js";
import { FlowStore } from "./store.js";
import { chooseUpscaleOption, extractUpscaleLabels } from "./upscale.js";
import {
  FLOW_URL,
  type FlowJob,
  type GenerationRequest,
  type MediaType,
  type UiCapabilities,
  type UpscaleFactor,
} from "./types.js";

const LOGIN_TEXT = /sign in|choose an account|use your google account/i;
const FAILURE_TEXT = /generation failed|couldn't generate|unable to generate|not enough (?:ai )?credits|blocked by policy|try again/i;

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function firstVisible(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 20); index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function visibleText(locator: Locator): Promise<string[]> {
  const values: string[] = [];
  const count = Math.min(await locator.count().catch(() => 0), 100);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      const text = (await candidate.innerText().catch(() => "")).trim();
      if (text) values.push(text);
    }
  }
  return unique(values);
}

export class FlowAdapter {
  constructor(
    private readonly store: FlowStore,
    private readonly browsers: BrowserManager,
  ) {}

  async connectAccount(
    accountId: string,
    label?: string,
    options: { browserMode?: "managed" | "attach_cdp"; cdpUrl?: string; waitForLoginSeconds?: number } = {},
  ): Promise<string> {
    const account = await this.store.ensureAccount(accountId, label, options);
    return this.browsers.runExclusive(account.id, async () => {
      await this.browsers.reset(account.id);
      const page = await this.browsers.pageFor(account.id);
      await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
      await this.store.touchAccount(account.id);
      const waitSeconds = options.waitForLoginSeconds ?? 600;
      const deadline = Date.now() + waitSeconds * 1_000;
      let signedIn = await this.isSignedIn(page);
      while (!signedIn && Date.now() < deadline) {
        await page.waitForTimeout(1_000);
        signedIn = await this.isSignedIn(page);
      }
      if (!signedIn && waitSeconds > 0) {
        throw new FlowError(
          "login_required",
          `Google Flow connection for '${account.id}' was not completed within ${waitSeconds} seconds. The browser remains available in the running MCP session.`,
          ["Finish signing in, then call flow_inspect_account or flow_connect_account again."],
        );
      }
      return [
        `${signedIn ? "Connected" : "Opened"} Google Flow account '${account.id}' (${account.label}).`,
        account.browserMode === "attach_cdp"
          ? `Attached to Chromium CDP: ${account.cdpUrl}`
          : `Managed Chromium profile: ${this.store.profileDir(account.id)}`,
        `Current URL: ${page.url()}`,
        signedIn
          ? "The session is signed in and ready. No terminal confirmation is required."
          : "The Chromium window is open for troubleshooting; call this tool again after sign-in.",
      ].join("\n");
    });
  }

  async inspect(accountId: string): Promise<UiCapabilities> {
    const account = await this.store.requireAccount(accountId);
    return this.browsers.runExclusive(account.id, async () => {
      const page = await this.readyPage(account.id, false);
      const screenshot = this.store.diagnosticPath(`inspect-${account.id}`);
      await page.screenshot({ path: screenshot, fullPage: false });
      const body = await page.locator("body").innerText().catch(() => "");
      const settings = await firstVisible([
        page.getByRole("button", { name: /settings|options|generation settings/i }).last(),
        page.getByRole("button", { name: /nano banana|veo|omni/i }).last(),
      ]);
      if (settings) {
        await settings.click().catch(() => undefined);
        await page.waitForTimeout(250);
      }
      let controlText = await visibleText(page.locator('button, [role="button"], [role="option"], [role="menuitem"]'));
      await page.keyboard.press("Escape").catch(() => undefined);

      const videos = this.mediaLocator(page, "video");
      if ((await videos.count()) > 0) {
        await this.openAssetMenu(page, videos.last()).catch(() => undefined);
        const menuText = await visibleText(page.locator('[role="menuitem"], [role="option"], button'));
        const genericUpscale = await firstVisible([
          page.getByRole("menuitem", { name: /^upscale$/i }),
          page.getByRole("button", { name: /^upscale$/i }),
        ]);
        if (!extractUpscaleLabels(menuText).length && genericUpscale) {
          await genericUpscale.click().catch(() => undefined);
          await page.waitForTimeout(250);
        }
        controlText = controlText.concat(
          await visibleText(page.locator('[role="menuitem"], [role="option"], button')),
        );
        await page.keyboard.press("Escape").catch(() => undefined);
      }
      return {
        url: page.url(),
        signedIn: await this.isSignedIn(page),
        visibleModels: unique(controlText.filter((text) => /veo|omni|nano banana|imagen/i.test(text))),
        visibleAspectRatios: unique(controlText.flatMap((text) => text.match(/\b(?:16:9|9:16|1:1|4:3|3:4)\b/g) ?? [])),
        visibleDurations: unique(controlText.flatMap((text) => text.match(/\b(?:4|6|8|10)\s*s(?:ec(?:ond)?s?)?\b/gi) ?? []))
          .map((text) => Number.parseInt(text, 10))
          .filter(Number.isFinite),
        availableUpscales: extractUpscaleLabels(controlText),
        pageTextExcerpt: body.slice(0, 2_000),
        screenshot,
      };
    });
  }

  async generate(request: GenerationRequest): Promise<FlowJob> {
    const account = await this.store.requireAccount(request.accountId);
    const job = await this.store.createJob({ ...request, accountId: account.id });
    return this.browsers.runExclusive(account.id, async () => {
      let page: Page | undefined;
      try {
        page = await this.readyPage(account.id, true);
        await this.store.updateJob(job, "configuring", { flowProjectUrl: page.url() });
        await this.openProject(page, request.flowProject);
        await this.configureGeneration(page, request);
        await this.attachReferences(page, request.referenceFiles);
        await this.fillPrompt(page, request.prompt);

        const baseline = await this.mediaLocator(page, request.mediaType).count();
        await this.store.updateJob(job, "submitted", {
          baselineMediaCount: baseline,
          flowProjectUrl: page.url(),
        });
        await this.clickGenerate(page);
        await this.store.updateJob(job, "processing");

        const completed = await this.waitForNewMedia(page, request.mediaType, baseline, request.timeoutSeconds);
        if (!completed) return job;

        if (request.mediaType === "video" && request.upscale !== "none") {
          await this.store.updateJob(job, "upscaling");
          const upscaled = await this.upscaleLatest(page, job, request.upscale, request.timeoutSeconds);
          if (!upscaled) return job;
        }

        if (request.download) {
          await this.store.updateJob(job, "downloading");
          await this.downloadLatest(page, job, request.outputs);
        } else {
          await this.store.updateJob(job, "completed");
        }
        return job;
      } catch (error) {
        const screenshot = page ? await this.captureDiagnostic(page, `job-${job.id}`) : undefined;
        const message = error instanceof Error ? error.message : String(error);
        const status = error instanceof FlowError && error.code === "login_required" ? "needs_attention" : "failed";
        await this.store.updateJob(job, status, {
          error: message,
          ...(screenshot ? { diagnosticScreenshot: screenshot } : {}),
        });
        throw error;
      }
    });
  }

  async refreshJob(jobId: string, timeoutSeconds = 15): Promise<FlowJob> {
    const job = await this.store.getJob(jobId);
    if (["completed", "failed", "needs_attention"].includes(job.status)) return job;
    return this.browsers.runExclusive(job.accountId, async () => {
      const page = await this.readyPage(job.accountId, true, job.flowProjectUrl);
      const baseline = job.baselineMediaCount ?? 0;
      const ready = await this.waitForNewMedia(page, job.mediaType, baseline, timeoutSeconds);
      if (ready && job.status === "processing") await this.store.updateJob(job, "ready");
      return job;
    });
  }

  async upscaleJob(jobId: string, factor: Exclude<UpscaleFactor, "none">, timeoutSeconds: number): Promise<FlowJob> {
    const job = await this.store.getJob(jobId);
    if (job.mediaType !== "video") throw new FlowError("validation_error", "Only video jobs can be upscaled.");
    return this.browsers.runExclusive(job.accountId, async () => {
      const page = await this.readyPage(job.accountId, true, job.flowProjectUrl);
      await this.store.updateJob(job, "upscaling", { upscale: factor });
      const ready = await this.upscaleLatest(page, job, factor, timeoutSeconds);
      if (ready) await this.store.updateJob(job, "ready");
      return job;
    });
  }

  async downloadJob(jobId: string): Promise<FlowJob> {
    const job = await this.store.getJob(jobId);
    return this.browsers.runExclusive(job.accountId, async () => {
      const page = await this.readyPage(job.accountId, true, job.flowProjectUrl);
      await this.store.updateJob(job, "downloading");
      await this.downloadLatest(page, job, job.outputs);
      return job;
    });
  }

  private async readyPage(accountId: string, requireLogin: boolean, url?: string): Promise<Page> {
    const page = await this.browsers.pageFor(accountId);
    if (!page.url().startsWith("https://labs.google/")) {
      await page.goto(url || FLOW_URL, { waitUntil: "domcontentloaded" });
    } else if (url && page.url() !== url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    await page.waitForTimeout(1_000);
    if (requireLogin && !(await this.isSignedIn(page))) {
      throw new FlowError(
        "login_required",
        `Google Flow account '${accountId}' is not signed in.`,
        [`Call flow_connect_account with accountId '${accountId}'; it will detect completion automatically.`],
      );
    }
    return page;
  }

  private async isSignedIn(page: Page): Promise<boolean> {
    if (/accounts\.google\.com/i.test(page.url())) return false;
    const signIn = await firstVisible([
      page.getByRole("button", { name: /^sign in$/i }),
      page.getByRole("link", { name: /^sign in$/i }),
    ]);
    if (signIn) return false;
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 8_000);
    if (LOGIN_TEXT.test(body)) return false;
    if (await firstVisible([this.promptLocator(page)])) return true;
    return /new project|my projects|credits|scenebuilder/i.test(body);
  }

  private promptLocator(page: Page): Locator {
    return page.locator([
      'textarea[placeholder*="prompt" i]',
      'textarea[placeholder*="describe" i]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][data-placeholder*="prompt" i]',
      "textarea",
    ].join(", "));
  }

  private async openProject(page: Page, projectName?: string): Promise<void> {
    if (await firstVisible([this.promptLocator(page)])) return;

    if (projectName) {
      const project = await firstVisible([
        page.getByRole("link", { name: new RegExp(projectName, "i") }),
        page.getByRole("button", { name: new RegExp(projectName, "i") }),
        page.getByText(projectName, { exact: false }),
      ]);
      if (project) {
        await project.click();
        await page.waitForTimeout(1_500);
        if (await firstVisible([this.promptLocator(page)])) return;
      }
    }

    const create = await firstVisible([
      page.getByRole("button", { name: /new project|create project|start.*project/i }),
      page.getByText(/\+\s*new project|new project/i),
    ]);
    if (!create) {
      throw new FlowError(
        "ui_changed",
        "Could not find a Flow project or the New project control.",
        ["Open the account with flow_connect_account, create or open a project, then retry."],
      );
    }
    await create.click();
    await page.waitForTimeout(2_000);
    if (!(await firstVisible([this.promptLocator(page)]))) {
      throw new FlowError("ui_changed", "A Flow project opened, but the prompt editor could not be located.");
    }
  }

  private async configureGeneration(page: Page, request: GenerationRequest): Promise<void> {
    const settings = await firstVisible([
      page.getByRole("button", { name: /settings|options|generation settings/i }).last(),
      page.getByRole("button", { name: /nano banana|veo|omni|image|video/i }).last(),
    ]);
    if (!settings) {
      throw new FlowError("ui_changed", "Could not find Flow's generation settings/model control.");
    }
    await settings.click();
    await page.waitForTimeout(300);

    await this.clickChoice(page, request.mediaType === "video" ? /^video$/i : /^image$/i, "media type");
    if (request.model && request.model !== "ui-default") {
      await this.openAndChoose(page, /model/i, new RegExp(this.escapeRegex(request.model), "i"), "model");
    }
    if (request.aspectRatio && request.aspectRatio !== "ui-default") {
      await this.openAndChoose(
        page,
        /aspect ratio|orientation/i,
        new RegExp(`^${this.escapeRegex(request.aspectRatio)}$`, "i"),
        "aspect ratio",
      );
    }
    if (request.mediaType === "video" && request.durationSeconds) {
      await this.openAndChoose(
        page,
        /duration|length/i,
        new RegExp(`^${request.durationSeconds}\\s*(?:s|sec|seconds?)$`, "i"),
        "duration",
      );
    }
    await this.openAndChoose(
      page,
      /outputs?|variations?/i,
      new RegExp(`^${request.outputs}(?:\\s+outputs?)?$`, "i"),
      "output count",
    );
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  private async openAndChoose(page: Page, controlName: RegExp, choice: RegExp, label: string): Promise<void> {
    let selected = await this.tryClickChoice(page, choice);
    if (selected) return;
    const control = await firstVisible([
      page.getByRole("button", { name: controlName }),
      page.getByText(controlName),
    ]);
    if (control) {
      await control.click();
      await page.waitForTimeout(250);
      selected = await this.tryClickChoice(page, choice);
    }
    if (!selected) {
      throw new FlowError(
        "unsupported_option",
        `The requested ${label} was not offered by the current Flow UI for this account or generation mode.`,
        ["Call flow_inspect_account to see visible controls, or use ui-default where supported."],
      );
    }
  }

  private async clickChoice(page: Page, choice: RegExp, label: string): Promise<void> {
    if (!(await this.tryClickChoice(page, choice))) {
      throw new FlowError("ui_changed", `Could not select Flow ${label}.`);
    }
  }

  private async tryClickChoice(page: Page, choice: RegExp): Promise<boolean> {
    const candidate = await firstVisible([
      page.getByRole("option", { name: choice }),
      page.getByRole("menuitem", { name: choice }),
      page.getByRole("button", { name: choice }),
      page.getByText(choice, { exact: true }),
    ]);
    if (!candidate) return false;
    await candidate.click();
    await page.waitForTimeout(200);
    return true;
  }

  private async attachReferences(page: Page, files: string[]): Promise<void> {
    if (!files.length) return;
    for (const file of files) await access(file);
    let input = page.locator('input[type="file"]');
    if ((await input.count()) === 0) {
      const add = await firstVisible([
        page.getByRole("button", { name: /add.*(?:image|media|ingredient|reference|frame)|upload/i }),
        page.getByText(/add.*(?:image|media|ingredient|reference|frame)|upload/i),
      ]);
      if (add) await add.click();
      input = page.locator('input[type="file"]');
    }
    if ((await input.count()) === 0) {
      throw new FlowError("ui_changed", "Reference files were supplied, but Flow's file input could not be found.");
    }
    await input.last().setInputFiles(files);
    await page.waitForTimeout(1_000);
  }

  private async fillPrompt(page: Page, prompt: string): Promise<void> {
    const editor = await firstVisible([this.promptLocator(page)]);
    if (!editor) throw new FlowError("ui_changed", "Could not locate Flow's prompt editor.");
    const tag = await editor.evaluate((element) => element.tagName.toLowerCase());
    if (tag === "textarea" || tag === "input") await editor.fill(prompt);
    else {
      await editor.click();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.insertText(prompt);
    }
  }

  private async clickGenerate(page: Page): Promise<void> {
    const button = await firstVisible([
      page.getByRole("button", { name: /^generate(?: image| video)?$/i }).last(),
      page.getByText(/^generate(?: image| video)?$/i),
    ]);
    if (!button) throw new FlowError("ui_changed", "Could not find Flow's Generate control.");
    if (!(await button.isEnabled().catch(() => true))) {
      throw new FlowError("generation_failed", "Flow's Generate control is disabled after configuring the request.");
    }
    await button.click();
  }

  private mediaLocator(page: Page, type: MediaType): Locator {
    if (type === "video") return page.locator("video");
    return page.locator('img[src^="blob:"], img[src*="googleusercontent"], img[src*="ggpht"]');
  }

  private async waitForNewMedia(page: Page, type: MediaType, baseline: number, timeoutSeconds: number): Promise<boolean> {
    const deadline = Date.now() + timeoutSeconds * 1_000;
    while (Date.now() < deadline) {
      const body = (await page.locator("body").innerText().catch(() => "")).slice(-10_000);
      if (FAILURE_TEXT.test(body)) {
        throw new FlowError("generation_failed", "Flow reported that the generation failed or requires attention.");
      }
      const media = this.mediaLocator(page, type);
      const count = await media.count();
      if (count > baseline) {
        const ready = await media.last().evaluate((element) => {
          if (element instanceof HTMLVideoElement) return element.readyState >= 2 && element.duration > 0;
          if (element instanceof HTMLImageElement) return element.complete && element.naturalWidth >= 256;
          return false;
        }).catch(() => false);
        if (ready) return true;
      }
      await page.waitForTimeout(2_000);
    }
    return false;
  }

  private async openAssetMenu(page: Page, media: Locator): Promise<void> {
    await media.scrollIntoViewIfNeeded();
    await media.click({ button: "right" });
    await page.waitForTimeout(300);
    const menuVisible = await firstVisible([
      page.getByRole("menuitem", { name: /download|upscale/i }),
      page.getByText(/download|upscale/i),
    ]);
    if (menuVisible) return;

    await page.keyboard.press("Escape").catch(() => undefined);
    await media.hover();
    const more = await firstVisible([
      page.getByRole("button", { name: /more|menu|options/i }).last(),
      page.locator('button[aria-label*="more" i], button[aria-label*="menu" i]').last(),
    ]);
    if (!more) throw new FlowError("ui_changed", "Could not open the generated asset's context menu.");
    await more.click();
    await page.waitForTimeout(300);
  }

  private async upscaleLatest(
    page: Page,
    job: FlowJob,
    requested: Exclude<UpscaleFactor, "none">,
    timeoutSeconds: number,
  ): Promise<boolean> {
    const media = this.mediaLocator(page, "video");
    const before = await media.count();
    if (!before) throw new FlowError("unsupported_option", "No generated video is visible to upscale.");
    await this.openAssetMenu(page, media.last());

    let controls = await visibleText(page.locator('[role="menuitem"], [role="option"], button'));
    let options = extractUpscaleLabels(controls);
    const genericUpscale = await firstVisible([
      page.getByRole("menuitem", { name: /^upscale$/i }),
      page.getByRole("button", { name: /^upscale$/i }),
      page.getByText(/^upscale$/i),
    ]);
    if (!options.length && genericUpscale) {
      await genericUpscale.click();
      await page.waitForTimeout(300);
      controls = await visibleText(page.locator('[role="menuitem"], [role="option"], button'));
      options = extractUpscaleLabels(controls);
    }

    const chosen = chooseUpscaleOption(options, requested);
    await this.store.updateJob(job, "upscaling", {
      availableUpscales: options,
      chosenUpscale: chosen,
    });
    const choice = await firstVisible([
      page.getByRole("menuitem", { name: new RegExp(this.escapeRegex(chosen), "i") }),
      page.getByRole("option", { name: new RegExp(this.escapeRegex(chosen), "i") }),
      page.getByRole("button", { name: new RegExp(this.escapeRegex(chosen), "i") }),
      page.getByText(new RegExp(this.escapeRegex(chosen), "i")),
    ]);
    if (!choice) throw new FlowError("ui_changed", `Flow offered '${chosen}', but its control disappeared before selection.`);
    await choice.click();

    const ready = await this.waitForNewMedia(page, "video", before, timeoutSeconds);
    if (!ready) {
      await this.store.updateJob(job, "processing");
    }
    return ready;
  }

  private async downloadLatest(page: Page, job: FlowJob, count: number): Promise<void> {
    await mkdir(job.outputDirectory, { recursive: true });
    const media = this.mediaLocator(page, job.mediaType);
    const total = await media.count();
    if (!total) throw new FlowError("download_failed", "No generated asset is visible to download.");
    const assetCount = Math.max(1, Math.min(count, total));
    const downloaded: string[] = [];

    for (let offset = assetCount - 1; offset >= 0; offset -= 1) {
      const target = media.nth(total - 1 - offset);
      await this.openAssetMenu(page, target);
      const downloadPromise = page.waitForEvent("download", { timeout: 20_000 });
      const control = await firstVisible([
        page.getByRole("menuitem", { name: /download/i }),
        page.getByRole("button", { name: /download/i }),
        page.getByText(/^download/i),
      ]);
      if (!control) throw new FlowError("download_failed", "The generated asset menu did not contain Download.");
      await control.click();
      await page.waitForTimeout(300);

      const quality = await firstVisible([
        page.getByRole("menuitem", { name: /original|highest|1080p|video file|png|jpg|jpeg/i }).last(),
        page.getByRole("button", { name: /original|highest|1080p|video file|png|jpg|jpeg/i }).last(),
      ]);
      if (quality) await quality.click().catch(() => undefined);

      let download;
      try {
        download = await downloadPromise;
      } catch {
        throw new FlowError("download_failed", "Flow did not start a browser download after the Download action.");
      }
      const suggested = download.suggestedFilename();
      const extension = path.extname(suggested) || (job.mediaType === "video" ? ".mp4" : ".png");
      const stem = safeFileStem(job.fileName || job.prompt.slice(0, 60));
      const suffix = assetCount > 1 ? `-${assetCount - offset}` : "";
      const destination = path.join(job.outputDirectory, `${stem}-${job.id.slice(0, 8)}${suffix}${extension}`);
      await download.saveAs(destination);
      downloaded.push(destination);
      await page.keyboard.press("Escape").catch(() => undefined);
    }

    const probes = await Promise.all(downloaded.map((file) => probeMedia(file)));
    const completed = await this.store.updateJob(job, "completed", {
      downloadedFiles: downloaded,
      mediaProbe: probes,
    });
    await this.writeManifest(completed);
  }

  private async writeManifest(job: FlowJob): Promise<void> {
    if (!job.downloadedFiles?.length) return;
    const first = job.downloadedFiles[0]!;
    const manifest = `${first.slice(0, first.length - path.extname(first).length)}.flow.json`;
    await writeFile(manifest, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  }

  private async captureDiagnostic(page: Page, prefix: string): Promise<string | undefined> {
    try {
      const file = this.store.diagnosticPath(prefix);
      await page.screenshot({ path: file, fullPage: false });
      return file;
    } catch {
      return undefined;
    }
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
