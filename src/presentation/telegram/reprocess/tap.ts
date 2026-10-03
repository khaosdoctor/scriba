import { type Composer, type Context, InlineKeyboard } from "grammy";
import { isFollower } from "../../../domain/jot/rules.ts";
import { jotPreview, STATUS_ICON } from "../../../libs/jot.ts";
import { logger } from "../../../libs/log.ts";
import { pluralize } from "../../../libs/text.ts";
import { IsoDateSchema, monthGrid, plainDate } from "../../../libs/time.ts";
import type { AdminService, ReprocessScope } from "../../../services/admin.ts";
import type { Responder } from "../chat.ts";
import { backTo, pagedScreen, withClose } from "../keyboard.ts";
import { namespace, type Tap } from "../namespace.ts";

const log = logger("reprocess");

const REPROCESS_NS = "rp";
export const ROOT_TEXT = "🔁 Reprocess — choose scope:";

const rp = (...parts: (string | number)[]) =>
  [REPROCESS_NS, ...parts].join(":");
const CLOSE = rp("close");
const ROOT = rp("root");

export const rootKeyboard = () =>
  withClose(
    new InlineKeyboard()
      .text("📅 One day", rp("day"))
      .row()
      .text("📆 Date range", rp("range"))
      .row()
      .text("✉️ One jot", rp("jot", 0)),
    CLOSE,
  );

const back = () => ({ reply_markup: backTo(ROOT, CLOSE) });

const confirmKeyboard = (yes: string, go: string) =>
  withClose(
    new InlineKeyboard().text(yes, go).row().text("Cancel", rp("cancel")),
    CLOSE,
  );

const pad = (value = "") => value.padStart(2, "0");
const ymd = ([year, month, day]: string[]) =>
  `${year}-${pad(month)}-${pad(day)}`;
const isDate = (value: string) => IsoDateSchema.safeParse(value).success;

function span(first: string, second: string) {
  if (!isDate(first) || !isDate(second)) return undefined;
  return first <= second
    ? { lo: first, hi: second }
    : { lo: second, hi: first };
}

const within = (value: number, lo: number, hi: number, fallback: number) =>
  Number.isInteger(value) && value >= lo && value <= hi ? value : fallback;

/** Month calendar for the year and month args, the current month for anything missing or
 *  out of range (a NaN month would make monthGrid throw, and a 0-99 year hits Date's
 *  1900-relative special case). `prefix` is what a day tap and a month-nav tap extend, so
 *  the range-end picker can carry the range start along. */
async function calendar(
  ctx: Tap,
  responder: Responder,
  prefix: string,
  lead: string,
  [yearArg, monthArg]: string[],
): Promise<void> {
  await responder.ack();
  const now = new Date();
  const year = within(Number(yearArg), 1000, 9999, now.getFullYear());
  const month = within(Number(monthArg), 1, 12, now.getMonth() + 1);
  const nav = (monthIndex: number) => {
    const target = new Date(year, monthIndex, 1);
    return `${prefix}:${target.getFullYear()}:${target.getMonth() + 1}`;
  };
  const kb = new InlineKeyboard();
  for (const label of ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"])
    kb.text(label, rp("noop"));
  kb.row();
  for (const week of monthGrid(year, month)) {
    for (const day of week) {
      if (day === 0) kb.text(" ", rp("noop"));
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

function rejectDate(
  responder: Responder,
  fields: object,
  message: string,
): void {
  log.warn(fields, message);
  return void responder.ack("bad date");
}

const rangeEnd = (
  ctx: Tap,
  responder: Responder,
  start: string,
  lead: string,
  ym: string[],
  rejected: string,
) =>
  isDate(start)
    ? calendar(
        ctx,
        responder,
        rp("rangeend", start),
        `📆 Start: ${start}. ${lead}`,
        ym,
      )
    : rejectDate(responder, { start }, rejected);

async function confirmRange(
  ctx: Tap,
  responder: Responder,
  admin: AdminService,
  first: string,
  second: string,
  day: boolean,
): Promise<void> {
  const range = span(first, second);
  if (!range && day)
    return rejectDate(
      responder,
      { date: first },
      "reprocess: day tap rejected: bad date",
    );
  if (!range)
    return rejectDate(
      responder,
      { start: first, end: second },
      "reprocess: range-end tap rejected: bad date",
    );
  await responder.ack();
  const { lo, hi } = range;
  const count = await admin.reprocessCount(lo, hi);
  if (!count) {
    return void ctx.editMessageText(
      day
        ? `No reprocessable jots on ${lo}.`
        : `No reprocessable jots between ${lo} and ${hi}.`,
      back(),
    );
  }
  const jots = pluralize(count, "jot");
  await ctx.editMessageText(
    `Reprocess ${jots} from ${day ? lo : `${lo} to ${hi}`}?`,
    {
      reply_markup: confirmKeyboard(
        `🔁 Yes, reprocess ${jots}`,
        day ? rp("go", "d", lo) : rp("go", "r", lo, hi),
      ),
    },
  );
}

async function showJotPage(
  ctx: Tap,
  responder: Responder,
  admin: AdminService,
  page: number,
): Promise<void> {
  await responder.ack();
  const view = await admin.jotsPage(page);
  if (!view.items.length) {
    return void ctx.editMessageText(
      page === 0 ? "No reprocessable jots yet." : "No more jots.",
      back(),
    );
  }
  const screen = pagedScreen({
    view,
    title: () =>
      `✉️ Pick a jot to reprocess${page ? ` (page ${page + 1})` : ""}:`,
    row: (kb, jot) =>
      kb.text(
        `${STATUS_ICON[jot.status]} ${plainDate(jot.received_at)} ${jot.time} ${jotPreview(jot)}`.slice(
          0,
          64,
        ),
        rp("jotpick", jot.id),
      ),
    nav: (target) => rp("jot", target),
    back: { text: "‹ Back", data: ROOT },
    close: CLOSE,
  });
  await ctx.editMessageText(screen.text, { reply_markup: screen.kb });
}

async function confirmJot(
  ctx: Tap,
  responder: Responder,
  admin: AdminService,
  id?: string,
): Promise<void> {
  const jot = await admin.reprocessPick(id);
  if (jot === "gone") return void responder.ack("gone");
  if (jot === "busy") return void responder.ack("not reprocessable anymore");
  await responder.ack();
  const note = isFollower(jot)
    ? "\n(part of a squashed entry — this reprocesses the whole line)"
    : "";
  await ctx.editMessageText(`Reprocess "${jotPreview(jot, 80)}"?${note}`, {
    reply_markup: confirmKeyboard(
      "🔁 Yes, reprocess",
      rp("go", "j", jot.anchor),
    ),
  });
}

async function execute(
  ctx: Tap,
  responder: Responder,
  admin: AdminService,
  [mode, first = "", second = ""]: string[],
): Promise<void> {
  const run = async (scope: ReprocessScope) => {
    await responder.ack();
    const { text, queued } = await admin.reprocessExecute(scope);
    if (!queued) return void ctx.editMessageText(text, back());
    await ctx.editMessageText(text);
  };
  if (mode === "j") {
    if (first) return run({ jot: first });
    log.warn("reprocess: execute rejected: missing jot id");
    return void responder.ack("bad jot id");
  }
  if (mode !== "d" && mode !== "r") return responder.ack();
  const day = mode === "d";
  const end = day ? first : second;
  const range = span(first, end);
  if (!range)
    return rejectDate(
      responder,
      day ? { date: first } : { start: first, end },
      "reprocess: execute rejected: bad date",
    );
  return run({ ...range, day });
}

export function reprocessView(admin: AdminService): Composer<Context> {
  return namespace(REPROCESS_NS, async (ctx, [action, ...args], responder) => {
    switch (action) {
      case "root":
        await responder.ack();
        await ctx.editMessageText(ROOT_TEXT, { reply_markup: rootKeyboard() });
        return;
      case "noop":
        return void responder.ack();
      case "day": {
        if (args.length < 3)
          return calendar(
            ctx,
            responder,
            rp("day"),
            "📅 Pick a day to reprocess",
            args,
          );
        const date = ymd(args);
        return confirmRange(ctx, responder, admin, date, date, true);
      }
      case "range":
        return args.length >= 3
          ? rangeEnd(
              ctx,
              responder,
              ymd(args),
              "Now pick the range end",
              args,
              "reprocess: range-start tap rejected: bad date",
            )
          : calendar(
              ctx,
              responder,
              rp("range"),
              "📆 Pick the range start",
              args,
            );
      case "rangeend": {
        const [start = "", ...ym] = args;
        return args.length >= 4
          ? confirmRange(ctx, responder, admin, start, ymd(ym), false)
          : rangeEnd(
              ctx,
              responder,
              start,
              "Pick the range end",
              ym,
              "reprocess: range-end calendar rejected: bad start date",
            );
      }
      case "jot":
        // A crafted or stale button can carry a negative page.
        return showJotPage(
          ctx,
          responder,
          admin,
          Math.max(0, Number(args[0]) || 0),
        );
      case "jotpick":
        return confirmJot(ctx, responder, admin, args[0]);
      case "go":
        return execute(ctx, responder, admin, args);
      case "cancel":
      case "close":
        await responder.ack();
        return responder.closeMessage("Cancelled.").catch(() => {});
      default:
        log.warn({ action }, "reprocess: unknown action");
        await responder.ack();
    }
  });
}
