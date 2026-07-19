import assert from "node:assert/strict";
import test from "node:test";
import { cleanCapabilityLabel, normalizeCapabilityId, parseDurationSeconds, parseOutputCount } from "../src/capabilities.js";

test("normalizes Flow model labels independently of decoration", () => {
  assert.equal(normalizeCapabilityId("Gemini Omni Flash"), "omni-flash");
  assert.equal(normalizeCapabilityId("🍌 Nano Banana 2 Lite arrow_drop_down"), "nano-banana-2-lite");
  assert.equal(normalizeCapabilityId("Veo 3.1 - Quality"), "veo-3-1-quality");
  assert.equal(cleanCapabilityLabel("🍌 Nano Banana Pro arrow_drop_down"), "Nano Banana Pro");
});

test("parses structural duration and output labels", () => {
  assert.equal(parseOutputCount("1x"), 1);
  assert.equal(parseOutputCount("x4"), 4);
  assert.equal(parseDurationSeconds("Vídeo · 8s"), 8);
  assert.equal(parseDurationSeconds("Video · 10 sec"), 10);
});
