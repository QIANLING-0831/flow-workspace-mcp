#!/usr/bin/env node
import { BrowserManager, findBrowserExecutable } from "./browser-manager.js";
import { CookieBridge } from "./cookie-bridge.js";
import { errorText } from "./errors.js";
import { FlowAdapter } from "./flow-adapter.js";
import { FlowStore } from "./store.js";

function usage(): never {
  console.error(`Usage:
  flow-mcp-cli account list
  flow-mcp-cli account connect <account-id> [label] [--cdp http://127.0.0.1:9222] [--wait 600]
  flow-mcp-cli account inspect <account-id>
  flow-mcp-cli browser detect

Examples:
  flow-mcp-cli account connect personal "Personal Google Pro"
  flow-mcp-cli account connect studio "Existing Chromium" --cdp http://127.0.0.1:9222
  flow-mcp-cli account list`);
  process.exit(2);
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const [, , group, action, id, ...rest] = process.argv;
if (!group || !action) usage();

if (group === "browser" && action === "detect") {
  const executable = findBrowserExecutable();
  console.log(executable ?? "No system Chromium/Chrome executable detected.");
  process.exit(executable ? 0 : 1);
}
if (group !== "account") usage();

const store = new FlowStore();
await store.initialize();
const browsers = new BrowserManager(store);
const cookieBridge = new CookieBridge();
await cookieBridge.start();
const flow = new FlowAdapter(store, browsers, cookieBridge);

try {
  if (action === "list") {
    console.log(JSON.stringify(await store.listAccounts(), null, 2));
  } else if (action === "connect") {
    if (!id) usage();
    const cdpUrl = optionValue(rest, "--cdp");
    const waitValue = optionValue(rest, "--wait");
    const labelParts = rest.slice(0, rest.findIndex((value) => value.startsWith("--")) === -1
      ? rest.length
      : rest.findIndex((value) => value.startsWith("--")));
    const waitForAccountSelectionSeconds = waitValue ? Number.parseInt(waitValue, 10) : 600;
    if (!cdpUrl) {
      cookieBridge.armForSession(300);
      console.log("USER ACTION: Open Flow Login Bridge in your normal signed-in Chromium and click Connect Flow. Then select the desired existing account in the temporary chooser.");
    }
    console.log(await flow.connectAccount(id, labelParts.join(" ") || undefined, {
      browserMode: cdpUrl ? "attach_cdp" : "extension",
      waitForBridgeSeconds: 60,
      waitForAccountSelectionSeconds,
      ...(cdpUrl ? { cdpUrl } : {}),
    }));
  } else if (action === "inspect") {
    if (!id) usage();
    console.log(JSON.stringify(await flow.inspect(id), null, 2));
  } else {
    usage();
  }
} catch (error) {
  console.error(errorText(error));
  process.exitCode = 1;
} finally {
  await browsers.closeAll();
  await cookieBridge.close();
}
