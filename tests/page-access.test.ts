import assert from "node:assert/strict";
import test from "node:test";
import { classifyPageAccess } from "../src/flow-adapter.js";

test("a signed-in public landing page is not classified as a Flow workspace", () => {
  assert.deepEqual(classifyPageAccess(true, false), {
    signedIn: true,
    workspaceAvailable: false,
    pageKind: "landing_or_unavailable",
  });
});

test("workspace evidence takes precedence over weak sign-in detection", () => {
  assert.deepEqual(classifyPageAccess(false, true), {
    signedIn: true,
    workspaceAvailable: true,
    pageKind: "workspace",
  });
});
