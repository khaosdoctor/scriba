import type { JotRepository } from "../data/repositories/jots.ts";
import type { LinkRuleRepository } from "../data/repositories/link-rules.ts";
import type { ObsidianClient } from "../data/repositories/notes.ts";
import type { SettingsRepository } from "../data/repositories/settings.ts";
import type { Jot } from "../domain/jot/entity.ts";
import {
  editedJotText,
  enrichableSource,
  entryContent,
  isEditableJot,
  isFollower,
  isReprocessable,
  journalLine,
  sourceField,
  stripJournalLine,
} from "../domain/jot/rules.ts";
import type { EditInput } from "../domain/jot/structures.ts";
import {
  editConfirmation,
  embedOffer,
  parseLiteralEdit,
  type StatusButtons,
  setEmbeds,
} from "../libs/jot.ts";
import { keyboard } from "../libs/keyboard.ts";
import { unlinkWikilinks } from "../libs/links.ts";
import { logger } from "../libs/log.ts";
import { anchorLine, deleteAnchorLine } from "../libs/note.ts";
import type { FlushQueue } from "../libs/queue.ts";
import { clipUpdate, errorText, escapeHtml, shortId } from "../libs/text.ts";
import type { Enricher } from "./enrich.ts";
import type { JotService } from "./jots.ts";
import type { Notifier } from "./notifier.ts";

const log = logger("bot");

export const LINK_NS = "lk";

const LINE_NOT_FOUND = "Couldn't find that line in the note.";

/** Cap on the fixed text quoted back by /fix, so the reply fits Telegram. */
const FIXED_CHARS = 1500;

export interface EditDeps {
  repo: JotRepository;
  linkRules: LinkRuleRepository;
  settings: Pick<SettingsRepository, "getSetting">;
  obsidian: ObsidianClient;
  enricher: Pick<Enricher, "editText" | "fixTranscript">;
  jots: Pick<JotService, "status" | "leaderOf" | "deleteStatus">;
  notifier: Pick<Notifier, "send">;
  queue: Pick<FlushQueue, "add">;
}

export type EditOutcome =
  | "unmapped"
  | "missing"
  | "queued"
  | "removal-queued"
  | "applied";

type EmbedOutcome = "gone" | "no-line" | { confirm: () => Promise<void> };

/** A removal a tap may run: `now` is the teardown, handed back so the view can answer the
 *  tap before the vault write (the note lock can outlast Telegram's callback window), and
 *  resolves to the confirmation text. */
type Removal = { now: () => Promise<string> };

type LinkOutcome =
  | "expired"
  | {
      verdict: "rejected" | "linked" | "unchanged";
      surface: string;
      note: string;
    };

type QueuedEdit = {
  edit: string;
  outcome: "queued" | "removal-queued";
  fields?: Record<string, unknown>;
};

export class EditService {
  constructor(private deps: EditDeps) {}

  async editByReply(
    messageId: number,
    instruction: string,
  ): Promise<EditOutcome> {
    const { repo } = this.deps;
    const jot = await this.editOrQueue(messageId, () => ({
      edit: instruction,
      outcome: "queued",
    }));
    if (typeof jot === "string") return jot;
    const jotId = jot.id;
    log.info({ jotId, instruction }, "applying edit");
    const applied = await this.applyEdits(jot, [instruction]);
    // A freeform instruction can itself be "delete this", so only offer Undo when the
    // entry is actually still in the journal.
    const after = await repo.getJot(jotId);
    const done = after?.status === "done";
    await this.showFinished(jot, applied, done);
    return "applied";
  }

  /** A natively edited message or caption replaces its jot's text. Clearing the message to
   *  empty is the delete gesture (Telegram never delivers an actual message delete), so a
   *  blank edit removes the journal line instead of replacing it. */
  async editByMessageEdit({
    messageId,
    text,
  }: EditInput): Promise<EditOutcome> {
    const { jots } = this.deps;
    const edited = (jot: Jot) => {
      const markdown = editedJotText(jot.section, text);
      return { markdown, blank: markdown.trim().length === 0 };
    };
    const jot = await this.editOrQueue(messageId, (jot) => {
      const { markdown, blank } = edited(jot);
      // "delete" is the instruction applyEdits recognises when drainQueued runs, so an
      // in-flight jot is deleted the moment its line is first written.
      return {
        edit: blank ? "delete" : markdown,
        outcome: blank ? "removal-queued" : "queued",
        fields: { blank },
      };
    });
    if (typeof jot === "string") return jot;
    const jotId = jot.id;
    const { markdown, blank } = edited(jot);
    if (blank) {
      log.info({ jotId }, "edited message cleared — removing journal line");
      await jots.status(jotId, "🗑️ got it — removing…");
      await jots.status(jotId, await this.deleteJot(jot));
      return "applied";
    }
    log.info({ jotId, text: markdown }, "applying edit to processed jot");
    await jots.status(jotId, "✍️ got your edit — applying…");
    await this.showFinished(jot, await this.replaceJotText(jot, markdown));
    return "applied";
  }

  async deleteByReply(messageId: number): Promise<EditOutcome> {
    const jot = await this.editOrQueue(
      messageId,
      () => ({ edit: "delete", outcome: "removal-queued" }),
      true,
    );
    if (typeof jot === "string") return jot;
    log.info({ jotId: jot.id }, "delete command — removing journal line");
    await this.deps.jots.status(jot.id, await this.deleteJot(jot));
    return "applied";
  }

  /** ↩️ Undo on a finished jot's status message. The button stays tappable on old
   *  messages, so only a jot whose line is in the note (done or abandoned) is removed; one
   *  sent back for processing since has lost the state that earned the button. */
  async undo(jot: Jot): Promise<"stale" | Removal> {
    const target = await this.deps.jots.leaderOf(jot);
    if (isEditableJot(target.status)) return this.removal(target);
    log.warn(
      { jotId: target.id, tapped: jot.id, status: target.status },
      "undo refused: jot is no longer in the note",
    );
    return "stale";
  }

  /** 🗑 Delete on a failed jot's status message, or from the jots browser. The line, or a
   *  failed jot's placeholder, goes now; a jot still processing gets the delete queued like
   *  a /delete reply, so the processor cannot write the line back after it. */
  async discard(jot: Jot): Promise<"removal-queued" | Removal> {
    const target = await this.deps.jots.leaderOf(jot);
    if (isEditableJot(target.status) || target.status === "failed")
      return this.removal(target);
    log.info(
      { jotId: target.id, tapped: jot.id, status: target.status },
      "delete queued (jot still processing)",
    );
    await this.deps.repo.queueEdit(target.id, "delete");
    return "removal-queued";
  }

  private removal(target: Jot): Removal {
    return {
      now: async () => {
        const text = await this.deleteJot(target);
        await this.deps.jots.status(target.id, text);
        return text;
      },
    };
  }

  /** 📝 Use original: put the raw transcript back and reprocess from it. The pieces split
   *  off the fixed text go first, since the reprocess splits the original afresh. */
  async useOriginal(jotId?: string): Promise<"gone" | "busy" | "queued"> {
    const { repo, queue } = this.deps;
    const jot = jotId ? await repo.getJot(jotId) : undefined;
    if (!jot?.original_transcript) {
      log.warn({ jotId }, "use original: no kept transcript");
      return "gone";
    }
    if (!isReprocessable(jot.status)) {
      log.warn({ jotId, status: jot.status }, "use original: jot is busy");
      return "busy";
    }
    await this.dropPieces(jot);
    await repo.updateJot(jot.id, {
      [sourceField(jot.kind)]: jot.original_transcript,
    });
    const reset = await repo.resetForReprocess([jot.id]);
    if (!reset.length) return "busy";
    queue.add(reset);
    log.info({ jotId }, "use original: reprocessing from the raw transcript");
    return "queued";
  }

  /** /fix: run the transcript clean-up again over a jot's whole entry (a piece resolves to
   *  the jot it was split from, and the pieces are folded back in), tell the owner what it
   *  became, and reprocess from the fixed text. The text before the fix is kept for
   *  📝 Use original. Runs in the background, so it reports through the notifier and
   *  never throws. */
  async refix(jotId: string): Promise<void> {
    const { notifier } = this.deps;
    try {
      await notifier.send(await this.refixReply(jotId), { html: true });
    } catch (err) {
      log.error({ jotId, err }, "fix: failed");
      await notifier
        .send(`🔧 Couldn't fix ${jotId}: ${escapeHtml(errorText(err))}`, {
          html: true,
        })
        .catch((sendErr: unknown) =>
          log.error({ jotId, err: sendErr }, "fix: failure notice not sent"),
        );
    }
  }

  private async refixReply(jotId: string): Promise<string> {
    const { repo, settings, enricher, queue, obsidian } = this.deps;
    const target = await this.fixTarget(jotId);
    if (!target) return `Jot ${jotId} not found.`;
    if (target.kind !== "audio" && target.kind !== "text")
      return `Jot ${target.id} has no text to fix.`;
    if (isFollower(target) || (await repo.groupFollowers(target.id)).length > 0)
      return `Jot ${target.id} is part of a squashed entry, so there's no single text to fix.`;
    if (!isReprocessable(target.status))
      return `Jot ${target.id} is still processing. Try again once it's done.`;
    const model = await settings.getSetting("voiceFixModel");
    if (!model) return "No voice-fix model is set. Pick one in /menu.";
    // The note's order, not received_at: a jot split twice has pieces sharing an offset.
    const note = await obsidian.readNote(target.note_path);
    const pieces = (await repo.piecesOf(target.id)).sort(
      (first, second) =>
        note.indexOf(`^${first.anchor}`) - note.indexOf(`^${second.anchor}`),
    );
    const source = unlinkWikilinks(
      [
        enrichableSource(target),
        ...pieces.map((piece) => piece.raw_text ?? ""),
      ].join(" "),
    ).trim();
    if (!source) return `Jot ${target.id} has no text to fix.`;
    log.info(
      { jotId: target.id, pieces: pieces.length, chars: source.length },
      "fix: running the transcript fix again",
    );
    const fixed = (await enricher.fixTranscript(source, model)).trim();
    if (fixed === source) {
      log.info({ jotId: target.id }, "fix: nothing to change");
      return `🔧 Nothing to fix in ${target.id}, the text is already clean.`;
    }
    await this.dropPieces(target);
    await repo.updateJot(target.id, {
      [sourceField(target.kind)]: fixed,
      original_transcript: source,
    });
    const reset = await repo.resetForReprocess([target.id]);
    if (!reset.length)
      return `Jot ${target.id} is still processing. Try again once it's done.`;
    queue.add(reset);
    log.info({ jotId: target.id }, "fix: reprocessing from the fixed text");
    return `🔧 Fixed text for <code>${target.id}</code>:\n<blockquote expandable>${escapeHtml(clipUpdate(fixed, FIXED_CHARS))}</blockquote>\nReprocessing it now. 📝 Use original on the finished message puts the old text back.`;
  }

  /** The jot a /fix acts on: a split piece stands for the jot it was cut from. */
  private async fixTarget(jotId: string): Promise<Jot | undefined> {
    const { repo } = this.deps;
    const jot = await repo.getJot(jotId);
    if (!jot || jot.status === "deleted") return undefined;
    if (!jot.parent_id) return jot;
    const parent = await repo.getJot(jot.parent_id);
    return parent && parent.status !== "deleted" ? parent : jot;
  }

  /** Takes out the pieces a split cut off a jot, ahead of a reprocess that splits anew. */
  private async dropPieces(jot: Jot): Promise<void> {
    for (const piece of await this.deps.repo.piecesOf(jot.id)) {
      await this.deleteJot(piece);
      await this.deps.jots.deleteStatus(piece.id);
    }
  }

  async toggleEmbed(
    jotId: string | undefined,
    embed: boolean,
  ): Promise<EmbedOutcome> {
    const { repo, obsidian, jots } = this.deps;
    const jot = jotId ? await repo.getJot(jotId) : undefined;
    if (!jot || jot.status !== "done") {
      log.warn({ jotId, status: jot?.status }, "embed: jot not editable");
      return "gone";
    }
    const text = await obsidian.updateLine(
      jot.note_path,
      jot.anchor,
      (line, write) => {
        const next = setEmbeds(stripJournalLine(line, jot.time), embed);
        write(journalLine(jot.time, next, jot.anchor, jot.section));
        return next;
      },
    );
    if (text === null) {
      log.warn({ jotId }, "embed: anchored line not found");
      return "no-line";
    }
    log.info({ jotId, embed }, "embed toggled");
    return {
      confirm: async () => {
        await this.syncEditedSource(jot, text);
        await jots.status(jot.id, editConfirmation(jot.time, text), {
          undo: true,
          embed: embedOffer(text),
        });
      },
    };
  }

  async askLink(jotId: string, surface: string, note: string): Promise<string> {
    const pendingId = shortId();
    await this.deps.linkRules.addPendingLink(pendingId, jotId, surface, note);
    log.debug({ pendingId, surface, note }, "asking user to confirm link");
    await this.deps.notifier.send(`Link "${surface}" → [[${note}]]?`, {
      keyboard: keyboard([
        [
          ["Yes", `${LINK_NS}:y:${pendingId}`],
          ["No", `${LINK_NS}:n:${pendingId}`],
        ],
      ]),
    });
    return pendingId;
  }

  async confirmLink(pendingId: string, accept: boolean): Promise<LinkOutcome> {
    const { repo, obsidian, linkRules } = this.deps;
    const rec = await linkRules.takePendingLink(pendingId);
    if (!rec) return "expired";
    const { surface, note } = rec;
    if (!accept) {
      log.info({ surface, note }, "link rejected — learning it");
      await linkRules.reject(surface, note);
      return { verdict: "rejected", surface, note };
    }
    const jot = await repo.getJot(rec.jot_id);
    const applied =
      jot !== undefined &&
      (await obsidian.updateLine(jot.note_path, jot.anchor, (line, write) => {
        const linked = line.replace(surface, `[[${note}|${surface}]]`);
        write(linked);
        return linked !== line;
      })) === true;
    log.info({ surface, note, applied }, "link confirmation handled");
    return { verdict: applied ? "linked" : "unchanged", surface, note };
  }

  async drainQueued(jotId: string): Promise<void> {
    const { repo } = this.deps;
    const edits = await repo.queuedEdits(jotId);
    if (!edits.length) return;
    const jot = await repo.getJot(jotId);
    if (!jot) return;
    log.info(
      { jotId, count: edits.length },
      "applying edits queued during processing",
    );
    const confirmation = await this.applyEdits(jot, edits);
    await repo.clearQueuedEdits(jotId); // clear only after apply succeeds, so a throw doesn't lose them
    await this.showFinished(
      jot,
      `${confirmation}\n(applied ${edits.length} queued edit${edits.length > 1 ? "s" : ""})`,
    );
  }

  async deleteJot(jot: Jot): Promise<string> {
    const { repo, obsidian } = this.deps;
    const out = await obsidian.updateNote(jot.note_path, (note, write) => {
      const removed = deleteAnchorLine(note, jot.anchor);
      if (removed !== null) write(removed);
      return removed;
    });
    // Line already gone (double delete, or removed by hand in Obsidian)? Still mark it
    // deleted so the record matches reality.
    if (out === null)
      log.warn(
        { jotId: jot.id, anchor: jot.anchor },
        "delete: anchored line not found — marking deleted anyway",
      );
    await repo.markDeleted(jot.id);
    // A squashed line is several jots sharing one anchor, so removing it takes the
    // followers' text with it: mark them deleted too.
    for (const follower of await repo.groupFollowers(jot.id))
      await repo.markDeleted(follower.id);
    if (out !== null) log.info({ jotId: jot.id }, "journal line deleted");
    return "🗑️ removed that from your journal.";
  }

  private async editOrQueue(
    messageId: number,
    queued: (jot: Jot) => QueuedEdit,
    warnMisses = false,
  ): Promise<Jot | EditOutcome> {
    const { repo } = this.deps;
    const jotId = await repo.jotForMessage(messageId);
    if (!jotId) {
      if (warnMisses)
        log.warn({ messageId }, "delete: no jot for that message");
      return "unmapped";
    }
    const jot = await repo.getJot(jotId);
    if (!jot) {
      if (warnMisses) log.warn({ jotId }, "delete: jot not found");
      return "missing";
    }
    if (isEditableJot(jot.status)) return jot;
    const { edit, outcome, fields } = queued(jot);
    log.info(
      { jotId, status: jot.status, ...fields },
      `${outcome === "removal-queued" ? "delete" : "edit"} queued (jot still processing)`,
    );
    await repo.queueEdit(jotId, edit);
    return outcome;
  }

  private async showFinished(
    jot: Jot,
    text: string,
    undo = true,
  ): Promise<void> {
    await this.deps.jots.status(jot.id, text, {
      undo,
      embed: undo ? await this.embedFor(jot) : undefined,
    });
  }

  private async embedFor(jot: Jot): Promise<StatusButtons["embed"]> {
    const note = await this.deps.obsidian.readNote(jot.note_path);
    const line = anchorLine(note, jot.anchor);
    return line ? embedOffer(stripJournalLine(line, jot.time)) : undefined;
  }

  private async applyEdits(jot: Jot, instructions: string[]): Promise<string> {
    // deleteJot takes the note lock itself, so it must run before the lock below.
    if (instructions.some((item) => item.trim().toLowerCase() === "delete"))
      return this.deleteJot(jot);
    const result = await this.deps.obsidian.updateLine(
      jot.note_path,
      jot.anchor,
      async (line, write) => {
        let text = stripJournalLine(line, jot.time);
        const freeform: string[] = [];
        for (const ins of instructions) {
          const lit = parseLiteralEdit(ins);
          if (!lit) {
            freeform.push(ins);
            continue;
          }
          text = text.replaceAll(lit.old, lit.new);
        }
        if (freeform.length)
          text = await this.deps.enricher.editText(
            text,
            freeform.join("; then "),
          );
        write(journalLine(jot.time, text, jot.anchor, jot.section));
        return text;
      },
    );
    if (result === null) return LINE_NOT_FOUND;
    await this.syncEditedSource(jot, result);
    return editConfirmation(jot.time, result);
  }

  /** Replace a jot's whole text (an edited message, not an instruction). The new text is
   *  only the message's text or caption, so a media jot's embed is re-appended: editing an
   *  image's caption must not drop the image out of the note. */
  private async replaceJotText(jot: Jot, newText: string): Promise<string> {
    const content = entryContent(jot, newText);
    const found = await this.deps.obsidian.updateLine(
      jot.note_path,
      jot.anchor,
      (_line, write) => {
        write(journalLine(jot.time, content, jot.anchor, jot.section));
        return true;
      },
    );
    if (!found) return LINE_NOT_FOUND;
    await this.syncEditedSource(jot, newText);
    return editConfirmation(jot.time, newText);
  }

  private async syncEditedSource(jot: Jot, text: string): Promise<void> {
    if (jot.kind !== "audio" && jot.kind !== "text") return;
    if (isFollower(jot)) return;
    if ((await this.deps.repo.groupFollowers(jot.id)).length > 0) return;
    const field = sourceField(jot.kind);
    await this.deps.repo.updateJot(jot.id, { [field]: text });
    log.info(
      { jotId: jot.id, field },
      "edit folded back into jot source for future reprocessing",
    );
  }
}
