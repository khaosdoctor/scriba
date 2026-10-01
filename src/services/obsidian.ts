import { Agent, fetch } from "undici";
import {
  insertJournalLine,
  moveAnchorLine,
  setFrontmatterValue,
} from "../core.ts";
import { logger } from "../log.ts";
import type { JotSection } from "../models/domain.ts";

const log = logger("obsidian");

// Obsidian is on the LAN: a request slower than this is a hung plugin, not a slow link.
const REQUEST_TIMEOUT_MS = 15_000;

export interface ObsidianConfig {
  url: string;
  key: string;
  dailyDir: string;
  dailyTemplate: string;
  journalHeading: string;
  tilHeading: string;
  habitsHeading: string;
  assetsDir: string;
  insecureTls: boolean;
}

/** Thin client over the Obsidian Local REST API (the VFB headless instance). */
export class ObsidianClient {
  // Obsidian's Local REST API serves a self-signed cert, so TLS verification is skipped
  // for a loopback target (the normal case). A non-loopback URL (e.g. the homelab deploy
  // reaching Obsidian over the LAN) gets real verification so the bearer token can't be
  // intercepted on an untrusted segment — unless OBSIDIAN_INSECURE_TLS opts out for a
  // trusted LAN with its own self-signed cert. Public so the health probe trusts exactly
  // what the client trusts.
  readonly dispatcher: Agent;

  constructor(private cfg: ObsidianConfig) {
    const host = new URL(cfg.url).hostname;
    const loopback =
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]";
    const verifyTls = !loopback && !cfg.insecureTls;
    if (!verifyTls)
      log.warn({ host }, "TLS verification disabled for Obsidian");
    this.dispatcher = new Agent({
      connect: { rejectUnauthorized: verifyTls },
    });
  }

  private encode(p: string): string {
    return p.split("/").map(encodeURIComponent).join("/");
  }
  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.cfg.key}`, ...extra };
  }
  /** Pure path for a day's note — no network. Callers persist this before any REST call so
   *  a jot row exists even when Obsidian is unreachable at intake. */
  dailyPath(date: string): string {
    return `${this.cfg.dailyDir}/${date}.md`;
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

  private async getFile(vaultPath: string): Promise<string | null> {
    const res = await this.request("GET", vaultPath);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`obsidian GET ${vaultPath}: ${res.status}`);
    return res.text();
  }
  private async putFile(
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

  // Serialize concurrent first-of-day creation so two intakes can't both 404-then-PUT
  // the blank template (the later PUT would erase the earlier's placeholder line).
  private creating = new Map<string, Promise<string>>();

  /** Create today's note from the vault template if it doesn't exist yet. */
  async ensureDailyNote(date: string): Promise<string> {
    const inFlight = this.creating.get(date);
    if (inFlight) return inFlight;
    const p = this.doEnsureDailyNote(date).finally(() =>
      this.creating.delete(date),
    );
    this.creating.set(date, p);
    return p;
  }

  private async doEnsureDailyNote(date: string): Promise<string> {
    const path = this.dailyPath(date);
    if ((await this.getFile(path)) !== null) return path;
    log.info({ date, path }, "creating daily note from template");
    // ponytail: fill {{date}} only; richer template automations are out of scope.
    const tpl =
      (await this.getFile(`${this.cfg.dailyTemplate}.md`)) ?? "## Journal\n";
    await this.putFile(path, tpl.replaceAll("{{date}}", date), "text/markdown");
    return path;
  }

  // Serialize read-modify-write on a note so two concurrent stacks (intake, flush, retry
  // sweep, boot sweep) can't both read v1 and have the later PUT clobber the earlier's
  // line. Each op on a path chains onto the previous one for that path.
  // ponytail: the chain map grows one entry per distinct note path (≈1/day). If it ever
  // matters, prune settled tails — for a single-user bot it never will.
  private writeChain = new Map<string, Promise<unknown>>();
  async withNoteLock<T>(vaultPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = (this.writeChain.get(vaultPath) ?? Promise.resolve()).catch(
      () => {},
    );
    const run = prev.then(fn);
    this.writeChain.set(
      vaultPath,
      run.catch(() => {}),
    );
    return run;
  }

  /** Insert a bullet under the ## Journal heading (or ## TIL for a TIL jot).
   *  Read-modify-write (not the REST heading-append) so the line lands right after the
   *  last bullet — or replaces the empty template bullet — instead of trailing a blank
   *  line below it. */
  async appendJournalLine(
    date: string,
    line: string,
    section: JotSection = "journal",
  ): Promise<void> {
    const path = this.dailyPath(date);
    const heading =
      section === "til" ? this.cfg.tilHeading : this.cfg.journalHeading;
    await this.withNoteLock(path, async () => {
      const note = await this.readNote(path);
      await this.writeNote(path, insertJournalLine(note, heading, line));
    });
  }

  /** Move a jot's line from wherever it is to the TIL heading of the same note, anchor
   *  untouched. Says what is missing when the line or the TIL heading isn't in the note. */
  async moveToTil(
    notePath: string,
    anchor: string,
  ): Promise<"moved" | "no-line" | "no-heading"> {
    return this.withNoteLock(notePath, async () => {
      const note = await this.readNote(notePath);
      const out = moveAnchorLine(note, anchor, this.cfg.tilHeading);
      if ("missing" in out)
        return out.missing === "line" ? "no-line" : "no-heading";
      await this.writeNote(notePath, out.note);
      log.info({ notePath, anchor }, "line moved to TIL");
      return "moved";
    });
  }

  /** Set the `overallRating` frontmatter of a day's note (creating the note if the day
   *  was never journaled). Read-modify-write so a live edit in Obsidian isn't clobbered. */
  async setDailyRating(date: string, rating: number): Promise<void> {
    const path = await this.ensureDailyNote(date);
    await this.withNoteLock(path, async () => {
      const note = await this.readNote(path);
      await this.writeNote(
        path,
        setFrontmatterValue(note, "overallRating", rating),
      );
    });
    log.info({ date, rating, path }, "overallRating frontmatter set");
  }

  /** Read a day's note by date, or null if that day was never journaled (no habits to
   *  review). Unlike setDailyRating this never creates the note. */
  async readDailyNote(
    date: string,
  ): Promise<{ path: string; content: string } | null> {
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
  /** Delete a note. Only `/command` uses this, and only after you confirm the tap. */
  async deleteNote(vaultPath: string): Promise<void> {
    const res = await this.request("DELETE", vaultPath);
    if (!res.ok && res.status !== 404)
      throw new Error(`obsidian DELETE ${vaultPath}: ${res.status}`);
  }
  async saveAsset(
    name: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<string> {
    const vaultPath = `${this.cfg.assetsDir}/${name}`;
    await this.putFile(vaultPath, bytes, contentType);
    return vaultPath;
  }
}
