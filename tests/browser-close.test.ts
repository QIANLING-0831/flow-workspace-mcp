import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Browser } from "playwright";
import test from "node:test";
import { closeManagedBrowser } from "../src/browser-manager.js";

test("managed Chrome receives graceful Browser.close before kill fallback", async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, killed: false, kill() { this.killed = true; return true; } });
  const commands: string[] = [];
  const browser = {
    newBrowserCDPSession: async () => ({ send: async (command: string) => {
      commands.push(command);
      child.exitCode = 0;
      child.emit("exit", 0);
    } }),
    close: async () => { commands.push("disconnect"); },
  } as unknown as Browser;
  await closeManagedBrowser(browser, child as unknown as ChildProcess, 10);
  assert.deepEqual(commands, ["Browser.close", "disconnect"]);
  assert.equal(child.killed, false, "do not interrupt cookie flush with an immediate kill");
  child.exitCode = null;
  const broken = { newBrowserCDPSession: async () => { throw new Error("unreachable"); }, close: async () => {} } as unknown as Browser;
  await closeManagedBrowser(broken, child as unknown as ChildProcess, 10);
  assert.equal(child.killed, true, "hung browser still has bounded cleanup");
});
