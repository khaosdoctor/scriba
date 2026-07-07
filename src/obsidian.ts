import { fetch, Agent } from "undici";

/** Local REST API v3 heading path: each ancestor segment URL-encoded, joined by `::`. */
export function headingTarget(...segments: string[]): string {
  return segments.map(encodeURIComponent).join("::");
}

export interface ObsidianConfig {
  url: string;
  key: string;
  dailyDir: string;
  dailyTemplate: string;
  journalHeading: string;
  assetsDir: string;
}

/** Thin client over the Obsidian Local REST API (the VFB headless instance). */
export class ObsidianClient {
  // Self-signed cert on the LAN — skip TLS verification.
  private dispatcher = new Agent({ connect: { rejectUnauthorized: false } });

  constructor(private cfg: ObsidianConfig) {}

  private encode(p: string): string {
    return p.split("/").map(encodeURIComponent).join("/");
  }
  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.cfg.key}`, ...extra };
  }
  private dailyPath(date: string): string {
    return `${this.cfg.dailyDir}/${date}.md`;
  }

  private async getFile(vaultPath: string): Promise<string | null> {
    const res = await fetch(`${this.cfg.url}/vault/${this.encode(vaultPath)}`, {
      headers: this.headers(), dispatcher: this.dispatcher,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`obsidian GET ${vaultPath}: ${res.status}`);
    return res.text();
  }
  private async putFile(vaultPath: string, body: string | Uint8Array, contentType: string): Promise<void> {
    const res = await fetch(`${this.cfg.url}/vault/${this.encode(vaultPath)}`, {
      method: "PUT", headers: this.headers({ "Content-Type": contentType }),
      body: body as any, dispatcher: this.dispatcher,
    });
    if (!res.ok) throw new Error(`obsidian PUT ${vaultPath}: ${res.status} ${await res.text()}`);
  }

  // Serialize concurrent first-of-day creation so two intakes can't both 404-then-PUT
  // the blank template (the later PUT would erase the earlier's placeholder line).
  private creating = new Map<string, Promise<string>>();

  /** Create today's note from the vault template if it doesn't exist yet. */
  async ensureDailyNote(date: string): Promise<string> {
    const inFlight = this.creating.get(date);
    if (inFlight) return inFlight;
    const p = this.doEnsureDailyNote(date).finally(() => this.creating.delete(date));
    this.creating.set(date, p);
    return p;
  }

  private async doEnsureDailyNote(date: string): Promise<string> {
    const path = this.dailyPath(date);
    if (await this.getFile(path) !== null) return path;
    // ponytail: fill {{date}} only; richer template automations are out of scope.
    const tpl = (await this.getFile(`${this.cfg.dailyTemplate}.md`)) ?? "## Journal\n";
    await this.putFile(path, tpl.replaceAll("{{date}}", date), "text/markdown");
    return path;
  }

  /** Append a bullet under the ## Journal heading. */
  async appendJournalLine(date: string, line: string): Promise<void> {
    const path = this.dailyPath(date);
    // Local REST API v3 targets a heading by its FULL ancestor path, URL-encoded and
    // delimited by `::` — the leaf name alone returns 40080 invalid-target. The daily
    // note's H1 is the date (template `# {{date}}`), so Journal is `<date>::Journal`.
    const target = headingTarget(date, this.cfg.journalHeading);
    const res = await fetch(`${this.cfg.url}/vault/${this.encode(path)}`, {
      method: "PATCH",
      headers: this.headers({
        "Content-Type": "text/markdown",
        "Operation": "append",
        "Target-Type": "heading",
        "Target": target,
        "Target-Delimiter": "::",
      }),
      body: `\n${line}`, dispatcher: this.dispatcher,
    });
    if (!res.ok) throw new Error(`obsidian PATCH ${path}: ${res.status} ${await res.text()}`);
  }

  /** Read a note's current content (live — the user may have edited it in Obsidian). */
  async readNote(vaultPath: string): Promise<string> {
    const c = await this.getFile(vaultPath);
    if (c === null) throw new Error(`note not found: ${vaultPath}`);
    return c;
  }
  async writeNote(vaultPath: string, content: string): Promise<void> {
    await this.putFile(vaultPath, content, "text/markdown");
  }
  async saveAsset(name: string, bytes: Uint8Array, contentType: string): Promise<string> {
    const vaultPath = `${this.cfg.assetsDir}/${name}`;
    await this.putFile(vaultPath, bytes, contentType);
    return vaultPath;
  }
}
