import type { JotRepository } from "../data/repositories/jots.ts";
import type { LinkRuleRepository } from "../data/repositories/link-rules.ts";
import type { ObsidianClient } from "../data/repositories/notes.ts";
import type { Jot } from "../domain/jot/entity.ts";
import {
  editedJotText,
  entryContent,
  isEditableJot,
  isFollower,
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
import { logger } from "../libs/log.ts";
import { anchorLine, deleteAnchorLine } from "../libs/note.ts";
import { shortId } from "../libs/text.ts";
import type { Enricher } from "./enrich.ts";
import type { JotService } from "./jots.ts";
import type { Notifier } from "./notifier.ts";

const log = logger("bot");

export const LINK_NS = "lk";

export interface EditDeps {
  repo: JotRepository;
  linkRules: LinkRuleRepository;
  obsidian: ObsidianClient;
  enricher: Pick<Enricher, "editText">;
  jots: Pick<JotService, "status" | "leaderOf">;
  notifier: Pick<Notifier, "send">;
}

export type EditOutcome =
  | "unmapped"
  | "missing"
  | "queued"
  | "removal-queued"
  | "applied";

export type EmbedOutcome =
  | "gone"
  | "no-line"
  | { confirm: () => Promise<void> };

/** A removal a tap may run: `now` is the teardown, handed back so the view can answer the
 *  tap before the vault write (the note lock can outlast Telegram's callback window), and
 *  resolves to the confirmation text. */
export type Removal = { now: () => Promise<string> };

export type LinkOutcome =
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
    const { repo, jots } = this.deps;
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
    await jots.status(jotId, applied, {
      undo: done,
      embed: done ? await this.embedFor(jot) : undefined,
    });
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
    await jots.status(jotId, await this.replaceJotText(jot, markdown), {
      undo: true,
      embed: await this.embedFor(jot),
    });
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
        write(journalLine(jot.time, next, jot.anchor));
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
    const { repo, jots } = this.deps;
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
    await jots.status(
      jotId,
      `${confirmation}\n(applied ${edits.length} queued edit${edits.length > 1 ? "s" : ""})`,
      { undo: true, embed: await this.embedFor(jot) },
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
        write(journalLine(jot.time, text, jot.anchor));
        return text;
      },
    );
    if (result === null) return "Couldn't find that line in the note.";
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
        write(journalLine(jot.time, content, jot.anchor));
        return true;
      },
    );
    if (!found) return "Couldn't find that line in the note.";
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
