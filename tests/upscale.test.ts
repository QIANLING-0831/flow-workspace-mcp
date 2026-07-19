import assert from "node:assert/strict";
import test from "node:test";
import { chooseUpscaleOption, extractUpscaleLabels } from "../src/upscale.js";

test("extracts Flow-style upscale labels", () => {
  assert.deepEqual(
    extractUpscaleLabels(["Download", "Upscale 1x", "Upscale 2x", "Delete"]),
    ["Upscale 1x", "Upscale 2x"],
  );
});

test("selects the exact requested factor", () => {
  assert.equal(chooseUpscaleOption(["Upscale 1x", "Upscale 2x"], "2x"), "Upscale 2x");
});

test("highest_available never assumes an unavailable factor", () => {
  assert.equal(chooseUpscaleOption(["Upscale 1x", "Upscale 2x"], "highest_available"), "Upscale 2x");
  assert.throws(() => chooseUpscaleOption(["Upscale 1x"], "4x"), /not offered/);
});
