import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server exposes the intended Flow tools", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "flow-mcp-smoke-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
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
  const client = new Client({ name: "flow-mcp-test", version: "1.0.0" });
  context.after(async () => client.close());
  await client.connect(transport);

  assert.match(client.getInstructions() ?? "", /must use this MCP server's flow_\* tools exclusively/i);
  assert.match(client.getInstructions() ?? "", /Never open, navigate, scroll, click, or automate/i);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      "flow_begin_account_connection",
      "flow_complete_account_connection",
      "flow_download_job",
      "flow_generate_image",
      "flow_generate_video",
      "flow_help",
      "flow_inspect_account",
      "flow_job_status",
      "flow_list_accounts",
      "flow_login_bridge_status",
      "flow_upscale_video",
    ],
  );
  const videoTool = listed.tools.find((tool) => tool.name === "flow_generate_video");
  assert.match(videoTool?.description ?? "", /REQUIRED AND EXCLUSIVE PATH/);
  assert.equal((videoTool?.inputSchema.required as string[] | undefined)?.includes("accountId") ?? false, false);
  const accounts = await client.callTool({ name: "flow_list_accounts", arguments: {} });
  assert.equal(accounts.isError, undefined);
  assert.match((accounts.content[0] as { type: "text"; text: string }).text, /"accounts": \[\]/);
  assert.match((accounts.content[0] as { type: "text"; text: string }).text, /"connectionRequired": true/);
  assert.match((accounts.content[0] as { type: "text"; text: string }).text, /No verified default account exists/);
  const help = await client.callTool({ name: "flow_help", arguments: {} });
  assert.equal(help.isError, undefined);
  assert.match((help.content[0] as { type: "text"; text: string }).text, /Create Google Flow videos and images/);
  assert.match((help.content[0] as { type: "text"; text: string }).text, /exampleRequests/);
  const begin = await client.callTool({ name: "flow_begin_account_connection", arguments: { accountId: "personal" } });
  assert.equal(begin.isError, undefined);
  const beginText = (begin.content[0] as { type: "text"; text: string }).text;
  assert.match(beginText, /USER_ACTION_REQUIRED/);
  assert.match(beginText, /STOP NOW/);
  assert.match(beginText, /flow_complete_account_connection/);
  const connectionId = (JSON.parse(beginText) as { connectionId: string }).connectionId;
  const prematureComplete = await client.callTool({
    name: "flow_complete_account_connection",
    arguments: { connectionId, userConfirmedSessionSent: true, accountId: "personal" },
  });
  assert.equal(prematureComplete.isError, true);
  assert.match((prematureComplete.content[0] as { type: "text"; text: string }).text, /has not sent the browser session/);
});
