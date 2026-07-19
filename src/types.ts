export const FLOW_URL = "https://labs.google/fx/tools/flow";

export type MediaType = "video" | "image";
export type UpscaleFactor = "none" | "1x" | "2x" | "4x" | "highest_available";
export type JobStatus =
  | "created"
  | "configuring"
  | "submitted"
  | "processing"
  | "ready"
  | "upscaling"
  | "downloading"
  | "completed"
  | "failed"
  | "needs_attention";

export interface AccountRecord {
  id: string;
  label: string;
  createdAt: string;
  lastOpenedAt?: string;
  browserMode?: "managed" | "attach_cdp";
  cdpUrl?: string;
}

export interface AccountOptions {
  browserMode?: "managed" | "attach_cdp";
  cdpUrl?: string;
}

export interface AccountsFile {
  version: 1;
  defaultAccountId?: string;
  accounts: AccountRecord[];
}

export interface MediaProbe {
  format?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  codec?: string;
  sizeBytes: number;
  sha256: string;
  ffprobeAvailable: boolean;
}

export interface FlowJob {
  id: string;
  accountId: string;
  mediaType: MediaType;
  status: JobStatus;
  prompt: string;
  flowProject?: string;
  flowProjectUrl?: string;
  model?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  outputs: number;
  upscale: UpscaleFactor;
  availableUpscales?: string[];
  chosenUpscale?: string;
  outputDirectory: string;
  fileName?: string;
  downloadedFiles?: string[];
  mediaProbe?: MediaProbe[];
  error?: string;
  diagnosticScreenshot?: string;
  baselineMediaCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationRequest {
  accountId: string;
  mediaType: MediaType;
  prompt: string;
  flowProject?: string;
  model?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  outputs: number;
  referenceFiles: string[];
  upscale: UpscaleFactor;
  outputDirectory: string;
  fileName?: string;
  download: boolean;
  timeoutSeconds: number;
}

export interface UiCapabilities {
  url: string;
  signedIn: boolean;
  visibleModels: string[];
  visibleAspectRatios: string[];
  visibleDurations: number[];
  availableUpscales: string[];
  pageTextExcerpt: string;
  screenshot?: string;
}
