import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { requireAbsoluteDirectory, safeFileStem, validateAccountId } from "../src/paths.js";

test("validateAccountId normalizes valid IDs", () => {
  assert.equal(validateAccountId(" Creator_2 "), "creator_2");
});

test("validateAccountId rejects path-like IDs", () => {
  assert.throws(() => validateAccountId("../personal"), /accountId must be/);
});

test("safeFileStem removes filesystem punctuation", () => {
  assert.equal(safeFileStem('Rain: a "neon" city?'), "Rain-a-neon-city");
});

test("output directories must be absolute", () => {
  assert.throws(() => requireAbsoluteDirectory("public/generated/flow"), /absolute path/);
  assert.equal(requireAbsoluteDirectory(path.resolve("public/generated/flow")), path.resolve("public/generated/flow"));
});
