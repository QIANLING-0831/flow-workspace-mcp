import assert from "node:assert/strict";
import test from "node:test";
import { CookieBridge } from "../src/cookie-bridge.js";

const ORIGIN = `chrome-extension://${"a".repeat(32)}`;

test("cookie bridge accepts validated Google cookies only from an extension origin", async (context) => {
  const bridge = new CookieBridge([0]);
  context.after(async () => bridge.close());
  const port = await bridge.start();
  const waiting = bridge.waitForSession(5);
  const response = await fetch(`http://127.0.0.1:${port}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({
      profile: "Default",
      cookies: [
        { name: "SID", value: "encrypted-session-value", domain: ".google.com", path: "/", secure: true, httpOnly: true },
        { name: "ignored", value: "nope", domain: ".example.com", path: "/" },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const session = await waiting;
  assert.equal(session.cookies.length, 1);
  assert.equal(session.cookies[0]?.domain, ".google.com");
  assert.equal(session.profile, "Default");
});

test("cookie bridge rejects normal web origins", async (context) => {
  const bridge = new CookieBridge([0]);
  context.after(async () => bridge.close());
  const port = await bridge.start();
  const response = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Origin: "https://example.com" } });
  assert.equal(response.status, 403);
});

test("cookie bridge accepts origin-less Chromium extension requests", async (context) => {
  const bridge = new CookieBridge([0]);
  context.after(async () => bridge.close());
  const port = await bridge.start();
  const response = await fetch(`http://127.0.0.1:${port}/status`);
  assert.equal(response.status, 200);
});

test("cookie bridge queues a session before the completion tool starts waiting", async (context) => {
  const bridge = new CookieBridge([0]);
  context.after(async () => bridge.close());
  const port = await bridge.start();
  const connection = bridge.armForSession(30);
  assert.equal(connection.waitingForBrowser, true);
  assert.throws(() => bridge.assertSessionReady(connection.connectionId), /has not sent/);
  const response = await fetch(`http://127.0.0.1:${port}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({
      profile: "Default",
      cookies: [{ name: "SID", value: "queued", domain: ".google.com", path: "/", secure: true }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(bridge.status().waitingForBrowser, false);
  assert.doesNotThrow(() => bridge.assertSessionReady(connection.connectionId));
  assert.equal(bridge.status().queuedSession, true);
  assert.equal(bridge.status().waitingForBrowser, false);
  const session = await bridge.waitForSession(1);
  assert.equal(session.cookies[0]?.value, "queued");
  assert.equal(bridge.status().queuedSession, false);
});
