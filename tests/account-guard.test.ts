import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FlowStore } from "../src/store.js";

test("account connection is refused when a verified default already exists", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "flow-mcp-account-guard-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const store = new FlowStore(temporary);
  await store.ensureAccount("personal", "Personal");
  await store.markAccountConnected("personal");

  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  environment.FLOW_MCP_DATA_DIR = temporary;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/index.js")],
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "flow-mcp-account-guard", version: "1.0.0" });
  context.after(async () => client.close());
  await client.connect(transport);

  const listed = await client.callTool({ name: "flow_list_accounts", arguments: {} });
  const listText = (listed.content[0] as { type: "text"; text: string }).text;
  assert.match(listText, /"readyForGeneration": true/);
  assert.match(listText, /ACCOUNT IS ALREADY CONNECTED/);

  const begin = await client.callTool({ name: "flow_begin_account_connection", arguments: {} });
  const beginText = (begin.content[0] as { type: "text"; text: string }).text;
  assert.match(beginText, /ALREADY_CONNECTED/);
  assert.doesNotMatch(beginText, /USER_ACTION_REQUIRED/);
});
