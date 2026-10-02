import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? testFiles(file) : entry.name.endsWith(".test.ts") ? [file] : [];
  });
}

const files = testFiles("tests").sort();
if (!files.length) throw new Error("No test files found.");
// Pass explicit paths: Node 20 does not expand the CLI glob supported by Node 24.
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
