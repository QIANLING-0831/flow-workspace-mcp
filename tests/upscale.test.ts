import assert from "node:assert/strict";
import test from "node:test";
import { chooseUpscaleOption, extractUpscaleLabels, extractUpscaleOptions } from "../src/upscale.js";

test("extracts Flow-style upscale labels", () => {
  assert.deepEqual(
    extractUpscaleLabels(["Download", "Upscale 1x", "Upscale 2x", "Delete"]),
    ["2x"],
  );
});

test("classifies localized resolution choices structurally", () => {
  assert.deepEqual(
    extractUpscaleOptions([
      { text: "270p\nGIF animado" },
      { text: "720p\nTamaño original" },
      { text: "1080p\nMejora de resolución" },
      { text: "4K\nMejora de resolución\nActualizar", disabled: true },
    ], 720),
    [
      { id: "270p", label: "270p GIF animado", available: true, kind: "preview" },
      { id: "720p", label: "720p Tamaño original", available: true, kind: "original" },
      { id: "1080p", label: "1080p Mejora de resolución", available: true, kind: "upscale" },
      { id: "4k", label: "4K Mejora de resolución Actualizar", available: false, kind: "upscale" },
    ],
  );
});

test("selects the exact requested factor", () => {
  assert.equal(chooseUpscaleOption(["Upscale 1x", "Upscale 2x"], "2x"), "Upscale 2x");
  assert.equal(chooseUpscaleOption(["1080p", "4k"], "1080p"), "1080p");
});

test("highest_available never assumes an unavailable factor", () => {
  assert.equal(chooseUpscaleOption(["Upscale 1x", "Upscale 2x"], "highest_available"), "Upscale 2x");
  assert.equal(chooseUpscaleOption(["1080p", "4k"], "highest_available"), "4k");
  assert.throws(() => chooseUpscaleOption(["Upscale 1x"], "4x"), /not offered/);
});
