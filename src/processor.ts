import { basename } from "node:path";
import { Repository, MAX_ATTEMPTS, type Jot } from "./db.ts";
import type { ObsidianClient } from "./obsidian.ts";
import type { Transcriber } from "./transcribe.ts";
import type { Enricher } from "./enrich.ts";
import type { LinkIndex } from "./index-links.ts";
import { candidates, candidatesViaSearch, journalLine, replaceAnchorLine, makeJotId } from "./core.ts";

export interface DownloadedFile { bytes: Uint8Array; ext: string; mime: string; }

/** What the processor needs from the bot: user-facing I/O it can't do itself. */
export interface BotServices {
  notify: (text: string) => Promise<void>;
  askLink: (pendingId: string, surface: string, note: string) => Promise<void>;
  askRetry: (jotId: string, text: string) => Promise<void>; // notify + a force-retry button
  downloadFile: (fileId: string) => Promise<DownloadedFile>;
  onJotDone: (jotId: string) => Promise<void>; // apply edits queued while processing
}

/** Errors worth retrying (transient infra); anything else is treated as unrecoverable. */
function isRecoverable(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /timeout|etimedout|econnrefused|econnreset|enotfound|eai_again|fetch failed|socket|network|429|overloaded|\b5\d\d\b/.test(m);
}

/** Turns a queued jot into an enriched, written journal line. Audio + text only. */
export class JotProcessor {
  constructor(
    private repo: Repository,
    private obsidian: ObsidianClient,
    private transcriber: Transcriber,
    private enricher: Enricher,
    private links: LinkIndex,
    private bot: BotServices,
  ) {}

  async processBatch(ids: string[]): Promise<void> {
    // ponytail: one agent call per jot. Batching coalesces arrivals + retries;
    // true bulk-in-one-prompt enrichment is a future token optimisation.
    for (const id of ids) await this.processJot(id);
  }

  /** Forever-retry for failed jots (capped) + crash recovery for pending. */
  async retrySweep(): Promise<void> {
    for (const jot of await this.repo.pendingJots()) await this.processJot(jot.id);
  }

  async processJot(id: string): Promise<void> {
    const loaded = await this.repo.getJot(id);
    if (!loaded) return;
    // Atomic claim — only the winner proceeds, so flush + sweeps can't double-process.
    if (!(await this.repo.claim(id))) return;
    try {
      const jot = await this.ensureMedia(loaded);
      const source =
        jot.kind === "audio" ? (jot.transcript ?? "") :
        jot.kind === "text" ? (jot.raw_text ?? "") :
        ""; // image/video are attach-only

      let textPart = source;
      if (source.trim()) {
        const [stopwords, rejections] = await Promise.all([this.repo.stopwords(), this.repo.rejections()]);
        // Prefer the local filesystem index (exact title+alias match). When it's empty —
        // no vault mount, or the mount is unreadable — fall back to REST title search.
        const index = this.links.list();
        const cands = index.length
          ? candidates(source, index, stopwords, rejections)
          : await candidatesViaSearch(source, (t) => this.obsidian.searchTitles(t), stopwords, rejections);
        const res = await this.enricher.enrich({ text: source, candidates: cands });
        textPart = res.text;
        for (const a of res.ambiguous) {
          const pid = makeJotId();
          await this.repo.addPendingLink(pid, jot.id, a.surface, a.note);
          await this.bot.askLink(pid, a.surface, a.note);
        }
      }

      await this.writeLine(jot, this.composeLine(jot, textPart));
      await this.repo.updateJot(jot.id, { status: "done", error: null });
      await this.bot.onJotDone(jot.id); // apply anything queued while we were working
    } catch (err) {
      await this.fail(loaded, err);
    }
  }

  /** Record a failure: retry if transient and under the cap, else give up gracefully. */
  private async fail(jot: Jot, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    const attempts = (jot.attempts ?? 0) + 1;
    if (isRecoverable(err) && attempts < MAX_ATTEMPTS) {
      await this.repo.updateJot(jot.id, { status: "failed", attempts, error: msg });
      return;
    }
    // Unrecoverable, or out of tries: post whatever we have un-enriched, then stop.
    const reason = isRecoverable(err) ? `no luck after ${attempts} tries` : "unrecoverable error";
    const source =
      jot.kind === "audio" ? (jot.transcript ?? "🎤 (voice note — transcription failed)") :
      jot.kind === "text" ? (jot.raw_text ?? "") :
      "";
    try {
      await this.writeLine(jot, this.composeLine(jot, source));
    } catch { /* the note write itself is failing — nothing more we can do */ }
    await this.repo.updateJot(jot.id, { status: "abandoned", attempts, error: msg });
    await this.bot.onJotDone(jot.id); // apply edits queued while it was failing
    await this.bot.askRetry(jot.id, `⚠️ Gave up on a ${jot.kind} jot (${reason}). Posted it un-enriched.\n${msg.slice(0, 200)}`);
  }

  private async ensureMedia(jot: Jot): Promise<Jot> {
    if (jot.kind === "text" || !jot.file_id) return jot;
    if (jot.asset_path && (jot.kind !== "audio" || jot.transcript)) return jot;

    const file = await this.bot.downloadFile(jot.file_id);
    const patch: Partial<Jot> = {};
    if (!jot.asset_path) {
      const date = basename(jot.note_path, ".md");
      const name = `${date}_${jot.time.replaceAll(":", "")}_${jot.id}.${file.ext}`;
      patch.asset_path = await this.obsidian.saveAsset(name, file.bytes, file.mime);
    }
    if (jot.kind === "audio" && !jot.transcript) {
      patch.transcript = await this.transcriber.transcribe(file.bytes, file.ext);
    }
    // Captionless image → generate one with vision (used as the embed display).
    if (jot.kind === "image" && !jot.raw_text) {
      patch.raw_text = await this.enricher.describeImage(file.bytes, file.mime);
    }
    await this.repo.updateJot(jot.id, patch);
    return { ...jot, ...patch };
  }

  private composeLine(jot: Jot, textPart: string): string {
    let embed = "";
    if (jot.asset_path) {
      const caption = (jot.kind === "image" || jot.kind === "video") && jot.raw_text;
      embed = caption ? `![[${jot.asset_path}|${jot.raw_text}]]` : `![[${jot.asset_path}]]`;
    }
    const content = [textPart, embed].filter(Boolean).join(" ") || "…";
    return journalLine(jot.time, content, jot.anchor);
  }

  private async writeLine(jot: Jot, line: string): Promise<void> {
    const note = await this.obsidian.readNote(jot.note_path); // live — user may have edited
    const replaced = replaceAnchorLine(note, jot.anchor, line);
    if (replaced) await this.obsidian.writeNote(jot.note_path, replaced);
    else await this.obsidian.appendJournalLine(basename(jot.note_path, ".md"), line);
  }
}
