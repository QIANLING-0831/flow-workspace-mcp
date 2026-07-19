import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Download, Locator, Page } from "playwright";
import { BrowserManager } from "./browser-manager.js";
import { cleanCapabilityLabel, normalizeCapabilityId, parseDurationSeconds, parseOutputCount, type CapabilityOption } from "./capabilities.js";
import { CookieBridge } from "./cookie-bridge.js";
import { FlowError } from "./errors.js";
import { probeMedia } from "./media.js";
import { safeFileStem } from "./paths.js";
import { FlowStore } from "./store.js";
import {
  chooseUpscaleOption,
  extractUpscaleOptions,
  normalizeUpscaleId,
  type AssetMenuEntry,
} from "./upscale.js";
import {
  FLOW_URL,
  type FlowJob,
  type GenerationRequest,
  type MediaType,
  type UiCapabilities,
  type UpscaleFactor,
} from "./types.js";

const LOGIN_TEXT = /sign in|choose an account|use your google account/i;
const FAILURE_TEXT = /generation failed|couldn't generate|unable to generate|not enough (?:ai )?credits|blocked by policy|try again|no se (?:ha podido|pudo) generar|error al generar|puntos insuficientes|int[eé]ntalo de nuevo/i;

interface AgentSettingsCapabilities {
  models: { image: CapabilityOption[]; video: CapabilityOption[] };
  ratios: { image: string[]; video: string[] };
  outputs: { image: number[]; video: number[] };
  durationSeconds: number[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
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

async function lastVisible(locator: Locator): Promise<Locator | null> {
  const count = await locator.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
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

async function visibleCount(locator: Locator): Promise<number> {
  let visible = 0;
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) visible += 1;
  }
  return visible;
}

export class FlowAdapter {
  constructor(
    private readonly store: FlowStore,
    private readonly browsers: BrowserManager,
    private readonly cookieBridge: CookieBridge,
  ) {}

  async connectAccount(
    accountId?: string,
    label?: string,
    options: {
      browserMode?: "extension" | "attach_cdp";
      cdpUrl?: string;
      chooseGoogleAccount?: boolean;
      waitForLoginSeconds?: number;
    } = {},
  ): Promise<string> {
    const attached = options.browserMode === "attach_cdp";
    const waitSeconds = options.waitForLoginSeconds ?? 300;
    const transferred = attached ? undefined : await this.cookieBridge.waitForSession(waitSeconds);
    const id = accountId ?? await this.store.availableAccountId(transferred?.profile || "flow-account");
    const account = await this.store.ensureAccount(id, label ?? transferred?.profile, {
      browserMode: attached ? "attach_cdp" : "extension",
      ...(options.cdpUrl ? { cdpUrl: options.cdpUrl } : {}),
    });
    if (!attached) await this.store.setHeadlessAfterLogin(account.id, false);
    return this.browsers.runExclusive(account.id, async () => {
      await this.browsers.reset(account.id);
      const page = transferred
        ? await this.browsers.importCookies(account.id, transferred.cookies)
        : await this.browsers.pageFor(account.id);
      const startUrl = options.chooseGoogleAccount
        // Google rejects labs.google as a direct AccountChooser continuation
        // with HTTP 400. Use the supported Google Account destination, then
        // navigate to Flow after the user selects an existing account.
        ? `https://accounts.google.com/AccountChooser?continue=${encodeURIComponent("https://myaccount.google.com/")}`
        : FLOW_URL;
      await page.goto(startUrl, { waitUntil: "domcontentloaded" });
      await this.store.touchAccount(account.id);
      const deadline = Date.now() + waitSeconds * 1_000;
      let chooserCompleted = !options.chooseGoogleAccount;
      let signedIn = chooserCompleted && await this.isSignedIn(page);
      while (!signedIn && Date.now() < deadline) {
        await page.waitForTimeout(1_000);
        if (!chooserCompleted && /^https:\/\/myaccount\.google\.com(?:\/|$)/i.test(page.url())) {
          chooserCompleted = true;
          await page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
        }
        signedIn = await this.isSignedIn(page);
      }
      if (!signedIn && waitSeconds > 0) {
        throw new FlowError(
          "login_required",
          `The existing Google session received from Chromium was not accepted by Flow within ${waitSeconds} seconds.`,
          ["Choose one of the accounts already shown in the account chooser, then call flow_connect_account again."],
        );
      }
      const currentUrl = page.url();
      if (signedIn && !attached) {
        await this.store.setHeadlessAfterLogin(account.id, true);
        await this.browsers.reset(account.id);
      }
      return [
        `${signedIn ? "Connected" : "Opened"} Google Flow account '${account.id}' (${account.label}).`,
        account.browserMode === "attach_cdp"
          ? `Attached to Chromium CDP: ${account.cdpUrl}`
          : `Connected through Flow Login Bridge (${transferred?.cookies.length ?? 0} Google session cookies transferred locally).`,
        `Current URL: ${currentUrl}`,
        signedIn
          ? attached
            ? "The session is signed in and ready. The attached browser remains open."
            : "The session is signed in and ready. The temporary login window was closed; future automation runs invisibly."
          : "The account chooser contains the accounts already signed into the normal browser; no credentials need to be entered.",
      ].join("\n");
    });
  }

  async inspect(accountId: string): Promise<UiCapabilities> {
    const account = await this.store.requireAccount(accountId);
    return this.browsers.runExclusive(account.id, async () => {
      const page = await this.readyPage(account.id, false);
      const signedIn = await this.isSignedIn(page);
      if (signedIn) await this.openProject(page).catch(() => undefined);
      const body = await page.locator("body").innerText().catch(() => "");
      const durationHints = uniqueNumbers(body.split(/\n+/)
        .map(parseDurationSeconds)
        .filter((value): value is number => value !== undefined));
      let agentCapabilities: AgentSettingsCapabilities | undefined;
      let controlText: string[] = [];
      if (await this.openAgentSettings(page)) {
        agentCapabilities = await this.readAgentSettings(page, durationHints);
        controlText = [
          ...agentCapabilities.models.image.map((option) => option.label),
          ...agentCapabilities.models.video.map((option) => option.label),
          ...agentCapabilities.ratios.image,
          ...agentCapabilities.ratios.video,
        ];
        const back = await lastVisible(page.locator("button").filter({ has: page.locator("i", { hasText: /^arrow_back$/ }) }));
        if (back) await back.click().catch(() => undefined);
      } else {
        const settings = await firstVisible([
          page.getByRole("button", { name: /settings|options|generation settings/i }).last(),
          page.getByRole("button", { name: /nano banana|veo|omni/i }).last(),
        ]);
        if (settings) {
          await settings.click().catch(() => undefined);
          await page.waitForTimeout(250);
        }
        controlText = await visibleText(page.locator('button, [role="button"], [role="option"], [role="menuitem"]'));
        await page.keyboard.press("Escape").catch(() => undefined);
      }

      const videos = this.mediaLocator(page, "video");
      const upscaleOptions = (await videos.count()) > 0
        ? await this.readVideoDownloadOptions(page, videos.last()).catch(() => [])
        : [];
      await page.keyboard.press("Escape").catch(() => undefined);
      const screenshot = this.store.diagnosticPath(`inspect-${account.id}`);
      await page.screenshot({ path: screenshot, fullPage: false });
      return {
        url: page.url(),
        signedIn,
        language: await page.locator("html").getAttribute("lang").then((value) => value || "unknown").catch(() => "unknown"),
        ...(agentCapabilities ? {
          models: agentCapabilities.models,
          aspectRatiosByMedia: agentCapabilities.ratios,
          outputCountsByMedia: agentCapabilities.outputs,
        } : {}),
        visibleModels: unique(agentCapabilities
          ? [...agentCapabilities.models.image, ...agentCapabilities.models.video].map((option) => option.label)
          : controlText.filter((text) => /veo|omni|nano banana|imagen/i.test(text))),
        visibleAspectRatios: unique(agentCapabilities
          ? [...agentCapabilities.ratios.image, ...agentCapabilities.ratios.video]
          : controlText.flatMap((text) => text.match(/\b(?:16:9|9:16|1:1|4:3|3:4)\b/g) ?? [])),
        visibleDurations: agentCapabilities?.durationSeconds ?? durationHints,
        availableUpscales: upscaleOptions
          .filter((option) => option.kind === "upscale" && option.available)
          .map((option) => option.id),
        unavailableUpscales: upscaleOptions
          .filter((option) => option.kind === "upscale" && !option.available)
          .map((option) => option.id),
        upscaleOptions,
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
        await this.fillPrompt(
          page,
          `${request.mediaType === "video"
            ? request.outputs === 1 ? "Create exactly one video" : `Create exactly ${request.outputs} videos`
            : request.outputs === 1 ? "Create exactly one image" : `Create exactly ${request.outputs} images`}: ${request.prompt}`,
        );

        const baseline = await this.mediaLocator(page, request.mediaType).count();
        await this.store.updateJob(job, "submitted", {
          baselineMediaCount: baseline,
          flowProjectUrl: page.url(),
        });
        await this.clickGenerate(page, request.mediaType, baseline);
        await this.store.updateJob(job, "processing");

        const completed = await this.waitForNewMedia(page, request.mediaType, baseline, request.timeoutSeconds);
        if (!completed) return job;

        if (request.mediaType === "video" && request.upscale !== "none") {
          await this.store.updateJob(job, "upscaling");
          const upscaled = await this.upscaleLatest(page, job, request.upscale, request.timeoutSeconds);
          if (!upscaled) return job;
          if (job.status === "completed") return job;
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
      if (ready && job.status !== "completed") await this.store.updateJob(job, "ready");
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
    const accountControl = await firstVisible([
      page.locator('button[aria-label*="Google Account" i], a[aria-label*="Google Account" i]'),
      page.locator('img[alt*="profile" i], img[alt*="account" i]'),
      page.locator('button img[src*="googleusercontent.com/a/"]'),
    ]);
    return Boolean(accountControl);
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

    await Promise.race([
      page.locator('a[href*="/tools/flow/project/"]').first().waitFor({ state: "visible", timeout: 8_000 }),
      page.locator("button").filter({ has: page.locator("i", { hasText: /^add_2$/ }) }).last()
        .waitFor({ state: "visible", timeout: 8_000 }),
    ]).catch(() => undefined);

    if (projectName) {
      const project = await firstVisible([
        page.getByRole("link", { name: new RegExp(projectName, "i") }),
        page.getByRole("button", { name: new RegExp(projectName, "i") }),
        page.getByText(projectName, { exact: false }),
      ]);
      if (project) {
        await project.click();
        if (await this.waitForPrompt(page)) return;
      }
    }

    const recentProject = await firstVisible([
      page.locator('a[href*="/tools/flow/project/"]').last(),
    ]);
    if (recentProject) {
      await recentProject.click();
      if (await this.waitForPrompt(page)) return;
    }

    const create = await firstVisible([
      page.getByRole("button", { name: /new project|create project|start.*project/i }),
      page.getByRole("button", { name: /nuevo proyecto|crear proyecto/i }),
      page.locator("button").filter({ has: page.locator("i", { hasText: /^add_2$/ }) }).last(),
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
    if (!(await this.waitForPrompt(page))) {
      throw new FlowError("ui_changed", "A Flow project opened, but the prompt editor could not be located.");
    }
  }

  private async waitForPrompt(page: Page, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await firstVisible([this.promptLocator(page)])) return true;
      await page.waitForTimeout(500);
    }
    return false;
  }

  private async configureGeneration(page: Page, request: GenerationRequest): Promise<void> {
    const durationHints = uniqueNumbers((await page.locator("body").innerText().catch(() => ""))
      .split(/\n+/)
      .map((text) => parseDurationSeconds(text))
      .filter((value): value is number => value !== undefined));
    if (await this.openAgentSettings(page)) {
      await this.configureAgentGeneration(page, request, durationHints);
      return;
    }

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

  private async openAgentSettings(page: Page): Promise<boolean> {
    const tune = await firstVisible([
      page.locator("button").filter({ has: page.locator("i", { hasText: /^tune$/ }) }),
      page.locator("button").filter({ has: page.locator("i", { hasText: /^settings_2$/ }) }),
    ]);
    if (!tune) return false;
    await tune.click();
    await page.waitForTimeout(400);
    return (await page.locator('[role="tablist"]').count()) >= 2;
  }

  private async readAgentSettings(page: Page, durationHints: number[]): Promise<AgentSettingsCapabilities> {
    const ratioGroups: string[][] = [];
    const outputGroups: number[][] = [];
    const tablists = page.locator('[role="tablist"]');
    const tablistCount = await tablists.count();
    for (let index = 0; index < tablistCount; index += 1) {
      const list = tablists.nth(index);
      if (!(await list.isVisible().catch(() => false))) continue;
      const labels = await visibleText(list.locator('[role="tab"]'));
      const ratios = unique(labels.flatMap((label) => label.match(/\b(?:16:9|9:16|1:1|4:3|3:4)\b/g) ?? []));
      if (ratios.length) ratioGroups.push(ratios);
      const outputs = uniqueNumbers(labels.map(parseOutputCount).filter((value): value is number => value !== undefined));
      if (outputs.length && outputs.every((value) => value >= 1 && value <= 4)) outputGroups.push(outputs);
    }

    const modelGroups: CapabilityOption[][] = [];
    const dropdowns = page.locator('button[aria-haspopup="menu"]');
    const dropdownCount = await dropdowns.count();
    for (let index = 0; index < dropdownCount; index += 1) {
      const dropdown = dropdowns.nth(index);
      if (!(await dropdown.isVisible().catch(() => false))) continue;
      const selectedLabel = cleanCapabilityLabel(await dropdown.innerText().catch(() => ""));
      if (!/(?:banana|omni|veo|imagen)/i.test(selectedLabel)) continue;
      await dropdown.click();
      await page.waitForTimeout(200);
      const labels = await visibleText(page.locator('[role="menuitem"]'));
      const options = labels
        .map(cleanCapabilityLabel)
        .filter((label) => /(?:banana|omni|veo|imagen)/i.test(label))
        .map((label) => ({
          id: normalizeCapabilityId(label),
          label,
          selected: normalizeCapabilityId(label) === normalizeCapabilityId(selectedLabel),
        }));
      if (options.length) modelGroups.push(options);
      await page.keyboard.press("Escape").catch(() => undefined);
    }

    return {
      models: {
        image: modelGroups[0] ?? [],
        video: modelGroups.at(-1) ?? [],
      },
      ratios: {
        image: ratioGroups[0] ?? [],
        video: ratioGroups.at(-1) ?? [],
      },
      outputs: {
        image: outputGroups[0] ?? [],
        video: outputGroups.at(-1) ?? [],
      },
      durationSeconds: uniqueNumbers(durationHints),
    };
  }

  private async configureAgentGeneration(
    page: Page,
    request: GenerationRequest,
    durationHints: number[],
  ): Promise<void> {
    const capabilities = await this.readAgentSettings(page, durationHints);
    const media = request.mediaType;
    const modelOptions = capabilities.models[media];
    if (request.model && request.model !== "ui-default") {
      const requestedId = normalizeCapabilityId(request.model);
      const requested = modelOptions.find((option) => option.id === requestedId);
      if (!requested) {
        throw new FlowError(
          "unsupported_option",
          `Model '${request.model}' is not offered for ${media} generation.`,
          modelOptions.map((option) => `${option.id} (${option.label})`),
        );
      }
      if (!requested.selected) {
        const modelButtons = page.locator('button[aria-haspopup="menu"]').filter({ hasText: /banana|omni|veo|imagen/i });
        const target = media === "image" ? await firstVisible([modelButtons.first()]) : await firstVisible([modelButtons.last()]);
        if (!target) throw new FlowError("ui_changed", `Could not find the ${media} model dropdown.`);
        await target.click();
        await page.waitForTimeout(200);
        const items = page.locator('[role="menuitem"]');
        let choice: Locator | null = null;
        const count = await items.count();
        for (let index = 0; index < count; index += 1) {
          const item = items.nth(index);
          if (!await item.isVisible().catch(() => false)) continue;
          if (normalizeCapabilityId(await item.innerText().catch(() => "")) === requestedId) {
            choice = item;
            break;
          }
        }
        if (!choice) throw new FlowError("ui_changed", `Flow listed '${requested.label}', but its menu item disappeared.`);
        await choice.click();
      }
    }

    if (request.aspectRatio && request.aspectRatio !== "ui-default") {
      await this.chooseAgentTab(page, request.aspectRatio, media, "aspect ratio", (label) => label.includes(":"));
    }
    await this.chooseAgentTab(
      page,
      String(request.outputs),
      media,
      "output count",
      (label) => label.split(/\s+/).some((part) => parseOutputCount(part) !== undefined),
      (label) => parseOutputCount(label) === request.outputs,
    );

    if (request.mediaType === "video" && request.durationSeconds) {
      if (!capabilities.durationSeconds.length) {
        throw new FlowError(
          "unsupported_option",
          "The current Flow Agent UI does not expose a selectable video duration. Omit durationSeconds to use the selected model's Flow default.",
        );
      }
      if (!capabilities.durationSeconds.includes(request.durationSeconds)) {
        throw new FlowError(
          "unsupported_option",
          `The current video configuration offers ${capabilities.durationSeconds.join(", ")} seconds, not ${request.durationSeconds} seconds.`,
        );
      }
    }

    const save = await lastVisible(page.locator("button"));
    if (!save) throw new FlowError("ui_changed", "Could not find the agent-settings save control.");
    await save.click();
    await page.waitForTimeout(500);
  }

  private async chooseAgentTab(
    page: Page,
    requested: string,
    media: MediaType,
    label: string,
    groupPredicate: (text: string) => boolean,
    choicePredicate: (text: string) => boolean = (text) => cleanCapabilityLabel(text) === requested,
  ): Promise<void> {
    const groups: Locator[] = [];
    const tablists = page.locator('[role="tablist"]');
    const count = await tablists.count();
    for (let index = 0; index < count; index += 1) {
      const list = tablists.nth(index);
      if (!await list.isVisible().catch(() => false)) continue;
      const text = (await list.innerText().catch(() => "")).replace(/\s+/g, " ");
      if (groupPredicate(text)) groups.push(list);
    }
    const group = media === "image" ? groups[0] : groups.at(-1);
    if (!group) throw new FlowError("unsupported_option", `Flow did not expose a ${media} ${label} control.`);
    const tabs = group.locator('[role="tab"]');
    const tabCount = await tabs.count();
    for (let index = 0; index < tabCount; index += 1) {
      const tab = tabs.nth(index);
      if (choicePredicate(await tab.innerText().catch(() => ""))) {
        await tab.click();
        return;
      }
    }
    throw new FlowError("unsupported_option", `The requested ${label} '${requested}' is not offered for ${media}.`);
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

  private async clickGenerate(page: Page, mediaType: MediaType, mediaBaseline: number): Promise<void> {
    const agentUi = Boolean(await firstVisible([
      page.locator("button").filter({ has: page.locator("i", { hasText: /^tune$/ }) }),
    ]));
    const checkIcons = page.locator("i.google-symbols").filter({ hasText: /^check$/ });
    const approvalBaseline = await visibleCount(checkIcons);
    const button = await firstVisible([
      page.locator("button").filter({ has: page.locator("i", { hasText: /^arrow_forward$/ }) }).last(),
      page.getByRole("button", { name: /^generate(?: image| video)?$/i }).last(),
      page.getByRole("button", { name: /^(?:crear|generar)$/i }).last(),
      page.getByText(/^generate(?: image| video)?$/i),
    ]);
    if (!button) throw new FlowError("ui_changed", "Could not find Flow's Generate control.");
    if (!(await button.isEnabled().catch(() => true))) {
      throw new FlowError("generation_failed", "Flow's Generate control is disabled after configuring the request.");
    }
    await button.click();
    await page.waitForTimeout(500);
    if (agentUi) {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const checks = await visibleCount(checkIcons);
        if (checks > approvalBaseline) {
          const approve = checkIcons.nth(approvalBaseline).locator("..");
          await approve.click();
          await page.waitForTimeout(500);
          return;
        }
        if (await this.mediaLocator(page, mediaType).count() > mediaBaseline) return;
        const body = (await page.locator("body").innerText().catch(() => "")).slice(-8_000);
        if (FAILURE_TEXT.test(body)) throw new FlowError("generation_failed", "Flow reported that generation could not start.");
        await page.waitForTimeout(1_000);
      }
      throw new FlowError("ui_changed", "Flow Agent did not expose a credit confirmation or begin generation within 120 seconds.");
    }
    const dialog = await firstVisible([page.locator('[role="dialog"]')]);
    if (dialog) {
      const confirm = await lastVisible(dialog.locator("button"));
      if (confirm && await confirm.isEnabled().catch(() => false)) {
        const icon = await confirm.locator("i").innerText().catch(() => "");
        if (!/^close$/i.test(icon.trim())) await confirm.click();
      }
    }
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
          if (element instanceof HTMLVideoElement) {
            if (element.readyState < 1 && (element.networkState === 0 || element.networkState === 3)) {
              element.preload = "metadata";
              element.load();
            }
            return element.readyState >= 1 && Number.isFinite(element.duration) && element.duration > 0;
          }
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
    await page.keyboard.press("Escape").catch(() => undefined);
    let surface = media;
    if (!await surface.isVisible().catch(() => false)) {
      const parentButton = media.locator("xpath=ancestor::button[1]");
      if (await parentButton.isVisible().catch(() => false)) surface = parentButton;
    }
    if (!await surface.isVisible().catch(() => false)) {
      throw new FlowError("ui_changed", "The generated asset exists, but Flow did not expose a visible asset card.");
    }
    await surface.scrollIntoViewIfNeeded();
    await surface.dispatchEvent("contextmenu", { button: 2 });
    await page.waitForTimeout(300);
    const menuVisible = await firstVisible([
      page.locator('[role="menuitem"]').filter({ has: page.locator("i.google-symbols", { hasText: /^download$/ }) }),
      page.locator('[role="menu"]'),
    ]);
    if (menuVisible) return;

    await page.keyboard.press("Escape").catch(() => undefined);
    await surface.hover();
    const more = await firstVisible([
      surface.locator("xpath=ancestor-or-self::*[position() <= 4]//button").filter({ has: page.locator("i.google-symbols", { hasText: /^more_vert$/ }) }).last(),
      page.getByRole("button", { name: /more|menu|options/i }).last(),
      page.locator('button[aria-label*="more" i], button[aria-label*="menu" i]').last(),
    ]);
    if (!more) throw new FlowError("ui_changed", "Could not open the generated asset's context menu.");
    await more.click();
    await page.waitForTimeout(300);
  }

  private async readVideoDownloadOptions(page: Page, media: Locator): Promise<import("./types.js").UpscaleOption[]> {
    await media.evaluate((element) => {
      if (!(element instanceof HTMLVideoElement)) return;
      if (element.readyState < 1) {
        element.preload = "metadata";
        element.load();
      }
    }).catch(() => undefined);
    await page.waitForTimeout(500);
    const originalHeight = await media.evaluate((element) => element instanceof HTMLVideoElement ? element.videoHeight : 0)
      .catch(() => 0);
    await this.openAssetMenu(page, media);
    const download = await firstVisible([
      page.locator('[role="menuitem"]').filter({ has: page.locator("i.google-symbols", { hasText: /^download$/ }) }),
    ]);
    if (download) {
      if (await download.getAttribute("aria-haspopup")) await download.hover({ force: true });
      else await download.click().catch(() => undefined);
      await page.waitForTimeout(400);
    }
    const entries: AssetMenuEntry[] = [];
    const items = page.locator('[role="menuitem"], [role="option"]');
    const itemCount = await items.count();
    for (let index = 0; index < itemCount; index += 1) {
      const item = items.nth(index);
      if (!await item.isVisible().catch(() => false)) continue;
      const text = await item.innerText().catch(() => "");
      if (!text.trim()) continue;
      const disabled = await item.evaluate((element) =>
        element.getAttribute("aria-disabled") === "true"
          || element.hasAttribute("data-disabled")
          || (element instanceof HTMLButtonElement && element.disabled),
      ).catch(() => false);
      entries.push({ text, disabled });
    }
    return extractUpscaleOptions(entries, originalHeight || undefined);
  }

  private async findVisibleMenuOption(page: Page, id: string): Promise<Locator | null> {
    const items = page.locator('[role="menuitem"], [role="option"]');
    const itemCount = await items.count();
    for (let index = 0; index < itemCount; index += 1) {
      const item = items.nth(index);
      if (!await item.isVisible().catch(() => false)) continue;
      if (normalizeUpscaleId(await item.innerText().catch(() => "")) === normalizeUpscaleId(id)) return item;
    }
    return null;
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
    const discovered = await this.readVideoDownloadOptions(page, media.last());
    const options = discovered
      .filter((option) => option.kind === "upscale" && option.available)
      .map((option) => option.id);

    const chosen = chooseUpscaleOption(options, requested);
    await this.store.updateJob(job, "upscaling", {
      availableUpscales: options,
      chosenUpscale: chosen,
    });
    const choice = await this.findVisibleMenuOption(page, chosen);
    if (!choice) throw new FlowError("ui_changed", `Flow offered '${chosen}', but its control disappeared before selection.`);
    const downloadWait = page.waitForEvent("download", { timeout: timeoutSeconds * 1_000 })
      .then((download) => ({ kind: "download" as const, download }))
      .catch(() => ({ kind: "download_timeout" as const }));
    const mediaWait = this.waitForNewMedia(page, "video", before, timeoutSeconds)
      .then((ready) => ({ kind: "media" as const, ready }));
    await choice.click();
    const result = await Promise.race([downloadWait, mediaWait]);
    if (result.kind === "download") {
      await this.saveCapturedDownload(job, result.download, chosen);
      return true;
    }
    const ready = result.kind === "media" ? result.ready : (await mediaWait).ready;
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
      const control = await firstVisible([
        page.locator('[role="menuitem"]').filter({ has: page.locator("i.google-symbols", { hasText: /^download$/ }) }),
        page.getByRole("menuitem", { name: /download/i }),
        page.getByRole("button", { name: /download/i }),
        page.getByText(/^download/i),
      ]);
      if (!control) throw new FlowError("download_failed", "The generated asset menu did not contain Download.");
      const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
      let choice: Locator | null = null;
      if (await control.getAttribute("aria-haspopup")) {
        await control.hover({ force: true });
        await page.waitForTimeout(400);
        if (job.mediaType === "video") {
          const originalHeight = await target.evaluate((element) => element instanceof HTMLVideoElement ? element.videoHeight : 0)
            .catch(() => 0);
          if (originalHeight) choice = await this.findVisibleMenuOption(page, `${originalHeight}p`);
        }
        choice ??= await firstVisible([
          page.getByRole("menuitem", { name: /\b(?:png|jpe?g|original|video file)\b/i }).last(),
        ]);
      }
      if (choice) await choice.click();
      else await control.click();

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

  private async saveCapturedDownload(job: FlowJob, download: Download, suffix: string): Promise<void> {
    await mkdir(job.outputDirectory, { recursive: true });
    const suggested = download.suggestedFilename();
    const extension = path.extname(suggested) || ".mp4";
    const stem = safeFileStem(job.fileName || job.prompt.slice(0, 60));
    const normalizedSuffix = safeFileStem(normalizeUpscaleId(suffix));
    const destination = path.join(
      job.outputDirectory,
      `${stem}-${job.id.slice(0, 8)}-${normalizedSuffix}${extension}`,
    );
    await download.saveAs(destination);
    const probe = await probeMedia(destination);
    const completed = await this.store.updateJob(job, "completed", {
      downloadedFiles: [...(job.downloadedFiles ?? []), destination],
      mediaProbe: [...(job.mediaProbe ?? []), probe],
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
