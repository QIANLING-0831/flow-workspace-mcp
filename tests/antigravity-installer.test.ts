import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertStableCleanClone, npmInvocation, writeAntigravityConfig } from "../scripts/setup-antigravity.mjs";

test("Antigravity setup refuses disposable scratch installations", () => {
  assert.throws(
    () => assertStableCleanClone("C:\\Users\\test\\.gemini\\antigravity\\scratch\\google-flow-mcp"),
    /disposable scratch directory/,
  );
});

test("Antigravity config preserves other servers and uses official stdio fields", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "flow-mcp-antigravity-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const configPath = path.join(temporary, "mcp_config.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: { existing: { command: "existing-tool" } } }), "utf8");
  const repoRoot = path.resolve(".");
  const entry = await writeAntigravityConfig({ repoRoot, configPath, nodeExecutable: process.execPath });
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    mcpServers: Record<string, { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }>;
  };
  assert.equal(config.mcpServers.existing?.command, "existing-tool");
  assert.equal(entry.command, path.resolve(process.execPath));
  assert.deepEqual(entry.args, [path.resolve("dist/index.js")]);
  assert.equal(entry.cwd, repoRoot);
  assert.deepEqual(entry.env, { FLOW_MCP_HEADLESS: "0" });
  assert.equal("FLOW_MCP_BROWSER_EXECUTABLE" in entry.env, false);
  assert.equal(await readFile(`${configPath}.bak`, "utf8").then(Boolean), true);
});

test("Antigravity setup invokes npm through Node without Windows cmd shell quoting", () => {
  const invocation = npmInvocation();
  if (process.platform === "win32") {
    assert.equal(invocation.command, process.execPath);
    assert.match(invocation.prefix[0] ?? "", /npm-cli\.js$/i);
  }
});
