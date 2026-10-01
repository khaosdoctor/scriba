import { type Bot, InlineKeyboard } from "grammy";
import {
  entitiesToMarkdown,
  FOLLOWUP_CODES,
  type FollowupQuestion,
  followupFromCode,
  followupQuestions,
  followupRef,
} from "../core.ts";
import type { Repository } from "../db.ts";
import { logger } from "../log.ts";
import type { Config } from "../models/config.ts";
import { IsoDateSchema } from "../models/settings.ts";
import type { ObsidianClient } from "../services/obsidian.ts";

const log = logger("followup");

/** callback_query namespace this flow owns (see ScribaBot.handleButton). */
export const FOLLOWUP_NS = "fu";

const PROMPTS: Record<FollowupQuestion, string> = {
  journal: "📝 One line for the day?",
  til: "💡 Learned anything today?",
};

/** What the nightly rating leads into: a question for each part of the day's note that is
 *  still empty. No state is held: the prompt's own text says which question and which day it
 *  is (`followupRef`), the note says what is still empty, so an answer works after a restart
 *  and a question that goes unanswered costs nothing.
 *
 *  Both answers become normal jots through `jot`, so placement, anchors, edits and undo work
 *  as for any other. The TIL is a jot prefixed with "TIL:" rather than a bullet under the TIL
 *  heading, since enrichment and the status message belong to the jot pipeline. */
export class FollowupFlow {
  /** Prompts already skipped (`chat:message`), so a double tap asks the next question once.
   *  Forgotten on restart, which only ever loses the guard for a prompt that was live then. */
  private skipped = new Set<string>();

  constructor(
    private bot: Bot,
    private config: Config,
    private repo: Repository,
    private obsidian: ObsidianClient,
    /** Takes `text` as a jot for `date`, replying to the message in `ctx`. */
    private jot: (ctx: any, date: string, text: string) => Promise<void>,
  ) {}

  /** Ask the first question `date`'s note still needs answered, if any. Called right after
   *  the day is rated, unless the follow-up is switched off. */
  async start(date: string): Promise<void> {
    if (!(await this.repo.getSetting("nightlyFollowup"))) {
      log.info({ date }, "follow-up is off, not asking");
      return;
    }
    log.info({ date }, "starting follow-up");
    await this.ask(date);
  }

  /** Ask the next question after `after` (or the first) that the note still needs. */
  private async ask(date: string, after?: FollowupQuestion): Promise<void> {
    const daily = await this.obsidian.readDailyNote(date);
    const [question] = followupQuestions(
      daily?.content ?? null,
      {
        journal: this.config.obsidian.journalHeading,
        til: this.config.obsidian.tilHeading,
      },
      after,
    );
    if (!question) {
      log.info({ date, after }, "follow-up done: nothing left to ask");
      return;
    }
    log.info({ date, question }, "asking follow-up question");
    await this.bot.api.sendMessage(
      this.config.telegram.allowedUserId,
      `${PROMPTS[question]} Reply to this message, or skip.\n${followupRef(question, date)}`,
      {
        reply_markup: new InlineKeyboard().text(
          "⏭ Skip",
          `${FOLLOWUP_NS}:${FOLLOWUP_CODES[question]}:${date}`,
        ),
      },
    );
  }

  /** A reply to a follow-up prompt: the answer becomes a jot, then the next question. */
  async handleReply(
    ctx: any,
    ref: { question: FollowupQuestion; date: string },
  ): Promise<void> {
    const answer = entitiesToMarkdown(
      ctx.message.text,
      ctx.message.entities,
    ).trim();
    log.info({ ...ref }, "follow-up answered");
    await this.jot(
      ctx,
      ref.date,
      ref.question === "til" ? `TIL: ${answer}` : answer,
    );
    await this.drop(ctx.chat.id, ctx.message.reply_to_message.message_id);
    await this.ask(ref.date, ref.question);
  }

  /** The Skip button on a prompt: take the question away and move on. */
  async handleTap(ctx: any, code?: string, date?: string): Promise<void> {
    const question = followupFromCode(code);
    if (!question || !date || !IsoDateSchema.safeParse(date).success) {
      log.warn({ code, date }, "follow-up tap rejected: bad payload");
      return void ctx.answerCallbackQuery({ text: "bad follow-up" });
    }
    const message = ctx.callbackQuery?.message;
    if (!message) {
      log.warn({ date, question }, "follow-up tap: prompt message is gone");
      return void ctx.answerCallbackQuery();
    }
    // Claimed before the first await, so a double tap can't ask the next question twice.
    const key = `${ctx.chat.id}:${message.message_id}`;
    if (this.skipped.has(key)) {
      log.info({ date, question }, "follow-up tap ignored: already skipped");
      return void ctx.answerCallbackQuery();
    }
    this.skipped.add(key);
    log.info({ date, question }, "follow-up skipped");
    await ctx.answerCallbackQuery();
    await this.drop(ctx.chat.id, message.message_id);
    await this.ask(date, question);
  }

  /** A question is scaffolding: once it is answered or skipped it leaves the chat. */
  private async drop(chatId: number, messageId: number): Promise<void> {
    await this.bot.api.deleteMessage(chatId, messageId).catch(() => {});
  }
}
