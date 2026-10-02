import type { MediaService } from "./media.ts";
import type { Transcriber } from "./transcriber.ts";

export interface VoiceDeps {
  media: Pick<MediaService, "downloadFile">;
  transcriber: Transcriber;
}

export class VoiceService {
  constructor(private deps: VoiceDeps) {}

  async transcribe(fileId: string): Promise<string> {
    const file = await this.deps.media.downloadFile(fileId);
    return this.deps.transcriber.transcribe(file.bytes, file.ext);
  }
}
