import path from "node:path";
import { FlowError } from "./errors.js";

export const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function validateAccountId(accountId: string): string {
  const normalized = accountId.trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(normalized)) {
    throw new FlowError(
      "validation_error",
      "accountId must be 1-48 lowercase letters, numbers, underscores, or hyphens and must start with a letter or number.",
      ["Use an ID such as personal, work, or creator_2."],
    );
  }
  return normalized;
}

export function requireAbsoluteDirectory(value: string, field = "outputDirectory"): string {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(value)) {
    throw new FlowError(
      "validation_error",
      `${field} must be an absolute path. Received: ${value}`,
    );
  }
  return resolved;
}

export function safeFileStem(value: string): string {
  const stem = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9-_ ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return stem || "flow-asset";
}

export function assertExistingFiles(files: string[]): string[] {
  return files.map((file) => {
    if (!path.isAbsolute(file)) {
      throw new FlowError("validation_error", `Reference file paths must be absolute: ${file}`);
    }
    return path.resolve(file);
  });
}
