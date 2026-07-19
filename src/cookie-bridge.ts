import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { FlowError } from "./errors.js";
import type { TransferredBrowserSession, TransferredCookie } from "./types.js";

const DEFAULT_PORTS = Array.from({ length: 10 }, (_, index) => 37_421 + index);
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const SESSION_TTL_MS = 2 * 60 * 1000;

interface Waiter {
  resolve: (session: TransferredBrowserSession) => void;
  reject: (error: FlowError) => void;
  timer: NodeJS.Timeout;
}

function isExtensionOrigin(origin: string | undefined): boolean {
  // Chromium may omit Origin for extension requests granted explicit localhost
  // host permission. Normal web-page fetches include their https/http origin.
  return origin === undefined || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function isGoogleDomain(domain: string): boolean {
  const normalized = domain.replace(/^\./, "").toLowerCase();
  return normalized === "google.com" || normalized.endsWith(".google.com") || normalized === "labs.google" || normalized.endsWith(".labs.google");
}

function validateCookies(value: unknown): TransferredCookie[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_000) {
    throw new FlowError("validation_error", "The bridge payload must contain 1-2000 browser cookies.");
  }
  const cookies: TransferredCookie[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const cookie = item as Record<string, unknown>;
    if (typeof cookie.name !== "string" || typeof cookie.value !== "string" || typeof cookie.domain !== "string") continue;
    if (!isGoogleDomain(cookie.domain) || cookie.name.length > 256 || cookie.value.length > 16_384) continue;
    cookies.push({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      ...(typeof cookie.path === "string" ? { path: cookie.path } : {}),
      ...(typeof cookie.hostOnly === "boolean" ? { hostOnly: cookie.hostOnly } : {}),
      ...(typeof cookie.secure === "boolean" ? { secure: cookie.secure } : {}),
      ...(typeof cookie.httpOnly === "boolean" ? { httpOnly: cookie.httpOnly } : {}),
      ...(cookie.sameSite === "no_restriction" || cookie.sameSite === "lax" || cookie.sameSite === "strict" || cookie.sameSite === "unspecified"
        ? { sameSite: cookie.sameSite }
        : {}),
      ...(typeof cookie.expirationDate === "number" ? { expirationDate: cookie.expirationDate } : {}),
    });
  }
  if (!cookies.length) throw new FlowError("validation_error", "No Google session cookies were present in the bridge payload.");
  return cookies;
}

export class CookieBridge {
  private server: Server | undefined;
  private port: number | undefined;
  private readonly waiters: Waiter[] = [];
  private queued: TransferredBrowserSession | undefined;
  private armedUntil = 0;
  private armedAt = 0;
  private connectionId: string | undefined;

  constructor(private readonly candidatePorts: number[] = DEFAULT_PORTS) {}

  async start(): Promise<number> {
    if (this.server && this.port) return this.port;
    for (const port of this.candidatePorts) {
      try {
        const server = createServer((request, response) => void this.handle(request, response));
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
        this.server = server;
        const address = server.address();
        this.port = typeof address === "object" && address ? address.port : port;
        return this.port;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    throw new FlowError("browser_error", `Flow login bridge could not bind localhost ports ${this.candidatePorts.join(", ")}.`);
  }

  status(): { running: boolean; port?: number; waitingForBrowser: boolean; queuedSession: boolean; connectionRequestedAt?: string } {
    const armed = this.armedUntil > Date.now();
    return {
      running: Boolean(this.server),
      ...(this.port ? { port: this.port } : {}),
      waitingForBrowser: this.waiters.length > 0 || armed,
      queuedSession: Boolean(this.queued && Date.now() - Date.parse(this.queued.receivedAt) <= SESSION_TTL_MS),
      ...(armed && this.armedAt ? { connectionRequestedAt: new Date(this.armedAt).toISOString() } : {}),
    };
  }

  armForSession(timeoutSeconds = 300): ReturnType<CookieBridge["status"]> & { connectionId: string } {
    this.armedAt = Date.now();
    this.armedUntil = Date.now() + timeoutSeconds * 1_000;
    this.connectionId = randomUUID();
    return { ...this.status(), connectionId: this.connectionId };
  }

  assertSessionReady(connectionId: string): void {
    if (!this.connectionId || connectionId !== this.connectionId) {
      throw new FlowError(
        "validation_error",
        "The account connection token is missing, expired, or belongs to another MCP process.",
        ["Restart with flow_begin_account_connection and use the connectionId it returns."],
      );
    }
    if (!this.queued || Date.now() - Date.parse(this.queued.receivedAt) > SESSION_TTL_MS) {
      throw new FlowError(
        "login_required",
        "Flow Login Bridge has not sent the browser session for this connection yet.",
        ["Stop and tell the user to open Flow Login Bridge, click Connect Flow, wait for Session sent, and reply connected."],
      );
    }
  }

  async waitForSession(timeoutSeconds: number): Promise<TransferredBrowserSession> {
    await this.start();
    if (this.queued && Date.now() - Date.parse(this.queued.receivedAt) <= SESSION_TTL_MS) {
      const session = this.queued;
      this.queued = undefined;
      this.armedUntil = 0;
      this.armedAt = 0;
      this.connectionId = undefined;
      return session;
    }
    this.queued = undefined;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new FlowError(
            "login_required",
            `No browser session arrived from the Flow Login Bridge within ${timeoutSeconds} seconds.`,
            ["Click the Flow Login Bridge extension in the normal browser, then click Connect Flow."],
          ));
        }, timeoutSeconds * 1_000),
      };
      this.waiters.push(waiter);
    });
  }

  async close(): Promise<void> {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new FlowError("browser_error", "Flow login bridge stopped while waiting for the browser."));
    }
    this.armedUntil = 0;
    this.armedAt = 0;
    this.connectionId = undefined;
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin;
    if (!isExtensionOrigin(origin)) {
      this.json(response, 403, { error: "extension_origin_required" });
      return;
    }
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      this.json(response, 200, this.status());
      return;
    }
    if (request.method !== "POST" || request.url !== "/session") {
      this.json(response, 404, { error: "not_found" });
      return;
    }
    try {
      const body = await this.readBody(request);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const session: TransferredBrowserSession = {
        cookies: validateCookies(parsed.cookies),
        ...(typeof parsed.browser === "string" ? { browser: parsed.browser.slice(0, 100) } : {}),
        ...(typeof parsed.profile === "string" ? { profile: parsed.profile.slice(0, 100) } : {}),
        receivedAt: new Date().toISOString(),
      };
      const waiter = this.waiters.shift();
      this.armedUntil = 0;
      this.armedAt = 0;
      if (waiter) {
        this.connectionId = undefined;
        clearTimeout(waiter.timer);
        waiter.resolve(session);
      } else {
        this.queued = session;
      }
      this.json(response, 200, { ok: true, cookieCount: session.cookies.length, waitingRequestClaimed: Boolean(waiter) });
    } catch (error) {
      this.json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) throw new FlowError("validation_error", "Browser session payload exceeded 5 MB.");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
  }
}
