import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FlowError } from "./errors.js";
import { validateAccountId } from "./paths.js";
import type { AccountOptions, AccountRecord, AccountsFile, FlowJob, GenerationRequest, JobStatus } from "./types.js";

function platformDataDir(): string {
  if (process.env.FLOW_MCP_DATA_DIR) return path.resolve(process.env.FLOW_MCP_DATA_DIR);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "flow-mcp");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "flow-mcp");
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "flow-mcp");
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export class FlowStore {
  readonly dataDir: string;
  readonly profilesDir: string;
  readonly jobsDir: string;
  readonly diagnosticsDir: string;
  private readonly accountsFile: string;
  private accountsTail: Promise<void> = Promise.resolve();

  constructor(dataDir = platformDataDir()) {
    this.dataDir = path.resolve(dataDir);
    this.profilesDir = path.join(this.dataDir, "profiles");
    this.jobsDir = path.join(this.dataDir, "jobs");
    this.diagnosticsDir = path.join(this.dataDir, "diagnostics");
    this.accountsFile = path.join(this.dataDir, "accounts.json");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.profilesDir, { recursive: true }),
      mkdir(this.jobsDir, { recursive: true }),
      mkdir(this.diagnosticsDir, { recursive: true }),
    ]);
  }

  async listAccounts(): Promise<AccountsFile> {
    await this.initialize();
    return readJson<AccountsFile>(this.accountsFile, { version: 1, accounts: [] });
  }

  async ensureAccount(accountId: string, label?: string, options: AccountOptions = {}): Promise<AccountRecord> {
    return this.withAccountsLock(async () => {
      const id = validateAccountId(accountId);
      const file = await this.listAccounts();
      const found = file.accounts.find((account) => account.id === id);
      const cdpUrl = options.cdpUrl ? this.validateCdpUrl(options.cdpUrl) : undefined;
      if (found) {
        let changed = false;
        if (label?.trim() && found.label !== label.trim()) {
          found.label = label.trim();
          changed = true;
        }
        if (options.browserMode && found.browserMode !== options.browserMode) {
          found.browserMode = options.browserMode;
          changed = true;
        }
        if (cdpUrl && found.cdpUrl !== cdpUrl) {
          found.cdpUrl = cdpUrl;
          changed = true;
        }
        if (options.browserExecutablePath && found.browserExecutablePath !== options.browserExecutablePath) {
          found.browserExecutablePath = options.browserExecutablePath;
          changed = true;
        }
        if (changed) await atomicWriteJson(this.accountsFile, file);
        return found;
      }

      const account: AccountRecord = {
        id,
        label: label?.trim() || id,
        createdAt: new Date().toISOString(),
        browserMode: options.browserMode ?? "managed",
        ...(cdpUrl ? { cdpUrl } : {}),
        ...(options.browserExecutablePath ? { browserExecutablePath: options.browserExecutablePath } : {}),
      };
      file.accounts.push(account);
      if (!file.defaultAccountId) file.defaultAccountId = id;
      await atomicWriteJson(this.accountsFile, file);
      await mkdir(this.profileDir(id), { recursive: true });
      return account;
    });
  }

  async availableAccountId(base: string): Promise<string> {
    const normalized = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "flow";
    const file = await this.listAccounts();
    if (!file.accounts.some((account) => account.id === normalized)) return normalized;
    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const candidate = `${normalized.slice(0, 47 - String(suffix).length)}-${suffix}`;
      if (!file.accounts.some((account) => account.id === candidate)) return candidate;
    }
    throw new FlowError("internal_error", "Could not allocate a local Flow session ID.");
  }

  async requireAccount(accountId?: string): Promise<AccountRecord> {
    const file = await this.listAccounts();
    const requested = accountId ? validateAccountId(accountId) : file.defaultAccountId;
    const account = file.accounts.find((item) => item.id === requested);
    if (!account) {
      throw new FlowError(
        "account_not_found",
        requested ? `Flow account '${requested}' is not configured.` : "No Flow account is configured.",
        ["Call flow_connect_account with a new accountId; it automatically detects when Flow authentication completes."],
      );
    }
    return account;
  }

  async touchAccount(accountId: string): Promise<void> {
    await this.withAccountsLock(async () => {
      const file = await this.listAccounts();
      const account = file.accounts.find((item) => item.id === accountId);
      if (!account) return;
      account.lastOpenedAt = new Date().toISOString();
      await atomicWriteJson(this.accountsFile, file);
    });
  }

  async setHeadlessAfterLogin(accountId: string, enabled: boolean): Promise<void> {
    await this.withAccountsLock(async () => {
      const file = await this.listAccounts();
      const account = file.accounts.find((item) => item.id === accountId);
      if (!account) return;
      account.headlessAfterLogin = enabled;
      await atomicWriteJson(this.accountsFile, file);
    });
  }

  profileDir(accountId: string): string {
    return path.join(this.profilesDir, validateAccountId(accountId));
  }

  diagnosticPath(prefix: string, extension = "png"): string {
    const token = createHash("sha1").update(`${prefix}-${Date.now()}-${randomUUID()}`).digest("hex").slice(0, 12);
    return path.join(this.diagnosticsDir, `${prefix}-${token}.${extension}`);
  }

  async createJob(request: GenerationRequest): Promise<FlowJob> {
    const now = new Date().toISOString();
    const job: FlowJob = {
      id: randomUUID(),
      accountId: request.accountId,
      mediaType: request.mediaType,
      status: "created",
      prompt: request.prompt,
      outputs: request.outputs,
      upscale: request.upscale,
      outputDirectory: request.outputDirectory,
      createdAt: now,
      updatedAt: now,
      ...(request.flowProject ? { flowProject: request.flowProject } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
      ...(request.durationSeconds ? { durationSeconds: request.durationSeconds } : {}),
      ...(request.fileName ? { fileName: request.fileName } : {}),
    };
    await this.saveJob(job);
    return job;
  }

  async getJob(jobId: string): Promise<FlowJob> {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
      throw new FlowError("validation_error", "jobId must be the UUID returned by a Flow generation tool.");
    }
    const job = await readJson<FlowJob | null>(path.join(this.jobsDir, `${jobId}.json`), null);
    if (!job) throw new FlowError("validation_error", `Flow job '${jobId}' was not found.`);
    return job;
  }

  async saveJob(job: FlowJob): Promise<void> {
    job.updatedAt = new Date().toISOString();
    await atomicWriteJson(path.join(this.jobsDir, `${job.id}.json`), job);
  }

  async updateJob(job: FlowJob, status: JobStatus, patch: Partial<FlowJob> = {}): Promise<FlowJob> {
    Object.assign(job, patch, { status });
    await this.saveJob(job);
    return job;
  }

  private async withAccountsLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.accountsTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.accountsTail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private validateCdpUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new FlowError("validation_error", `Invalid Chromium CDP URL: ${value}`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new FlowError(
        "validation_error",
        "cdpUrl must be a localhost HTTP(S) endpoint. Remote browser-control endpoints are intentionally rejected.",
      );
    }
    return url.toString().replace(/\/$/, "");
  }
}
