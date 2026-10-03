import type { JotSection } from "../../domain/jot/entity.ts";
import { logger } from "../../libs/log.ts";
import {
  anchorLine,
  insertJournalLine,
  moveAnchorLine,
  replaceAnchorLine,
  setFrontmatterValue,
} from "../../libs/note.ts";
import { ObsidianConnection } from "../connections/obsidian.ts";

const log = logger("obsidian");

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

export class ObsidianClient {
  private connection: ObsidianConnection;

  constructor(private cfg: ObsidianConfig) {
    this.connection = new ObsidianConnection(cfg);
  }

  get dispatcher() {
    return this.connection.dispatcher;
  }

  /** Pure path for a day's note — no network. Callers persist this before any REST call so
   *  a jot row exists even when Obsidian is unreachable at intake. */
  dailyPath(date: string): string {
    return `${this.cfg.dailyDir}/${date}.md`;
  }

  // Serialize concurrent first-of-day creation so two intakes can't both 404-then-PUT
  // the blank template (the later PUT would erase the earlier's placeholder line).
  private creating = new Map<string, Promise<string>>();

  async ensureDailyNote(date: string): Promise<string> {
    const inFlight = this.creating.get(date);
    if (inFlight) return inFlight;
    const pending = this.doEnsureDailyNote(date).finally(() =>
      this.creating.delete(date),
    );
    this.creating.set(date, pending);
    return pending;
  }

  private async doEnsureDailyNote(date: string): Promise<string> {
    const path = this.dailyPath(date);
    if ((await this.connection.getFile(path)) !== null) return path;
    log.info({ date, path }, "creating daily note from template");
    // ponytail: fill {{date}} only; richer template automations are out of scope.
    const template =
      (await this.connection.getFile(`${this.cfg.dailyTemplate}.md`)) ??
      "## Journal\n";
    await this.connection.putFile(
      path,
      template.replaceAll("{{date}}", date),
      "text/markdown",
    );
    return path;
  }

  // Each op on a path chains onto the previous one for that path.
  // ponytail: the chain map grows one entry per distinct note path (about one a day), which
  // a single-user bot never needs to prune.
  private writeChain = new Map<string, Promise<unknown>>();
  private async withNoteLock<T>(
    vaultPath: string,
    fn: () => Promise<T>,
  ): Promise<T> {
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

  /** Read, change and write a note under its lock, so two concurrent stacks (intake,
   *  flush, retry pass) can't both read v1 and have the later PUT drop the earlier's
   *  change. `fn` gets the note as it is now and calls `write` with the new text; nothing
   *  goes out when it doesn't, or when the text is unchanged. Answers what `fn` returned. */
  async updateNote<T>(
    vaultPath: string,
    fn: (note: string, write: (next: string) => void) => T | Promise<T>,
  ): Promise<T> {
    return this.withNoteLock(vaultPath, async () => {
      const note = await this.readNote(vaultPath);
      let next = note;
      const result = await fn(note, (text) => {
        next = text;
      });
      if (next !== note) await this.writeNote(vaultPath, next);
      return result;
    });
  }

  async updateLine<T>(
    vaultPath: string,
    anchor: string,
    fn: (line: string, write: (next: string) => void) => T | Promise<T>,
  ): Promise<T | null> {
    return this.updateNote(vaultPath, (note, write) => {
      const line = anchorLine(note, anchor);
      if (line === null) return null;
      return fn(line, (next) => write(replaceAnchorLine(note, anchor, next)!));
    });
  }

  async setFrontmatter(
    vaultPath: string,
    key: string,
    value: string | number,
  ): Promise<void> {
    await this.updateNote(vaultPath, (note, write) =>
      write(setFrontmatterValue(note, key, value)),
    );
  }

  /** Insert a bullet under the ## Journal heading (or ## TIL for a TIL jot).
   *  Read-modify-write (not the REST heading-append) so the line goes right after the
   *  last bullet, or replaces the empty template bullet, instead of trailing a blank
   *  line below it. */
  async appendJournalLine(
    date: string,
    line: string,
    section: JotSection = "journal",
  ): Promise<void> {
    const heading =
      section === "til" ? this.cfg.tilHeading : this.cfg.journalHeading;
    await this.updateNote(this.dailyPath(date), (note, write) =>
      write(insertJournalLine(note, heading, line)),
    );
  }

  async moveToTil(
    notePath: string,
    anchor: string,
  ): Promise<"moved" | "no-line" | "no-heading"> {
    return this.updateNote(notePath, (note, write) => {
      const moved = moveAnchorLine(note, anchor, this.cfg.tilHeading);
      if ("missing" in moved)
        return moved.missing === "line" ? "no-line" : "no-heading";
      write(moved.note);
      log.info({ notePath, anchor }, "line moved to TIL");
      return "moved";
    });
  }

  async setDailyRating(date: string, rating: number): Promise<void> {
    const path = await this.ensureDailyNote(date);
    await this.setFrontmatter(path, "overallRating", rating);
    log.info({ date, rating, path }, "overallRating frontmatter set");
  }

  async readDailyNote(
    date: string,
  ): Promise<{ path: string; content: string } | null> {
    const path = this.dailyPath(date);
    const content = await this.connection.getFile(path);
    return content === null ? null : { path, content };
  }

  async readNote(vaultPath: string): Promise<string> {
    const content = await this.connection.getFile(vaultPath);
    if (content === null) throw new Error(`note not found: ${vaultPath}`);
    return content;
  }
  async writeNote(vaultPath: string, content: string): Promise<void> {
    await this.connection.putFile(vaultPath, content, "text/markdown");
  }
  /** Delete a note. Only `/command` uses this, and only after you confirm the tap. */
  async deleteNote(vaultPath: string): Promise<void> {
    await this.connection.deleteFile(vaultPath);
  }
  async saveAsset(
    name: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<string> {
    const vaultPath = `${this.cfg.assetsDir}/${name}`;
    await this.connection.putFile(vaultPath, bytes, contentType);
    return vaultPath;
  }
}
