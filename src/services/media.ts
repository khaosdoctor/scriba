import { extname } from "node:path";
import type { TelegramFiles } from "../data/connections/telegram-files.ts";
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
  files: Pick<TelegramFiles, "download">;
}

export class MediaService {
  constructor(private deps: MediaDeps) {}

  async downloadFile(fileId: string): Promise<DownloadedFile> {
    const { path, bytes } = await this.deps.files.download(fileId);
    const ext = (extname(path).slice(1) || "bin").toLowerCase();
    log.debug({ fileId, ext, bytes: bytes.length }, "downloaded telegram file");
    return { bytes, ext, mime: MIME[ext] ?? "application/octet-stream" };
  }
}
