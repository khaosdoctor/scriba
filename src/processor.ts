import { basename } from "node:path";
import type { Repository, Jot } from "./db.ts";
import type { ObsidianClient } from "./obsidian.ts";
import type { Transcriber } from "./transcribe.ts";
import type { Enricher } from "./enrich.ts";
import type { LinkIndex } from "./index-links.ts";
import { candidates, journalLine, replaceAnchorLine, makeJotId } from "./core.ts";
import { plainDate } from "./time.ts";

export interface DownloadedFile { bytes: Uint8Array; ext: string; mime: string; }

/** What the processor needs from the bot: user-facing I/O it can't do itself. */
export interface BotServices {
  notify: (text: string) => Promise<void>;
  askLink: (pendingId: string, surface: string, note: string) => Promise<void>;
  downloadFile: (fileId: string) => Promise<DownloadedFile>;
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

  /** Forever-retry for failed jots (even days later) + crash recovery for pending. */
  async retrySweep(): Promise<void> {
    for (const jot of await this.repo.pendingJots()) await this.processJot(jot.id);
  }

  async processJot(id: string): Promise<void> {
    const loaded = await this.repo.getJot(id);
    if (!loaded || loaded.status === "done") return;
    try {
      const jot = await this.ensureMedia(loaded);
      // Text/audio carry enrichable text; image/video are attach-only (no agent call).
      const source =
        jot.kind === "audio" ? (jot.transcript ?? "") :
        jot.kind === "text" ? (jot.raw_text ?? "") :
        "";

      let textPart = source;
      if (source.trim()) {
        const [stopwords, rejections] = await Promise.all([this.repo.stopwords(), this.repo.rejections()]);
        const cands = candidates(source, this.links.list(), stopwords, rejections);
        const res = await this.enricher.enrich({ text: source, candidates: cands });
        await this.repo.bumpMetrics(plainDate(), {
          agent_calls: 1, agent_input_tokens: res.usage.input, agent_output_tokens: res.usage.output,
        });
        textPart = res.text;
        for (const a of res.ambiguous) {
          const pid = makeJotId();
          await this.repo.addPendingLink(pid, jot.id, a.surface, a.note);
          await this.bot.askLink(pid, a.surface, a.note);
        }
      }

      await this.writeLine(jot, this.composeLine(jot, textPart));
      await this.repo.updateJot(jot.id, { status: "done", error: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.repo.updateJot(id, { status: "failed", attempts: (loaded.attempts ?? 0) + 1, error: msg });
      if ((loaded.attempts ?? 0) === 0) {
        await this.bot.notify(
          `⚠️ Couldn't process a jot yet (${loaded.kind}). Placeholder is in the note; I'll keep retrying.\n${msg.slice(0, 200)}`,
        );
      }
    }
  }

  private async ensureMedia(jot: Jot): Promise<Jot> {
    if (jot.kind === "text" || !jot.file_id) return jot;
    // Attachments need only the asset; audio also needs a transcript.
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
      await this.repo.bumpMetrics(plainDate(), { groq_calls: 1 });
    }
    // Captionless image → generate one with vision (used as the embed display).
    if (jot.kind === "image" && !jot.raw_text) {
      patch.raw_text = await this.enricher.describeImage(file.bytes, file.mime);
      await this.repo.bumpMetrics(plainDate(), { agent_calls: 1 });
    }
    await this.repo.updateJot(jot.id, patch);
    return { ...jot, ...patch };
  }

  private composeLine(jot: Jot, textPart: string): string {
    let embed = "";
    if (jot.asset_path) {
      // image/video carry the caption as the embed display; audio just embeds.
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
