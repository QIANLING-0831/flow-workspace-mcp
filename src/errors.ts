export type FlowErrorCode =
  | "validation_error"
  | "account_not_found"
  | "login_required"
  | "flow_access_unavailable"
  | "ui_changed"
  | "unsupported_option"
  | "generation_failed"
  | "generation_timeout"
  | "job_asset_identity_missing"
  | "generated_asset_not_found"
  | "download_failed"
  | "browser_error"
  | "internal_error";

export class FlowError extends Error {
  constructor(
    public readonly code: FlowErrorCode,
    message: string,
    public readonly suggestions: string[] = [],
  ) {
    super(message);
    this.name = "FlowError";
  }
}

export function errorText(error: unknown): string {
  if (error instanceof FlowError) {
    const suggestions = error.suggestions.length
      ? `\nSuggestions:\n${error.suggestions.map((value) => `- ${value}`).join("\n")}`
      : "";
    return `Error (${error.code}): ${error.message}${suggestions}`;
  }
  if (error instanceof Error) return `Error (internal_error): ${error.message}`;
  return `Error (internal_error): ${String(error)}`;
}
