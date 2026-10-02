import { basename } from "node:path";
import type { JotRepository } from "../data/repositories/jots.ts";
import type { LinkRuleRepository } from "../data/repositories/link-rules.ts";
import type { ObsidianClient } from "../data/repositories/notes.ts";
import type { SettingsRepository } from "../data/repositories/settings.ts";
import type { TaskDraftRepository } from "../data/repositories/task-drafts.ts";
import type { VaultService } from "../data/repositories/vault.ts";
import { type Jot, MAX_ATTEMPTS } from "../domain/jot/entity.ts";
import type { TaskDraft } from "../domain/task/entity.ts";
import type { DetectedTask } from "../domain/task/structures.ts";
import {
  assetEmbed,
  combineEnrichSource,
  doneMessage,
  embedOffer,
  enrichableSource,
  gaveUpMessage,
  heldNotice,
  isRecoverable,
  makeJotId,
  retryNotice,
} from "../libs/jot.ts";
import { candidates, forcedCandidates, linkDateWords } from "../libs/links.ts";
import { logger } from "../libs/log.ts";
import { journalLine } from "../libs/note.ts";
import { draftFromDetection } from "../libs/tasks.ts";
import { escapeHtml, splitEntry } from "../libs/text.ts";
import type { EditService } from "./edits.ts";
import { type Enricher, ModelsDownError } from "./enrich.ts";
import type { JotService } from "./jots.ts";
import type { DownloadedFile } from "./media.ts";
import type { Notifier } from "./notifier.ts";
import type { TaskService } from "./tasks.ts";
import type { Transcriber } from "./transcriber.ts";

const log = logger("processor");
const botLog = logger("bot");

export const HELD = "held: every enrichment model is down";

/** The daily note's date, which is the note file's name. */
const jotDay = (jot: Jot): string => basename(jot.note_path, ".md");

const WEAVING = "✨ Weaving it into your journal…";

const STARTING: Record<Jot["kind"], string> = {
  audio: "🎤 Transcribing your voice note…",
  text: WEAVING,
  image: "🖼️ Saving your image…",
  video: "🎬 Saving your video…",
};

const voiceStatus = (transcript: string, step: string): string =>
  `🎤 <i>${escapeHtml(transcript.trim())}</i>\n\n${step}`;

export interface ProcessingDeps {
  repo: JotRepository;
  settings: SettingsRepository;
  linkRules: LinkRuleRepository;
  taskDrafts: TaskDraftRepository;
  obsidian: ObsidianClient;
  transcriber: Transcriber;
  enricher: Enricher;
  links: VaultService;
  jots: JotService;
  edits: Pick<EditService, "drainQueued">;
  tasks: Pick<TaskService, "suggest">;
  notifier: Pick<Notifier, "send" | "typing">;
  files: { downloadFile(fileId: string): Promise<DownloadedFile> };
}

export class ProcessingService {
  constructor(private deps: ProcessingDeps) {}

  async processBatch(ids: string[]): Promise<void> {
    // ponytail: one agent call per jot. Batching coalesces arrivals + retries;
    // true bulk-in-one-prompt enrichment is a future token optimisation.
    log.info({ count: ids.length, ids }, "processing batch");
    for (const id of ids) await this.processJot(id);
    log.info({ count: ids.length }, "batch complete");
  }

  async retryPass(): Promise<void> {
    const pending = await this.deps.repo.pendingJots();
    if (!pending.length) return log.debug("retry sweep: nothing pending");
    log.info(
      { count: pending.length, ids: pending.map((j) => j.id) },
      "retry sweep",
    );
    for (const jot of pending) await this.processJot(jot.id);
  }

  async processJot(id: string): Promise<void> {
    const loaded = await this.deps.repo.getJot(id);
    if (!loaded) return log.warn({ id }, "processJot: jot not found, skipping");
    // A squashed follower shares its leader's anchor and is folded into the leader's
    // line, so the leader processes it. Defer: unless the leader is gone (deleted), in
    // which case fall through and process this jot standalone (its write appends).
    if (loaded.anchor !== loaded.id) {
      const leader = await this.deps.repo.getJot(loaded.anchor);
      if (leader && leader.status !== "deleted") {
        // Group already finished but this follower lingered (e.g. a crash between the
        // leader's write and marking its followers): reconcile so it doesn't stay pending.
        if (
          (leader.status === "done" || leader.status === "abandoned") &&
          loaded.status !== "done"
        )
          await this.deps.repo.updateJot(loaded.id, {
            status: "done",
            error: null,
          });
        return log.debug(
          { id, leader: loaded.anchor },
          "processJot: squashed follower, deferred to leader",
        );
      }
    }
    if (loaded.kind !== "video" && !this.deps.enricher.available())
      return this.hold(loaded);
    // Atomic claim: only the winner proceeds, so flush + retry passes can't double-process.
    if (!(await this.deps.repo.claim(id)))
      return log.debug({ id }, "processJot: claim lost, another worker has it");
    const t0 = Date.now();
    log.info(
      { id, kind: loaded.kind, attempts: loaded.attempts },
      "processing jot",
    );
    await this.deps.notifier.typing(); // best-effort "typing…" so the user sees work is underway
    await this.deps.jots.status(id, STARTING[loaded.kind]); // live status message, edited in place from here on
    try {
      let jot = await this.ensureMedia(loaded);
      if (jot.kind === "audio" && jot.transcript?.trim()) {
        await this.deps.jots.status(id, voiceStatus(jot.transcript, WEAVING));
      }
      const vfModel = await this.deps.settings.getSetting("voiceFixModel");
      if (
        jot.kind === "audio" &&
        jot.transcript?.trim() &&
        vfModel &&
        (await this.deps.settings.getSetting("fixVoiceTranscript"))
      ) {
        const original = jot.transcript.trim();
        await this.deps.jots.status(
          id,
          voiceStatus(original, "🔧 Checking transcript…"),
        );
        // Voice fix is an optional clean-up: when it can't run, the original goes on
        // to enrichment instead of failing the whole jot. Held on ModelsDownError, like
        // any other step, since enrichment right after would hit the same wall.
        const proposed = await this.deps.enricher
          .fixTranscript(original, vfModel)
          .catch((err: unknown) => {
            if (err instanceof ModelsDownError) throw err;
            log.warn(
              { id, err },
              "voice fix failed — keeping the original transcript",
            );
            return original;
          });
        if (proposed !== original) {
          const choice = await this.deps.jots.awaitVoiceFix(
            id,
            original,
            proposed,
          );
          const winner = choice === "proposed" ? proposed : original;
          jot = { ...jot, transcript: winner };
          await this.deps.repo.updateJot(id, { transcript: winner });
          log.info({ id, choice }, `voice fix: user picked ${choice}`);
        } else {
          log.info({ id }, "voice fix: no change proposed");
        }
        await this.deps.jots.status(id, voiceStatus(jot.transcript!, WEAVING));
      }
      const followers: Jot[] = [];
      for (const f of await this.deps.repo.groupFollowers(jot.id))
        followers.push(await this.ensureMedia(f));
      const merged = followers.length > 0;
      const source = combineEnrichSource(
        [jot, ...followers].map((j) => enrichableSource(j)),
      ); // video is attach-only, so it contributes nothing here
      if (merged)
        log.info(
          { id, followers: followers.map((f) => f.id) },
          `squash: enriching ${followers.length + 1} jots as one line`,
        );

      const maxChars = await this.deps.settings.getSetting("entryMaxChars");
      let textPart = source;
      let detected: TaskDraft[] = [];
      let tilCard = false;
      if (source.trim()) {
        const [stopwords, rejections, registered] = await Promise.all([
          this.deps.linkRules.stopwords(),
          this.deps.linkRules.rejections(),
          this.deps.linkRules.registeredLinks(),
        ]);
        const index = this.deps.links.list();
        if (!index.length)
          log.warn(
            { id },
            "enricher: link index empty (SCRIBA_VAULT_HOST_PATH unset or unreadable) — no wikilinks suggested",
          );
        // Registered (user-forced) pairs win over anything the vault index would also
        // suggest for the same surface+note, so it isn't listed (and judged) twice.
        // JSON-encoded so a surface/note containing a space can't collide with a
        // different pair (plain `${surface} ${note}` concatenation could).
        const pairKey = (c: { surface: string; note: string }) =>
          JSON.stringify([c.surface.toLowerCase(), c.note]);
        const forced = forcedCandidates(source, registered);
        const forcedKeys = new Set(forced.map(pairKey));
        const cands = [
          ...forced,
          ...candidates(source, index, stopwords, rejections).filter(
            (c) => !forcedKeys.has(pairKey(c)),
          ),
        ];
        log.info(
          {
            id,
            indexSize: index.length,
            count: cands.length,
            forced: forced.length,
            stopwords: stopwords.size,
            rejections: rejections.size,
            candidates: cands.map(
              (c) =>
                `"${c.surface}" -> [[${c.note}]]${c.forced ? " (registered)" : ""}`,
            ),
          },
          `enricher: ${cands.length} link candidate(s) (${forced.length} registered) from local index of ${index.length} aliases`,
        );
        log.info(
          { id, chars: source.length, candidates: cands.length },
          "enricher: calling agent",
        );
        const res = await this.deps.enricher.enrich({
          text: source,
          candidates: cands,
          merge: merged,
          splitAt: maxChars,
        });
        textPart = res.text;
        log.info(
          {
            id,
            ambiguous: res.ambiguous.length,
            ambiguousLinks: res.ambiguous.map(
              (a) => `"${a.surface}" -> [[${a.note}]]`,
            ),
            usage: res.usage,
          },
          "enricher: done",
        );
        detected = await this.tasksFrom(res.tasks, jot);
        tilCard = await this.tilWanted(res.til, jot);
        for (const a of res.ambiguous) {
          const pid = makeJotId();
          await this.deps.linkRules.addPendingLink(
            pid,
            jot.id,
            a.surface,
            a.note,
          );
          await this.askLink(pid, a.surface, a.note);
          log.debug(
            { id, pid, surface: a.surface, note: a.note },
            "asked to confirm link",
          );
        }
      } else {
        log.debug(
          { id, kind: jot.kind },
          "no enrichable text (attach-only or empty)",
        );
      }

      const pieces = splitEntry(linkDateWords(textPart, jotDay(jot)), maxChars);
      const linked = pieces[0] ?? "";
      const spillover = pieces
        .slice(1)
        .map((text, i) => this.pieceJot(jot, text, i + 1));
      if (spillover.length)
        log.info(
          { id, maxChars, pieces: spillover.map((p) => p.id) },
          `entry over ${maxChars} chars — split into ${pieces.length} jots`,
        );
      await this.writeLine(
        jot,
        [
          this.composeLine(jot, linked),
          ...spillover.map((p) =>
            journalLine(p.time, p.raw_text ?? "", p.anchor),
          ),
        ].join("\n"),
      );
      // Rows only after the note write: a failed write retries the whole jot, and rows
      // written first would be duplicated by that retry.
      // ponytail: a crash between the write and these inserts leaves the spillover lines
      // in the note with no jot row (uneditable). Sub-millisecond window, local sqlite.
      for (const p of spillover) await this.deps.repo.insertJot(p);
      if (spillover.length && !merged)
        await this.deps.repo.updateJot(jot.id, {
          [jot.kind === "audio" ? "transcript" : "raw_text"]: linked,
        });
      await this.deps.repo.updateJot(jot.id, { status: "done", error: null });
      for (const f of followers)
        await this.deps.repo.updateJot(f.id, { status: "done", error: null });
      // Post-`done` steps are best-effort UI + the queued-edit drain. A transient throw
      // here must NOT route to fail(): that would demote an already-committed `done` jot
      // to `failed`, causing wasted re-enrichment and duplicate link prompts on retry.
      try {
        await this.deps.jots.react(jot.id, "done");
        const of = spillover.length + 1;
        await this.deps.jots.status(
          jot.id,
          doneMessage(
            jot.time,
            jot.kind,
            linked,
            jot.id,
            merged ? followers.length + 1 : 0,
            of > 1 ? { i: 1, of } : undefined,
          ),
          { undo: true, embed: embedOffer(linked) },
        );
        for (const [i, p] of spillover.entries())
          await this.deps.jots.status(
            p.id,
            doneMessage(p.time, p.kind, p.raw_text ?? "", p.id, 0, {
              i: i + 2,
              of,
            }),
            { undo: true, embed: embedOffer(p.raw_text ?? "") },
          );
        // Tasks come after the entry is safely in the note: a card is a question about
        // something already journalled, never a step on the way to journalling it.
        for (const draft of detected)
          await this.deps.tasks.suggest(draft, jot.id, jotDay(jot));
        if (tilCard) await this.deps.jots.askTil(jot.id, linked);
        await this.deps.edits.drainQueued(jot.id); // apply anything queued while we were working
        for (const f of followers) {
          await this.deps.jots.react(f.id, "done");
          await this.deps.jots.deleteStatus(f.id);
          await this.deps.edits.drainQueued(f.id);
        }
      } catch (err) {
        log.error({ id, err }, "post-done side effect failed — jot stays done");
      }
      log.info({ id, ms: Date.now() - t0 }, "jot done");
    } catch (err) {
      await this.fail(loaded, err);
    }
  }

  private async askLink(
    pendingId: string,
    surface: string,
    note: string,
  ): Promise<void> {
    botLog.debug({ pendingId, surface, note }, "asking user to confirm link");
    await this.deps.notifier.send(`Link "${surface}" → [[${note}]]?`, {
      keyboard: {
        inline_keyboard: [
          [
            { text: "Yes", callback_data: `lk:y:${pendingId}` },
            { text: "No", callback_data: `lk:n:${pendingId}` },
          ],
        ],
      },
    });
  }

  private async fail(jot: Jot, err: unknown): Promise<void> {
    if (err instanceof ModelsDownError) {
      await this.deps.repo.updateJot(jot.id, { status: "pending" });
      // Always re-post: the status message says "Weaving…" again after this attempt.
      return this.hold({ ...jot, error: null });
    }
    const msg = err instanceof Error ? err.message : String(err);
    const attempts = (jot.attempts ?? 0) + 1;
    const recoverable = isRecoverable(err);
    if (recoverable && attempts < MAX_ATTEMPTS) {
      log.warn(
        { id: jot.id, attempts, max: MAX_ATTEMPTS, err },
        "jot failed (transient) — will retry",
      );
      await this.deps.repo.updateJot(jot.id, {
        status: "failed",
        attempts,
        error: msg,
      });
      await this.deps.jots.react(jot.id, "retrying");
      await this.say(
        jot.id,
        retryNotice(jot.kind, attempts, MAX_ATTEMPTS, msg),
      );
      return;
    }
    const reason = recoverable
      ? `no luck after ${attempts} tries`
      : "unrecoverable error";
    log.error(
      { id: jot.id, attempts, recoverable, err },
      "jot abandoned — posting un-enriched",
    );
    const followers = await this.deps.repo.groupFollowers(jot.id);
    const source = combineEnrichSource(
      [jot, ...followers].map((j) =>
        enrichableSource(j, "🎤 (voice note — transcription failed)"),
      ),
    );
    try {
      await this.writeLine(
        jot,
        this.composeLine(jot, linkDateWords(source, jotDay(jot))),
      );
    } catch {
      /* the note write itself is failing: nothing more we can do */
    }
    for (const j of [jot, ...followers]) {
      await this.deps.repo.updateJot(j.id, {
        status: "abandoned",
        attempts,
        error: msg,
      });
      await this.deps.jots.react(j.id, "failed");
      if (j.id !== jot.id) await this.deps.jots.deleteStatus(j.id);
      await this.deps.edits.drainQueued(j.id); // apply edits queued while it was failing
    }
    await this.say(
      jot.id,
      gaveUpMessage(
        jot.kind,
        reason,
        msg,
        followers.length > 0 ? followers.length + 1 : 0,
      ),
    );
  }

  private async hold(jot: Jot): Promise<void> {
    if (jot.error === HELD)
      return log.debug({ id: jot.id }, "jot still held, notice already sent");
    log.warn(
      { id: jot.id, kind: jot.kind },
      "every enrichment model is down — jot held until one is back",
    );
    // Marked only once the notice is out, so a failed send is tried again next retry pass.
    // ponytail: a flush and a retry pass reaching the same fresh jot together can both send
    // it (a duplicate notice, nothing lost); a compare-and-swap mark would close that.
    await this.deps.jots
      .status(jot.id, heldNotice(jot.kind), { discard: true })
      .then(() => this.deps.repo.updateJot(jot.id, { error: HELD }))
      .catch((err) =>
        log.warn({ id: jot.id, err }, "could not post the held notice"),
      );
  }

  /** Post a failure on the jot's status message with 🔄 Retry / 🗑 Delete under it. The
   *  send is best-effort: this runs inside the failure path, and a Telegram hiccup here
   *  must not throw out of `fail()` and abandon the rest of the batch. */
  private async say(id: string, html: string): Promise<void> {
    await this.deps.jots
      .status(id, html, { retry: true, discard: true })
      .catch((err) =>
        log.warn({ id, err }, "could not post the failure notice"),
      );
  }

  private async ensureMedia(jot: Jot): Promise<Jot> {
    if (jot.kind === "text" || !jot.file_id) return jot;
    if (jot.kind === "audio" && jot.transcript) return jot; // audio is transcription-only, never attached
    if (jot.asset_path) return jot;

    log.debug(
      { id: jot.id, fileId: jot.file_id },
      "downloading media from telegram",
    );
    const file = await this.deps.files.downloadFile(jot.file_id);
    log.debug(
      { id: jot.id, ext: file.ext, mime: file.mime, bytes: file.bytes.length },
      "media downloaded",
    );
    const patch: Partial<Jot> = {};
    if (jot.kind === "image" || jot.kind === "video") {
      const date = jotDay(jot);
      const name = `${date}_${jot.time.replaceAll(":", "")}_${jot.id}.${file.ext}`;
      patch.asset_path = await this.deps.obsidian.saveAsset(
        name,
        file.bytes,
        file.mime,
      );
      log.info({ id: jot.id, asset: patch.asset_path }, "asset saved to vault");
    }
    if (jot.kind === "audio" && !jot.transcript) {
      log.debug({ id: jot.id }, "transcribing audio");
      patch.transcript = await this.deps.transcriber.transcribe(
        file.bytes,
        file.ext,
      );
      log.info(
        { id: jot.id, chars: patch.transcript.length },
        "audio transcribed",
      );
    }
    if (jot.kind === "image" && !jot.raw_text) {
      log.debug({ id: jot.id }, "captioning image with vision");
      patch.raw_text = await this.deps.enricher.describeImage(
        file.bytes,
        file.mime,
      );
      log.info({ id: jot.id, caption: patch.raw_text }, "image captioned");
    }
    await this.deps.repo.updateJot(jot.id, patch);
    return { ...jot, ...patch };
  }

  private async tasksFrom(
    detected: DetectedTask[],
    jot: Jot,
  ): Promise<TaskDraft[]> {
    if (!detected?.length) return [];
    if (!(await this.deps.settings.getSetting("taskDetection"))) {
      log.debug({ id: jot.id }, "task detection off — suggestions dropped");
      return [];
    }
    if (await this.deps.taskDrafts.taskDraftsForJot(jot.id)) {
      log.info(
        { id: jot.id, tasks: detected.length },
        "task detection: this jot was already asked about — not asking again",
      );
      return [];
    }
    const day = jotDay(jot);
    const drafts = detected
      .map((d) => draftFromDetection(d, day))
      .filter((d) => d.description.trim());
    log.info(
      {
        id: jot.id,
        count: drafts.length,
        tasks: drafts.map((d) => `${d.description} (due ${d.due ?? "?"})`),
      },
      `task detection: ${drafts.length} task(s) found in this jot`,
    );
    return drafts;
  }

  private async tilWanted(sounds: boolean, jot: Jot): Promise<boolean> {
    if (!sounds) return false;
    if (!(await this.deps.settings.getSetting("tilDetection"))) {
      log.debug({ id: jot.id }, "til detection off, no card");
      return false;
    }
    if (jot.section === "til") {
      log.debug({ id: jot.id }, "til detection: already a TIL jot");
      return false;
    }
    if (await this.deps.repo.tilOffered(jot.id)) {
      log.info(
        { id: jot.id },
        "til detection: already asked, not asking again",
      );
      return false;
    }
    log.info({ id: jot.id }, "til detection: this jot sounds like a TIL");
    return true;
  }

  /** A jot for one spillover piece of an over-long entry: a plain text jot, already done
   *  (the text is enriched: it came out of this jot's own enrichment), with an id and
   *  anchor of its own so it edits, undoes and reprocesses independently. Its `received_at`
   *  is nudged past the parent's so the intake order (and any later squash query) still
   *  reads left to right. */
  private pieceJot(jot: Jot, text: string, i: number): Jot {
    const id = makeJotId();
    return {
      ...jot,
      id,
      anchor: id,
      kind: "text",
      raw_text: text,
      transcript: null,
      proposed_text: null,
      asset_path: null, // the media stays on the parent's line, embedded once
      file_id: null,
      status: "done",
      attempts: 0,
      error: null,
      received_at: jot.received_at + i,
      updated_at: Date.now(),
    };
  }

  private composeLine(jot: Jot, textPart: string): string {
    const content =
      [textPart, assetEmbed(jot)].filter(Boolean).join(" ") || "…";
    return journalLine(jot.time, content, jot.anchor);
  }

  private async writeLine(jot: Jot, line: string): Promise<void> {
    // Recreate the daily note if intake never got to it (Obsidian was down at arrival).
    // Idempotent + cached, so it's ~one GET when the note already exists.
    await this.deps.obsidian.ensureDailyNote(jotDay(jot));
    const replaced = await this.deps.obsidian.updateLine(
      jot.note_path,
      jot.anchor,
      (_line, write) => {
        write(line);
        return true;
      },
    );
    if (replaced) {
      log.debug({ id: jot.id, anchor: jot.anchor }, "line replaced in place");
      return;
    }
    // Anchor missing (line hand-deleted, or note recreated). appendJournalLine takes the
    // same lock itself, so it must run after the update above releases it.
    log.warn(
      { id: jot.id, anchor: jot.anchor },
      "anchor missing — appending line instead",
    );
    await this.deps.obsidian.appendJournalLine(jotDay(jot), line, jot.section);
  }
}
