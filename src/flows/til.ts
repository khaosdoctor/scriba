import { type Bot, InlineKeyboard } from "grammy";
import { config } from "../config.ts";
import { clipUpdate, escapeHtml } from "../core.ts";
import type { Repository } from "../db.ts";
import { logger } from "../log.ts";
import type { ObsidianClient } from "../services/obsidian.ts";

const log = logger("til-flow");

/** Cap on the quoted jot. Escaping can grow a character to five, so this keeps the card
 *  well inside Telegram's 4096 whatever the jot holds. */
const QUOTE_CHARS = 600;

/** callback_query namespace this flow owns (see ScribaBot.handleButton). */
export const TIL_NS = "ti";

/**
 * "Move this to TIL?": a card for a jot the enricher read as something the owner learned.
 * The jot is already in the journal; accepting moves its line under the TIL heading of the
 * same note, keeping the anchor so edit, undo and reprocess still find it. The jot id is
 * all the card needs to carry, so there is no draft to store.
 */
export class TilFlow {
  constructor(
    private bot: Bot,
    private repo: Repository,
    private obsidian: ObsidianClient,
  ) {}

  async ask(jotId: string, text: string): Promise<void> {
    const kb = new InlineKeyboard()
      .text("✅ Move to TIL", `${TIL_NS}:y:${jotId}`)
      .text("🚫 Keep in Journal", `${TIL_NS}:n:${jotId}`);
    const sent = await this.bot.api
      .sendMessage(
        config.telegram.allowedUserId,
        `💡 That sounds like a TIL. Move this to TIL?\n<blockquote>${escapeHtml(clipUpdate(text, QUOTE_CHARS))}</blockquote>`,
        { parse_mode: "HTML", reply_markup: kb },
      )
      .catch((err) => {
        log.error({ err, jotId }, "til card failed to send");
        return null;
      });
    // Marked only once the card is out, so a failed send leaves the offer for a reprocess.
    if (!sent) return;
    await this.repo.markTilOffered(jotId);
    log.info({ jotId }, "til card sent");
  }

  async handleTap(ctx: any, [action, jotId]: string[]): Promise<void> {
    const jot = jotId ? await this.repo.getJot(jotId) : undefined;
    if (!jot || jot.status === "deleted") {
      log.warn({ jotId }, "til card: jot is gone");
      await ctx.answerCallbackQuery({ text: "gone" });
      return this.settle(ctx, "That jot is gone.");
    }
    if (action !== "y") {
      log.info({ jotId }, "til declined, kept in the journal");
      await ctx.answerCallbackQuery({ text: "kept in the journal" });
      return this.settle(ctx, "🚫 Kept in the journal.");
    }
    const moved = await this.obsidian
      .moveToTil(jot.note_path, jot.anchor)
      .catch((err: unknown) => {
        log.error({ err, jotId }, "til move failed, line left in the journal");
        return null;
      });
    // The card keeps its buttons: a reprocess never asks again, so another tap is the retry.
    if (moved === null)
      return void (await ctx.answerCallbackQuery({
        text: "couldn't move it, tap again to retry",
        show_alert: true,
      }));
    if (moved === "no-line") {
      log.warn({ jotId }, "til accepted but the line is no longer in the note");
      await ctx.answerCallbackQuery({ text: "couldn't find the line" });
      return this.settle(ctx, "⚠️ That line is gone from the note.");
    }
    if (moved === "no-heading") {
      log.warn({ jotId }, "til accepted but the note has no TIL heading");
      await ctx.answerCallbackQuery({ text: "no TIL heading" });
      return this.settle(
        ctx,
        "⚠️ That note has no TIL heading, so the line stays in the journal.",
      );
    }
    // The section decides which heading a re-written line goes back under, so it follows
    // the line: the leader's, and every squashed follower sharing it.
    const followers = await this.repo.groupFollowers(jot.id);
    for (const j of [jot, ...followers])
      await this.repo.updateJot(j.id, { section: "til" });
    log.info({ jotId }, "til accepted, line moved");
    await ctx.answerCallbackQuery({ text: "moved to TIL" });
    await this.settle(ctx, "💡 Moved to TIL.");
  }

  /** Final word on a card: no buttons, so it can't be answered twice. */
  private async settle(ctx: any, text: string): Promise<void> {
    await ctx
      .editMessageText(text, { reply_markup: new InlineKeyboard() })
      .catch((err: unknown) => log.warn({ err }, "til card settle failed"));
  }
}
