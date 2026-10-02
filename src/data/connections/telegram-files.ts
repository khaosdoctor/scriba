export class TelegramFiles {
  constructor(
    private api: { getFile(fileId: string): Promise<{ file_path?: string }> },
    private token: string,
  ) {}

  async download(fileId: string): Promise<{ path: string; bytes: Uint8Array }> {
    const file = await this.api.getFile(fileId);
    if (!file.file_path) throw new Error(`no file_path for ${fileId}`);
    // Bot API files go up to 20 MB, so longer than a model call, but never unbounded.
    const res = await fetch(
      `https://api.telegram.org/file/bot${this.token}/${file.file_path}`,
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!res.ok) throw new Error(`telegram file download: ${res.status}`);
    return {
      path: file.file_path,
      bytes: new Uint8Array(await res.arrayBuffer()),
    };
  }
}
