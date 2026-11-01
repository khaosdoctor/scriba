import assert from "node:assert/strict";
import test from "node:test";
import {
  backfillCard,
  backfillGuess,
  calendarRows,
  dayLabel,
  randomDaytime,
  suggestedDays,
} from "./backfill.ts";

test("a made-up backfill time stays between 08:00 and 22:00", () => {
  assert.equal(
    randomDaytime(() => 0),
    "08:00:00",
  );
  assert.equal(
    randomDaytime(() => 0.5),
    "15:00:00",
  );
  assert.equal(
    randomDaytime(() => 0.9999999),
    "21:59:59",
  );
});

// 2026-10-31 is a Saturday.
const SATURDAY = "2026-10-31";

test("backfillGuess resolves the author's words against the jot's own day", () => {
  assert.deepEqual(
    backfillGuess("yesterday", "yesterday I fixed the bike", SATURDAY),
    {
      date: "2026-10-30",
      specific: true,
    },
  );
  assert.deepEqual(
    backfillGuess("three days ago", "three days ago Alex visited", SATURDAY),
    { date: "2026-10-28", specific: true },
  );
});

test("a bare weekday means the last one before the jot's day, never next week", () => {
  assert.equal(
    backfillGuess("on tuesday", "on tuesday I painted the shed", SATURDAY)
      ?.date,
    "2026-10-27",
  );
  assert.equal(
    backfillGuess("on saturday", "on saturday I went hiking", SATURDAY)?.date,
    "2026-10-24",
  );
});

test("words naming a span still give a day to suggest, but never a sure one", () => {
  const guess = backfillGuess(
    "last week",
    "last week I bought a lamp",
    SATURDAY,
  );
  assert.equal(guess?.specific, false);
  assert.ok(guess && guess.date < SATURDAY);
});

test("another day mentioned in the entry makes the guess unsure", () => {
  assert.deepEqual(
    backfillGuess(
      "yesterday",
      "yesterday I fixed the bike and tomorrow I ride it",
      SATURDAY,
    ),
    { date: "2026-10-30", specific: false },
  );
});

test("pt and sv words are read too", () => {
  assert.equal(
    backfillGuess("ontem", "ontem consertei a bicicleta", SATURDAY)?.date,
    "2026-10-30",
  );
  assert.equal(
    backfillGuess("igår", "igår lagade jag cykeln", SATURDAY)?.date,
    "2026-10-30",
  );
});

test("no guess for missing words, words with no day, or a day that isn't past", () => {
  assert.equal(backfillGuess(undefined, "text", SATURDAY), null);
  assert.equal(backfillGuess("a while ago", "a while ago", SATURDAY), null);
  assert.equal(backfillGuess("today", "today", SATURDAY), null);
  assert.equal(backfillGuess("tomorrow", "tomorrow", SATURDAY), null);
});

test("the card suggests the guessed day and the three before it", () => {
  assert.deepEqual(suggestedDays("2026-10-02"), [
    "2026-10-02",
    "2026-10-01",
    "2026-09-30",
    "2026-09-29",
  ]);
  const rows = backfillCard("abcd1234", "2026-10-27").inline_keyboard;
  assert.deepEqual(
    rows[0]!.map((button) => button.text),
    ["Tue 27", "Mon 26", "Sun 25", "Sat 24"],
  );
  assert.equal(rows[0]![0]!.callback_data, "bf:m:abcd1234:2026-10-27");
  assert.equal(rows[1]![0]!.callback_data, "bf:c:abcd1234:2026-10");
  assert.equal(dayLabel(SATURDAY), "Sat 2026-10-31");
});

test("the calendar is a Monday-first grid where only past days can be picked", () => {
  const rows = calendarRows("abcd1234", "2026-10", SATURDAY);
  assert.deepEqual(
    rows[0]!.map(([text]) => text),
    ["◄", "October 2026", "►"],
  );
  assert.equal(rows[0]![0]![1], "bf:c:abcd1234:2026-09");
  assert.equal(rows[0]![2]![1], "bf:c:abcd1234:2026-11");
  const weeks = rows.slice(2, -1);
  for (const week of weeks) assert.equal(week.length, 7);
  // October 2026 starts on a Thursday: three blanks first.
  assert.deepEqual(
    weeks[0]!.map(([text]) => text),
    [" ", " ", " ", "1", "2", "3", "4"],
  );
  const cells = weeks.flat();
  const day = (label: string) => cells.find(([text]) => text === label);
  assert.equal(day("30")![1], "bf:m:abcd1234:2026-10-30");
  assert.equal(day("31"), undefined); // today renders as a dot
  assert.ok(cells.some(([text, data]) => text === "·" && data === "bf:n"));
  assert.equal(rows.at(-1)![0]![1], "bf:k:abcd1234");
});

test("the calendar pages across a year boundary", () => {
  const rows = calendarRows("abcd1234", "2026-01", SATURDAY);
  assert.equal(rows[0]![0]![1], "bf:c:abcd1234:2025-12");
});
