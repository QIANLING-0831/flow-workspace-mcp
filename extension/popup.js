const PORTS = Array.from({ length: 10 }, (_, index) => 37421 + index);
const statusElement = document.querySelector("#status");
const connectButton = document.querySelector("#connect");
let bridge;

function setStatus(message, state = "") {
  statusElement.textContent = message;
  statusElement.className = `status ${state}`.trim();
}

async function request(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(1500), cache: "no-store" });
}

async function findBridge() {
  const results = await Promise.all(PORTS.map(async (port) => {
    try {
      const response = await request(`http://127.0.0.1:${port}/status`);
      if (!response.ok) return null;
      return { port, status: await response.json() };
    } catch {
      return null;
    }
  }));
  return results.find((entry) => entry?.status?.waitingForBrowser) || results.find(Boolean) || null;
}

async function googleCookies() {
  const groups = await Promise.all([
    chrome.cookies.getAll({ domain: "google.com" }),
    chrome.cookies.getAll({ domain: "labs.google" }),
  ]);
  const unique = new Map();
  for (const cookie of groups.flat()) {
    unique.set(`${cookie.storeId}|${cookie.domain}|${cookie.path}|${cookie.name}`, cookie);
  }
  return [...unique.values()];
}

async function initialize() {
  bridge = await findBridge();
  if (!bridge) {
    setStatus("Flow MCP is not running. Start it from your agent, then reopen this popup.", "error");
    return;
  }
  setStatus(
    bridge.status.waitingForBrowser ? "Flow MCP is waiting. Ready to connect." : "Flow MCP is running. Ready to connect.",
    "ready",
  );
  connectButton.disabled = false;
}

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  connectButton.textContent = "Connecting…";
  setStatus("Reading this browser's existing Google session…");
  try {
    bridge = bridge || await findBridge();
    if (!bridge) throw new Error("Flow MCP is not running.");
    const cookies = await googleCookies();
    if (!cookies.length) throw new Error("No signed-in Google session was found in this Chromium profile.");
    const response = await request(`http://127.0.0.1:${bridge.port}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies, browser: navigator.userAgent, profile: "Chromium" }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Flow MCP rejected the browser session.");
    setStatus("Connected. Choose the Google account in the Flow window.", "ready");
    connectButton.textContent = "Connected";
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
    connectButton.disabled = false;
    connectButton.textContent = "Try again";
  }
});

void initialize();
