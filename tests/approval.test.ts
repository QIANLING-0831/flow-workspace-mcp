import assert from "node:assert/strict";
import test from "node:test";
import { preferredPersistentApprovalIndex } from "../src/approval.js";

test("persistent approval chooses the final newly-added approval action", () => {
  assert.equal(preferredPersistentApprovalIndex(4, 6), 5);
  assert.equal(preferredPersistentApprovalIndex(0, 2), 1);
  assert.equal(preferredPersistentApprovalIndex(3, 3), null);
});
