import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { probeMedia } from "../src/media.js";

test("media probing always returns size and sha256", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "flow-mcp-media-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const file = path.join(temporary, "sample.bin");
  await writeFile(file, "flow-mcp");

  const probe = await probeMedia(file);
  assert.equal(probe.sizeBytes, 8);
  assert.match(probe.sha256, /^[a-f0-9]{64}$/);
});
