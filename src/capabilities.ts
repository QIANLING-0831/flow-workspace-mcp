export interface CapabilityOption {
  id: string;
  label: string;
  selected: boolean;
}

const ICON_WORDS = /\b(?:arrow_drop_down|crop_16_9|crop_9_16|crop_landscape|crop_portrait|crop_square)\b/gi;

export function cleanCapabilityLabel(value: string): string {
  return value
    .replace(ICON_WORDS, " ")
    .replace(/[🍌]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCapabilityId(value: string): string {
  return cleanCapabilityLabel(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^gemini\s+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseOutputCount(value: string): number | undefined {
  const match = cleanCapabilityLabel(value).match(/^(?:x\s*)?(\d+)(?:\s*x)?$/i);
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

export function parseDurationSeconds(value: string): number | undefined {
  const match = value.match(/\b(4|6|8|10)\s*(?:s|sec|seconds?|seg|segundos?)\b/i);
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}
