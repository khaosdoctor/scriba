import { Agent, fetch } from "undici";
import { logger } from "../../libs/log.ts";

const log = logger("obsidian");

// Obsidian is on the LAN: a request slower than this is a hung plugin, not a slow link.
const REQUEST_TIMEOUT_MS = 15_000;

interface ObsidianConnectionConfig {
  url: string;
  key: string;
  insecureTls: boolean;
}

export class ObsidianConnection {
  // Obsidian's Local REST API serves a self-signed cert, so TLS verification is skipped
  // for a loopback target (the normal case). A non-loopback URL (e.g. the homelab deploy
  // reaching Obsidian over the LAN) gets real verification so the bearer token can't be
  // intercepted on an untrusted segment — unless OBSIDIAN_INSECURE_TLS opts out for a
  // trusted LAN with its own self-signed cert. Public so the health probe trusts exactly
  // what the client trusts.
  readonly dispatcher: Agent;
  readonly verifyTls: boolean;

  constructor(private cfg: ObsidianConnectionConfig) {
    const host = new URL(cfg.url).hostname;
    const loopback =
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]";
    this.verifyTls = !loopback && !cfg.insecureTls;
    if (!this.verifyTls)
      log.warn({ host }, "TLS verification disabled for Obsidian");
    this.dispatcher = new Agent({
      connect: { rejectUnauthorized: this.verifyTls },
    });
  }

  private encode(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
  }
  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.cfg.key}`, ...extra };
  }

  private async request(
    method: "GET" | "PUT" | "DELETE",
    vaultPath: string,
    init: { headers?: Record<string, string>; body?: string | Uint8Array } = {},
  ) {
    const res = await fetch(`${this.cfg.url}/vault/${this.encode(vaultPath)}`, {
      method,
      headers: this.headers(init.headers),
      body: init.body as any,
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    log.debug(
      { method, path: vaultPath, status: res.status },
      "obsidian request",
    );
    return res;
  }

  async getFile(vaultPath: string): Promise<string | null> {
    const res = await this.request("GET", vaultPath);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`obsidian GET ${vaultPath}: ${res.status}`);
    return res.text();
  }
  async putFile(
    vaultPath: string,
    body: string | Uint8Array,
    contentType: string,
  ): Promise<void> {
    const res = await this.request("PUT", vaultPath, {
      headers: { "Content-Type": contentType },
      body,
    });
    if (!res.ok)
      throw new Error(
        `obsidian PUT ${vaultPath}: ${res.status} ${await res.text()}`,
      );
  }
  async deleteFile(vaultPath: string): Promise<void> {
    const res = await this.request("DELETE", vaultPath);
    if (!res.ok && res.status !== 404)
      throw new Error(`obsidian DELETE ${vaultPath}: ${res.status}`);
  }
}
