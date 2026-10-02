import { extname } from "node:path";
import { logger } from "../libs/log.ts";

const log = logger("bot");

const MIME: Record<string, string> = {
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  flac: "audio/flac",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export interface DownloadedFile {
  bytes: Uint8Array;
  ext: string;
  mime: string;
}

export interface MediaDeps {
  /** grammy's Api fits; typed structurally so services stay free of grammy. */
  api: { getFile(fileId: string): Promise<{ file_path?: string }> };
  token: string;
}

/** Telegram media in, bytes out. Image captions stay in the enricher. */
export class MediaService {
  constructor(private deps: MediaDeps) {}

  async downloadFile(fileId: string): Promise<DownloadedFile> {
    const file = await this.deps.api.getFile(fileId);
    if (!file.file_path) throw new Error(`no file_path for ${fileId}`);
    // Bot API files go up to 20 MB, so longer than a model call, but never unbounded.
    const res = await fetch(
      `https://api.telegram.org/file/bot${this.deps.token}/${file.file_path}`,
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!res.ok) throw new Error(`telegram file download: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ext = (extname(file.file_path).slice(1) || "bin").toLowerCase();
    log.debug({ fileId, ext, bytes: bytes.length }, "downloaded telegram file");
    return { bytes, ext, mime: MIME[ext] ?? "application/octet-stream" };
  }
}
