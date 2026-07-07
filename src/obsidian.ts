import { fetch, Agent } from "undici";
import { logger } from "./log.ts";
import { insertJournalLine, setFrontmatterNumber } from "./core.ts";

const log = logger("obsidian");

export interface ObsidianConfig {
  url: string;
  key: string;
  dailyDir: string;
  dailyTemplate: string;
  journalHeading: string;
  habitsHeading: string;
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
    log.debug({ method: "GET", path: vaultPath, status: res.status }, "obsidian request");
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`obsidian GET ${vaultPath}: ${res.status}`);
    return res.text();
  }
  private async putFile(vaultPath: string, body: string | Uint8Array, contentType: string): Promise<void> {
    const res = await fetch(`${this.cfg.url}/vault/${this.encode(vaultPath)}`, {
      method: "PUT", headers: this.headers({ "Content-Type": contentType }),
      body: body as any, dispatcher: this.dispatcher,
    });
    log.debug({ method: "PUT", path: vaultPath, status: res.status }, "obsidian request");
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
    log.info({ date, path }, "creating daily note from template");
    // ponytail: fill {{date}} only; richer template automations are out of scope.
    const tpl = (await this.getFile(`${this.cfg.dailyTemplate}.md`)) ?? "## Journal\n";
    await this.putFile(path, tpl.replaceAll("{{date}}", date), "text/markdown");
    return path;
  }

  /** Insert a bullet under the ## Journal heading. Read-modify-write (not the REST
   *  heading-append) so the line lands right after the last bullet — or replaces the
   *  empty template bullet — instead of trailing a blank line below it. */
  async appendJournalLine(date: string, line: string): Promise<void> {
    const path = this.dailyPath(date);
    const note = await this.readNote(path);
    await this.writeNote(path, insertJournalLine(note, this.cfg.journalHeading, line));
  }

  /** Set the `overallRating` frontmatter of a day's note (creating the note if the day
   *  was never journaled). Read-modify-write so a live edit in Obsidian isn't clobbered. */
  async setDailyRating(date: string, rating: number): Promise<void> {
    const path = await this.ensureDailyNote(date);
    const note = await this.readNote(path);
    await this.writeNote(path, setFrontmatterNumber(note, "overallRating", rating));
    log.info({ date, rating, path }, "overallRating frontmatter set");
  }

  /** Read a day's note by date, or null if that day was never journaled (no habits to
   *  review). Unlike setDailyRating this never creates the note. */
  async readDailyNote(date: string): Promise<{ path: string; content: string } | null> {
    const path = this.dailyPath(date);
    const content = await this.getFile(path);
    return content === null ? null : { path, content };
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
