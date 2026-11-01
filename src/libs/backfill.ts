import * as chrono from "chrono-node";
import { EDIT_NS } from "./jot.ts";
import { keyboard, type Row } from "./keyboard.ts";
import { isDateLike } from "./links.ts";
import { dateFromIso, plainDate } from "./time.ts";

export const BACKFILL_NS = "bf";

const LOCALES = [chrono.en.casual, chrono.pt.casual, chrono.sv.casual];

/** Words that name a span rather than one day. chrono still resolves "last week" to a
 *  single day, so the day it picks is only a guess and the owner has to confirm it. */
const VAGUE =
  /(?<![\p{L}\p{N}])(weeks?|months?|years?|weekends?|while|recent(ly)?|semanas?|m[eê]s(es)?|anos?|veckan?|veckor|månad(en|er)?|år(et)?|helgen?)(?![\p{L}\p{N}])/iu;

export interface BackfillGuess {
  date: string;
  /** The words name one specific day and nothing else in the entry points elsewhere, so
   *  a second model is allowed to decide alone. Otherwise the owner is asked. */
  specific: boolean;
}

function shiftDays(date: string, days: number): string {
  const day = dateFromIso(date);
  return plainDate(
    new Date(day.getFullYear(), day.getMonth(), day.getDate() + days).getTime(),
  );
}

/** The day a hit points to, read backwards: a bare weekday ("on tuesday") is the last
 *  one before the jot's day, since an entry about the past can't mean next week. */
function pastDay(hit: chrono.ParsedResult, jotDay: string): string {
  const date = plainDate(hit.start.date().getTime());
  const weekdayOnly =
    hit.start.isCertain("weekday") && !hit.start.isCertain("day");
  if (weekdayOnly && date >= jotDay) return shiftDays(date, -7);
  return date;
}

function dayHits(text: string, ref: Date): chrono.ParsedResult[] {
  for (const parser of LOCALES) {
    const hits = parser.parse(text, ref).filter(isDateLike);
    if (hits.length) return hits;
  }
  return [];
}

/** Where the enricher's `past` words put the entry, or null when they name no day before
 *  the jot's own. Token-free: the model only reports the author's words. */
export function backfillGuess(
  past: string | undefined,
  source: string,
  jotDay: string,
): BackfillGuess | null {
  if (!past?.trim()) return null;
  const ref = dateFromIso(jotDay);
  const hit = dayHits(past, ref)[0];
  if (!hit) return null;
  const date = pastDay(hit, jotDay);
  if (date >= jotDay) return null;
  const elsewhere = dayHits(source, ref).some(
    (other) => pastDay(other, jotDay) !== date,
  );
  return { date, specific: !VAGUE.test(past) && !elsewhere };
}

/** The guessed day and the three before it, newest first. */
export function suggestedDays(date: string): string[] {
  return [0, -1, -2, -3].map((offset) => shiftDays(date, offset));
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function dayLabel(date: string): string {
  return `${WEEKDAY[dateFromIso(date).getDay()]} ${date}`;
}

export function moveRef(jotId: string, date: string): string {
  return `${BACKFILL_NS}:m:${jotId}:${date}`;
}

const NOOP = `${BACKFILL_NS}:n`;

/** A month grid of inline buttons, Monday first. Only days before `today` can be picked;
 *  the rest render as a dot so the grid keeps its shape. ◄ ► page by month. */
export function calendarRows(
  jotId: string,
  month: string,
  today: string,
): Row[] {
  const first = dateFromIso(`${month}-01`);
  const year = first.getFullYear();
  const monthIndex = first.getMonth();
  const days = new Date(year, monthIndex + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  const page = (offset: number) =>
    plainDate(new Date(year, monthIndex + offset, 1).getTime()).slice(0, 7);
  const title = first.toLocaleString("en", { month: "long", year: "numeric" });
  const cells: Row[number][] = Array.from({ length: lead }, () => [" ", NOOP]);
  for (let day = 1; day <= days; day++) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    cells.push(
      date < today ? [String(day), moveRef(jotId, date)] : ["·", NOOP],
    );
  }
  while (cells.length % 7) cells.push([" ", NOOP]);
  const weeks: Row[] = [];
  for (let index = 0; index < cells.length; index += 7)
    weeks.push(cells.slice(index, index + 7));
  return [
    [
      ["◄", `${BACKFILL_NS}:c:${jotId}:${page(-1)}`],
      [title, NOOP],
      ["►", `${BACKFILL_NS}:c:${jotId}:${page(1)}`],
    ],
    ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((name) => [name, NOOP]),
    ...weeks,
    [["🚫 Keep today", `${BACKFILL_NS}:k:${jotId}`]],
  ];
}

export function backfillCard(jotId: string, date: string) {
  return keyboard([
    suggestedDays(date).map((day): Row[number] => [
      `${dayLabel(day).slice(0, 3)} ${Number(day.slice(8))}`,
      moveRef(jotId, day),
    ]),
    [
      ["📅 Other day", `${BACKFILL_NS}:c:${jotId}:${date.slice(0, 7)}`],
      ["🚫 Keep today", `${BACKFILL_NS}:k:${jotId}`],
    ],
  ]);
}

/** A moved entry's message: fix the rewritten text, or put it back. */
export function movedKeyboard(jotId: string) {
  return keyboard([
    [
      ["✏️ Edit", `${EDIT_NS}:${jotId}`],
      ["↩️ Undo move", `${BACKFILL_NS}:u:${jotId}`],
    ],
  ]);
}

/** A backfilled entry's clock time is made up: some HH:MM:SS between 08:00 and 22:00,
 *  since the arrival time says when it was written, not when it happened. */
export function randomDaytime(random: () => number = Math.random): string {
  const seconds = 8 * 3600 + Math.floor(random() * 14 * 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}
