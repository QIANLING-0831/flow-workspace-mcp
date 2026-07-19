import { FlowError } from "./errors.js";
import type { UpscaleFactor } from "./types.js";

export function extractUpscaleLabels(texts: string[]): string[] {
  return [
    ...new Set(
      texts
        .flatMap((text) => text.split(/\r?\n/))
        .map((text) => text.trim())
        .filter((text) => /(?:upscale.*(?:1x|2x|4x|1080p|4k)|^(?:1x|2x|4x|1080p|4k)$)/i.test(text)),
    ),
  ];
}

export function chooseUpscaleOption(
  options: string[],
  requested: Exclude<UpscaleFactor, "none">,
): string {
  if (!options.length) {
    throw new FlowError(
      "unsupported_option",
      "The selected video did not expose any upscale choices in its Flow asset menu.",
      ["The video may still be processing, or this account/model may not support upscaling."],
    );
  }
  if (requested !== "highest_available") {
    const escaped = requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exact = options.find((option) => new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "i").test(option));
    if (exact) return exact;
    throw new FlowError(
      "unsupported_option",
      `Upscale '${requested}' is not offered for this video. Available choices: ${options.join(", ")}`,
      ["Use highest_available to select the largest factor actually shown by Flow."],
    );
  }
  const score = (value: string): number => {
    if (/4x|4k/i.test(value)) return 4;
    if (/2x|1080p/i.test(value)) return 2;
    if (/1x/i.test(value)) return 1;
    return 0;
  };
  return [...options].sort((left, right) => score(right) - score(left))[0]!;
}
