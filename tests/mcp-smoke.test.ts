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

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      "flow_connect_account",
      "flow_download_job",
      "flow_generate_image",
      "flow_generate_video",
      "flow_inspect_account",
      "flow_job_status",
      "flow_list_accounts",
      "flow_upscale_video",
    ],
  );
  const accounts = await client.callTool({ name: "flow_list_accounts", arguments: {} });
  assert.equal(accounts.isError, undefined);
  assert.match((accounts.content[0] as { type: "text"; text: string }).text, /"accounts": \[\]/);
});
