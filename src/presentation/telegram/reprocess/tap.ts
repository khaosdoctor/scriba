import { type Composer, type Context, InlineKeyboard } from "grammy";
import { jotPreview, STATUS_ICON } from "../../../libs/jot.ts";
import { logger } from "../../../libs/log.ts";
import { pluralize } from "../../../libs/text.ts";
import { IsoDateSchema, plainDate } from "../../../libs/time.ts";
import type {
  AdminController,
  ReprocessScope,
} from "../../../services/admin.ts";
import { Responder } from "../chat.ts";
import { backTo, pagedScreen, withClose } from "../keyboard.ts";
import { namespace, type Tap } from "../namespace.ts";

const log = logger("reprocess");

export const REPROCESS_NS = "rp";
export const ROOT_TEXT = "🔁 Reprocess — choose scope:";

const rp = (...parts: (string | number)[]) =>
  [REPROCESS_NS, ...parts].join(":");
const CLOSE = rp("close");
const ROOT = rp("root");

/** The scope picker the command, the /menu entry and every Back button show. */
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

const ack = (ctx: Tap, text?: string) => new Responder(ctx).ack(text);

const pad = (n = "") => n.padStart(2, "0");
const ymd = ([y, m, d]: string[]) => `${y}-${pad(m)}-${pad(d)}`;
const isDate = (s: string) => IsoDateSchema.safeParse(s).success;

/** Both ends validated and a backwards pair swapped. */
function span(a: string, b: string) {
  if (!isDate(a) || !isDate(b)) return undefined;
  return a <= b ? { lo: a, hi: b } : { lo: b, hi: a };
}

/** Weeks (Sun-first) of day-of-month numbers for a year and month (1-12), 0 for the
 *  padding cells outside the month. */
export function monthGrid(year: number, month: number): number[][] {
  const daysInMonth = new Date(year, month, 0).getDate();
  const startDow = new Date(year, month - 1, 1).getDay();
  const cells = [
    ...Array(startDow).fill(0),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(0);
  const weeks: number[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

const within = (n: number, lo: number, hi: number, fallback: number) =>
  Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;

/** Month calendar for the year and month args, the current month for anything missing or
 *  out of range (a NaN month would make monthGrid throw, and a 0-99 year hits Date's
 *  1900-relative special case). `prefix` is what a day tap and a month-nav tap extend, so
 *  the range-end picker can carry the range start along. */
async function calendar(
  ctx: Tap,
  prefix: string,
  lead: string,
  [y, m]: string[],
): Promise<void> {
  await ack(ctx);
  const now = new Date();
  const year = within(Number(y), 1000, 9999, now.getFullYear());
  const month = within(Number(m), 1, 12, now.getMonth() + 1);
  const nav = (monthIndex: number) => {
    const d = new Date(year, monthIndex, 1);
    return `${prefix}:${d.getFullYear()}:${d.getMonth() + 1}`;
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

function rejectDate(ctx: Tap, ...dates: string[]): void {
  log.warn({ dates }, "reprocess: tap rejected: bad date");
  return void ack(ctx, "bad date");
}

const rangeEnd = (ctx: Tap, start: string, lead: string, ym: string[]) =>
  isDate(start)
    ? calendar(ctx, rp("rangeend", start), `📆 Start: ${start}. ${lead}`, ym)
    : rejectDate(ctx, start);

/** The confirm prompt for the inclusive day range a..b; `day` keeps the one-day wording
 *  and its `go:d` button. */
async function confirmRange(
  ctx: Tap,
  admin: AdminController,
  a: string,
  b: string,
  day: boolean,
): Promise<void> {
  const range = span(a, b);
  if (!range) return rejectDate(ctx, a, b);
  await ack(ctx);
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
  admin: AdminController,
  page: number,
): Promise<void> {
  await ack(ctx);
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
    row: (kb, j) =>
      kb.text(
        `${STATUS_ICON[j.status]} ${plainDate(j.received_at)} ${j.time} ${jotPreview(j)}`.slice(
          0,
          64,
        ),
        rp("jotpick", j.id),
      ),
    nav: (p) => rp("jot", p),
    back: { text: "‹ Back", data: ROOT },
  });
  await ctx.editMessageText(screen.text, {
    reply_markup: withClose(screen.kb, CLOSE),
  });
}

async function confirmJot(
  ctx: Tap,
  admin: AdminController,
  id?: string,
): Promise<void> {
  const jot = await admin.reprocessPick(id);
  if (jot === "gone") return void ack(ctx, "gone");
  if (jot === "busy") return void ack(ctx, "not reprocessable anymore");
  await ack(ctx);
  const note =
    jot.anchor === jot.id
      ? ""
      : "\n(part of a squashed entry — this reprocesses the whole line)";
  await ctx.editMessageText(`Reprocess "${jotPreview(jot, 80)}"?${note}`, {
    reply_markup: confirmKeyboard(
      "🔁 Yes, reprocess",
      rp("go", "j", jot.anchor),
    ),
  });
}

/** `go:d:<date>` runs as the range (date, date). Every mode acks before its DB work, so
 *  the spinner stops promptly and later outcomes report through editMessageText. */
async function execute(
  ctx: Tap,
  admin: AdminController,
  [mode, a = "", b = ""]: string[],
): Promise<void> {
  const run = async (scope: ReprocessScope) => {
    await ack(ctx);
    const { text, queued } = await admin.reprocessExecute(scope);
    if (!queued) return void ctx.editMessageText(text, back());
    await ctx.editMessageText(text);
  };
  if (mode === "j") {
    if (a) return run({ jot: a });
    log.warn("reprocess: execute rejected: missing jot id");
    return void ack(ctx, "bad jot id");
  }
  if (mode !== "d" && mode !== "r") return ack(ctx);
  const day = mode === "d";
  const end = day ? a : b;
  const range = span(a, end);
  if (!range) return rejectDate(ctx, a, end);
  return run({ ...range, day });
}

export function reprocessView(admin: AdminController): Composer<Context> {
  return namespace(REPROCESS_NS, async (ctx, [action, ...args]) => {
    switch (action) {
      case "root":
        await ack(ctx);
        await ctx.editMessageText(ROOT_TEXT, { reply_markup: rootKeyboard() });
        return;
      case "noop":
        return void ack(ctx);
      case "day": {
        if (args.length < 3)
          return calendar(ctx, rp("day"), "📅 Pick a day to reprocess", args);
        const date = ymd(args);
        return confirmRange(ctx, admin, date, date, true);
      }
      case "range":
        return args.length >= 3
          ? rangeEnd(ctx, ymd(args), "Now pick the range end", args)
          : calendar(ctx, rp("range"), "📆 Pick the range start", args);
      case "rangeend": {
        const [start = "", ...ym] = args;
        return args.length >= 4
          ? confirmRange(ctx, admin, start, ymd(ym), false)
          : rangeEnd(ctx, start, "Pick the range end", ym);
      }
      case "jot":
        // A crafted or stale button can carry a negative page.
        return showJotPage(ctx, admin, Math.max(0, Number(args[0]) || 0));
      case "jotpick":
        return confirmJot(ctx, admin, args[0]);
      case "go":
        return execute(ctx, admin, args);
      case "cancel":
      case "close":
        await ack(ctx);
        return new Responder(ctx).closeMessage("Cancelled.").catch(() => {});
      default:
        log.warn({ action }, "reprocess: unknown action");
        await ack(ctx);
    }
  });
}
