import { type Bot, InlineKeyboard } from "grammy";
import { config } from "../config.ts";
import {
  jotPreview,
  monthGrid,
  pluralize,
  reprocessTargets,
  STATUS_ICON,
} from "../core.ts";
import { type JotStatus, type Repository, TERMINAL_STATUSES } from "../db.ts";
import { logger } from "../log.ts";
import { IsoDateSchema } from "../models/settings.ts";
import type { FlushQueue } from "../runtime/queue.ts";
import { dayBounds, plainDate } from "../time.ts";
import { closeMessage } from "../views/chat.ts";
import { backTo, pagedScreen, withClose } from "../views/render/keyboard.ts";

const log = logger("reprocess");

/** callback_query namespace this command owns (see ScribaBot.handleButton). */
export const REPROCESS_NS = "rp";

const CLOSE = `${REPROCESS_NS}:close`;
const ROOT = `${REPROCESS_NS}:root`;
const ROOT_TEXT = "🔁 Reprocess — choose scope:";
const JOT_PAGE = 8;

const pad = (n: string | number) => String(n).padStart(2, "0");
const ymd = (y?: string, m?: string, d?: string) =>
  `${y}-${pad(m ?? "")}-${pad(d ?? "")}`;
const back = () => ({ reply_markup: backTo(ROOT, CLOSE) });

/** Both ends validated, a backwards pair swapped, as the epoch window covering whole days. */
function span(a: string, b: string) {
  if (!IsoDateSchema.safeParse(a).success) return undefined;
  if (!IsoDateSchema.safeParse(b).success) return undefined;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return { lo, hi, from: dayBounds(lo)[0], to: dayBounds(hi)[1] };
}

/** The interactive /reprocess flow: rerun enrichment for jots already saved, replacing
 *  their journal line in place (reset to pending, then the normal queue/processor picks
 *  it up). Entry points: one day or a date range (calendar picker), or one jot (paged
 *  list). A squashed follower always resolves to its leader's id, since the leader
 *  carries the combined line. */
export class ReprocessCommand {
  private queue?: FlushQueue;

  constructor(
    private bot: Bot,
    private repo: Repository,
  ) {}

  /** Wired after construction: the queue doesn't exist yet when ScribaBot builds this. */
  setQueue(queue: FlushQueue): void {
    this.queue = queue;
  }

  register(): void {
    this.bot.command("reprocess", async (ctx) => {
      log.info("reprocess menu opened");
      await ctx.reply(ROOT_TEXT, {
        reply_markup: withClose(this.rootMenu(), CLOSE),
      });
    });
  }

  /** Post a fresh scope-picker message for /menu's "Reprocess" entry, which can't edit
   *  its own message into this multi-step flow. */
  async promptRoot(): Promise<void> {
    log.info("reprocess menu opened (via /menu)");
    await this.bot.api.sendMessage(config.telegram.allowedUserId, ROOT_TEXT, {
      reply_markup: withClose(this.rootMenu(), CLOSE),
    });
  }

  private rootMenu(): InlineKeyboard {
    return new InlineKeyboard()
      .text("📅 One day", `${REPROCESS_NS}:day`)
      .row()
      .text("📆 Date range", `${REPROCESS_NS}:range`)
      .row()
      .text("✉️ One jot", `${REPROCESS_NS}:jot:0`);
  }

  /** Dispatch a `rp:<action>[:<args>]` callback. */
  async handleTap(ctx: any, rest: string[]): Promise<void> {
    const [action, ...args] = rest;
    switch (action) {
      case "root":
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(ROOT_TEXT, {
          reply_markup: withClose(this.rootMenu(), CLOSE),
        });
        return;
      case "noop":
        return void ctx.answerCallbackQuery();
      case "day":
        if (args.length >= 3) {
          const date = ymd(args[0], args[1], args[2]);
          return this.confirmRange(ctx, date, date, true);
        }
        return this.calendar(
          ctx,
          `${REPROCESS_NS}:day`,
          "📅 Pick a day to reprocess",
          args[0],
          args[1],
        );
      case "range":
        return args.length >= 3
          ? this.pickRangeStart(ctx, args)
          : this.calendar(
              ctx,
              `${REPROCESS_NS}:range`,
              "📆 Pick the range start",
              args[0],
              args[1],
            );
      case "rangeend":
        return args.length >= 4
          ? this.confirmRange(
              ctx,
              args[0] ?? "",
              ymd(args[1], args[2], args[3]),
              false,
            )
          : this.renderRangeEndCalendar(ctx, args);
      case "jot":
        // A crafted or stale button can carry a negative page.
        return this.showJotPage(ctx, Math.max(0, Number(args[0]) || 0));
      case "jotpick":
        return this.confirmJot(ctx, args[0]);
      case "go":
        return this.execute(ctx, args);
      case "cancel":
      case "close":
        await ctx.answerCallbackQuery();
        return closeMessage(ctx, "Cancelled.").catch(() => {});
      default:
        log.warn({ action }, "reprocess: unknown action");
        await ctx.answerCallbackQuery();
    }
  }

  /** Year/month callback args, falling back to the current month for anything missing or
   *  outside range. A NaN month would make monthGrid throw, and a 0-99 year hits JS
   *  Date's 1900-relative special case. */
  private parseYearMonth(
    y?: string,
    m?: string,
  ): { year: number; month: number } {
    const now = new Date();
    const year = Number(y);
    const month = Number(m);
    return {
      year:
        Number.isInteger(year) && year >= 1000 && year <= 9999
          ? year
          : now.getFullYear(),
      month:
        Number.isInteger(month) && month >= 1 && month <= 12
          ? month
          : now.getMonth() + 1,
    };
  }

  /** Month calendar for the year/month args. `prefix` is the callback data a day tap and
   *  a month-nav tap extend, so the range-end picker can carry the range start along. */
  private async calendar(
    ctx: any,
    prefix: string,
    lead: string,
    y?: string,
    m?: string,
  ): Promise<void> {
    await ctx.answerCallbackQuery();
    const { year, month } = this.parseYearMonth(y, m);
    const nav = (monthIndex: number) => {
      const d = new Date(year, monthIndex, 1);
      return `${prefix}:${d.getFullYear()}:${d.getMonth() + 1}`;
    };
    const kb = new InlineKeyboard();
    for (const label of ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"])
      kb.text(label, `${REPROCESS_NS}:noop`);
    kb.row();
    for (const week of monthGrid(year, month)) {
      for (const day of week) {
        if (day === 0) kb.text(" ", `${REPROCESS_NS}:noop`);
        else kb.text(String(day), `${prefix}:${year}:${month}:${day}`);
      }
      kb.row();
    }
    kb.text("‹", nav(month - 2))
      .text("›", nav(month))
      .row();
    kb.text("‹ Back", ROOT);
    const label = new Date(year, month - 1, 1).toLocaleString("en-US", {
      month: "short",
      year: "numeric",
    });
    await ctx.editMessageText(`${lead} (${label}):`, {
      reply_markup: withClose(kb, CLOSE),
    });
  }

  private rejectDate(ctx: any, ...dates: string[]): void {
    log.warn({ dates }, "reprocess: tap rejected: bad date");
    return void ctx.answerCallbackQuery({ text: "bad date" });
  }

  private async pickRangeStart(ctx: any, args: string[]): Promise<void> {
    const [y, m] = args;
    const start = ymd(y, m, args[2]);
    if (!IsoDateSchema.safeParse(start).success)
      return this.rejectDate(ctx, start);
    await this.calendar(
      ctx,
      `${REPROCESS_NS}:rangeend:${start}`,
      `📆 Start: ${start}. Now pick the range end`,
      y,
      m,
    );
  }

  private async renderRangeEndCalendar(
    ctx: any,
    args: string[],
  ): Promise<void> {
    const [start = "", y, m] = args;
    if (!IsoDateSchema.safeParse(start).success)
      return this.rejectDate(ctx, start);
    await this.calendar(
      ctx,
      `${REPROCESS_NS}:rangeend:${start}`,
      `📆 Start: ${start}. Pick the range end`,
      y,
      m,
    );
  }

  /** Confirm prompt for the inclusive day range a..b; `day` keeps the one-day wording and
   *  its `go:d` button. */
  private async confirmRange(
    ctx: any,
    a: string,
    b: string,
    day: boolean,
  ): Promise<void> {
    const range = span(a, b);
    if (!range) return this.rejectDate(ctx, a, b);
    await ctx.answerCallbackQuery();
    const { lo, hi, from, to } = range;
    const targets = reprocessTargets(await this.repo.jotsInRange(from, to));
    if (!targets.length) {
      return void ctx.editMessageText(
        day
          ? `No reprocessable jots on ${lo}.`
          : `No reprocessable jots between ${lo} and ${hi}.`,
        back(),
      );
    }
    const jots = pluralize(targets.length, "jot");
    const kb = new InlineKeyboard()
      .text(
        `🔁 Yes, reprocess ${jots}`,
        day ? `${REPROCESS_NS}:go:d:${lo}` : `${REPROCESS_NS}:go:r:${lo}:${hi}`,
      )
      .row()
      .text("Cancel", `${REPROCESS_NS}:cancel`);
    await ctx.editMessageText(
      `Reprocess ${jots} from ${day ? lo : `${lo} to ${hi}`}?`,
      { reply_markup: withClose(kb, CLOSE) },
    );
  }

  private async showJotPage(ctx: any, page: number): Promise<void> {
    await ctx.answerCallbackQuery();
    // One extra row tells whether a "Next" page exists without a count query.
    const rows = await this.repo.jotsPage(page * JOT_PAGE, JOT_PAGE + 1);
    const hasNext = rows.length > JOT_PAGE;
    const shown = rows.slice(0, JOT_PAGE);
    if (!shown.length) {
      return void ctx.editMessageText(
        page === 0 ? "No reprocessable jots yet." : "No more jots.",
        back(),
      );
    }
    const screen = pagedScreen({
      view: {
        items: shown,
        page,
        pages: hasNext ? page + 2 : page + 1,
        offset: page * JOT_PAGE,
      },
      title: () =>
        `✉️ Pick a jot to reprocess${page ? ` (page ${page + 1})` : ""}:`,
      row: (kb, j) =>
        kb.text(
          `${STATUS_ICON[j.status]} ${plainDate(j.received_at)} ${j.time} ${jotPreview(j)}`.slice(
            0,
            64,
          ),
          `${REPROCESS_NS}:jotpick:${j.id}`,
        ),
      nav: (p) => `${REPROCESS_NS}:jot:${p}`,
      back: { text: "‹ Back", data: ROOT },
    });
    await ctx.editMessageText(screen.text, {
      reply_markup: withClose(screen.kb, CLOSE),
    });
  }

  private async confirmJot(ctx: any, id?: string): Promise<void> {
    const jot = id ? await this.repo.getJot(id) : undefined;
    if (!jot) return void ctx.answerCallbackQuery({ text: "gone" });
    // A stale button or a race with the retry job can leave the jot mid-processing.
    if (!(TERMINAL_STATUSES as readonly JotStatus[]).includes(jot.status)) {
      log.warn(
        { id, status: jot.status },
        "reprocess: jot pick rejected: no longer reprocessable",
      );
      return void ctx.answerCallbackQuery({
        text: "not reprocessable anymore",
      });
    }
    await ctx.answerCallbackQuery();
    const leaderId = jot.anchor;
    const note =
      leaderId === jot.id
        ? ""
        : "\n(part of a squashed entry — this reprocesses the whole line)";
    const kb = new InlineKeyboard()
      .text("🔁 Yes, reprocess", `${REPROCESS_NS}:go:j:${leaderId}`)
      .row()
      .text("Cancel", `${REPROCESS_NS}:cancel`);
    await ctx.editMessageText(`Reprocess "${jotPreview(jot, 80)}"?${note}`, {
      reply_markup: withClose(kb, CLOSE),
    });
  }

  /** `go:d:<date>` runs as the range (date, date). Every mode acks before its DB work,
   *  so the spinner stops promptly and later outcomes report through editMessageText. */
  private async execute(ctx: any, [mode, a, b]: string[]): Promise<void> {
    switch (mode) {
      case "d":
        return this.executeRange(ctx, a ?? "", a ?? "", true);
      case "r":
        return this.executeRange(ctx, a ?? "", b ?? "", false);
      case "j":
        return this.executeJot(ctx, a);
      default:
        await ctx.answerCallbackQuery();
    }
  }

  private async executeRange(
    ctx: any,
    a: string,
    b: string,
    day: boolean,
  ): Promise<void> {
    const range = span(a, b);
    if (!range) return this.rejectDate(ctx, a, b);
    await ctx.answerCallbackQuery();
    const { lo, hi, from, to } = range;
    const targets = reprocessTargets(await this.repo.jotsInRange(from, to));
    return this.executeTargets(ctx, targets, day ? lo : `${lo} → ${hi}`);
  }

  private async executeJot(ctx: any, id?: string): Promise<void> {
    if (!id) {
      log.warn("reprocess: execute rejected: missing jot id");
      return void ctx.answerCallbackQuery({ text: "bad jot id" });
    }
    await ctx.answerCallbackQuery();
    const jot = await this.repo.getJot(id);
    if (!jot) {
      log.warn({ id }, "reprocess: execute rejected: jot not found");
      return void ctx.editMessageText(`Jot ${id} not found.`, back());
    }
    // A crafted callback can name a squashed follower; its line lives under the leader.
    return this.executeTargets(ctx, [jot.anchor], jot.anchor);
  }

  /** Reset and enqueue a resolved target list. The callback is already answered, so every
   *  outcome here reports through editMessageText only. */
  private async executeTargets(
    ctx: any,
    targets: string[],
    label: string,
  ): Promise<void> {
    if (!targets.length) {
      return void ctx.editMessageText(
        `No reprocessable jots for ${label}.`,
        back(),
      );
    }
    // Without a queue, resetForReprocess would strand these jots in `pending` until the
    // next retry.
    const queue = this.queue;
    if (!queue) {
      log.error(
        { label, count: targets.length },
        "reprocess: queue not wired — refusing to reset jots to pending",
      );
      return void ctx.editMessageText(
        "⚠️ Reprocess isn't ready yet — try again in a moment.",
        back(),
      );
    }
    log.info({ label, count: targets.length }, "reprocess triggered");
    log.debug({ ids: targets }, "reprocess targets");
    // Only enqueue what the reset actually set to pending: a target can race into `processing`
    // between the query and the reset.
    const reset = await this.repo.resetForReprocess(targets);
    if (!reset.length) {
      return void ctx.editMessageText(
        `No reprocessable jots for ${label} anymore.`,
        back(),
      );
    }
    queue.add(reset);
    await ctx.editMessageText(
      `🔁 Reprocessing ${pluralize(reset.length, "jot")} from ${label}…`,
    );
  }
}
