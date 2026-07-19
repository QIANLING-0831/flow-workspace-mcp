import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MediaProbe, MediaType } from "./types.js";

const execFileAsync = promisify(execFile);

export function mediaExtension(contentType: string, type: MediaType): string {
  const normalized = contentType.toLowerCase().split(";", 1)[0]?.trim();
  const extensions: Record<string, string> = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };
  return extensions[normalized ?? ""] ?? (type === "video" ? ".mp4" : ".png");
}

async function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function probeMedia(file: string): Promise<MediaProbe> {
  const info = await stat(file);
  const base: MediaProbe = {
    sizeBytes: info.size,
    sha256: await sha256(file),
    ffprobeAvailable: false,
  };

  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
      { timeout: 20_000, maxBuffer: 2_000_000 },
    );
    const parsed = JSON.parse(stdout) as {
      format?: { format_name?: string; duration?: string };
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }>;
    };
    const video = parsed.streams?.find((stream) => stream.codec_type === "video");
    const duration = Number(video?.duration ?? parsed.format?.duration);
    return {
      ...base,
      ffprobeAvailable: true,
      ...(parsed.format?.format_name ? { format: parsed.format.format_name } : {}),
      ...(Number.isFinite(duration) ? { durationSeconds: duration } : {}),
      ...(video?.width ? { width: video.width } : {}),
      ...(video?.height ? { height: video.height } : {}),
      ...(video?.codec_name ? { codec: video.codec_name } : {}),
    };
  } catch {
    return base;
  }
}
