import assert from "node:assert/strict";
import test from "node:test";
import type { Jot } from "../domain/jot/entity.ts";
import { journalLine } from "../domain/jot/rules.ts";
import { FakeSettings } from "../test/fakes.ts";
import { sampleJot } from "../test/sqlite.ts";
import { BackfillService, type PastDay } from "./backfill.ts";

const TODAY = "2026-10-31";
const ARRIVED = new Date(2026, 9, 31, 22, 45, 13).getTime();

const dailyPath = (date: string) => `notes/daily notes/${date}.md`;

function scenario(
  over: {
    jot?: Partial<Jot>;
    followers?: Jot[];
    settings?: Record<string, string>;
    offered?: boolean;
    sameDay?: boolean;
    moveResult?: "moved" | "no-line" | Error;
    sendFails?: boolean;
  } = {},
) {
  const stored = new Map<string, Jot>();
  const leader = sampleJot("abcd1234", {
    status: "done",
    note_path: dailyPath(TODAY),
    time: "22:45:13",
    received_at: ARRIVED,
    ...over.jot,
  });
  for (const member of [leader, ...(over.followers ?? [])])
    stored.set(member.id, member);
  const moves: { from: string; to: string; line: string }[] = [];
  const sent: { text: string; buttons: string[] }[] = [];
  const marked: string[] = [];
  const confirms: string[] = [];
  const service = new BackfillService({
    repo: {
      getJot: async (id: string) => stored.get(id),
      groupFollowers: async () => over.followers ?? [],
      updateJot: async (id: string, patch: Partial<Jot>) => {
        stored.set(id, { ...stored.get(id)!, ...patch });
      },
      backfillOffered: async () => over.offered ?? false,
      markBackfillOffered: async (id: string) => void marked.push(id),
    },
    settings: new FakeSettings(over.settings ?? {}),
    obsidian: {
      dailyPath,
      moveToDay: async (from, _anchor, to, _section, rewrite) => {
        const result = over.moveResult ?? "moved";
        if (result instanceof Error) throw result;
        if (result === "moved")
          moves.push({
            from,
            to,
            line: rewrite(
              journalLine(
                stored.get("abcd1234")!.time,
                "Fixed the bike",
                "abcd1234",
              ),
            ),
          });
        return result;
      },
    },
    enricher: {
      confirmPastDay: async (_text: string, phrase: string) => {
        confirms.push(phrase);
        return over.sameDay ?? true;
      },
    },
    notifier: {
      send: async (text, opts) => {
        if (over.sendFails) throw new Error("telegram is down");
        sent.push({
          text,
          buttons: (opts?.keyboard?.inline_keyboard ?? [])
            .flat()
            .map((button) => button.callback_data),
        });
        return 1;
      },
    },
    now: () => ARRIVED,
    random: () => 0.5, // 15:00:00, halfway through 08:00-22:00
  });
  return { service, leader, stored, moves, sent, marked, confirms };
}

const past = (over: Partial<PastDay> = {}): PastDay => ({
  date: "2026-10-27",
  specific: true,
  phrase: "on tuesday",
  ...over,
});

test("detect reads the author's words into a day for a jot in today's note", async () => {
  const { service, leader } = scenario();
  assert.deepEqual(
    await service.detect(
      leader,
      "on tuesday",
      "on tuesday I fixed the bike",
      "I fixed the bike",
    ),
    {
      date: "2026-10-27",
      specific: true,
      phrase: "on tuesday",
      text: "I fixed the bike",
    },
  );
});

test("detect stays quiet when switched off, already asked, or the jot isn't today's", async () => {
  const words = ["on tuesday", "on tuesday I fixed the bike"] as const;
  const off = scenario({ settings: { backfillDetection: "off" } });
  assert.equal(await off.service.detect(off.leader, ...words), null);
  const asked = scenario({ offered: true });
  assert.equal(await asked.service.detect(asked.leader, ...words), null);
  const followup = scenario({ jot: { note_path: dailyPath("2026-10-30") } });
  assert.equal(await followup.service.detect(followup.leader, ...words), null);
  const plain = scenario();
  assert.equal(await plain.service.detect(plain.leader, undefined, "x"), null);
  assert.equal(await plain.service.detect(plain.leader, "soon", "soon"), null);
});

test("a specific day the second model agrees on moves the rewrite without asking, with Edit and Undo", async () => {
  const { service, leader, moves, sent, marked, stored } = scenario();
  await service.offer(
    leader,
    past({ text: "I fixed the bike with [[Ada]]" }),
    "On tuesday I fixed the bike with [[Ada]]",
  );
  assert.deepEqual(moves, [
    {
      from: dailyPath(TODAY),
      to: "2026-10-27",
      line: "- _15:00:00 (backfilled in 2026-10-31) ::_ I fixed the bike with [[Ada]] ^abcd1234",
    },
  ]);
  assert.match(sent[0]!.text, /Moved to Tue 2026-10-27/);
  assert.match(sent[0]!.text, /<blockquote>I fixed the bike/);
  assert.deepEqual(sent[0]!.buttons, ["ed:abcd1234", "bf:u:abcd1234"]);
  assert.deepEqual(marked, ["abcd1234"]);
  const moved = stored.get("abcd1234")!;
  assert.equal(moved.note_path, dailyPath("2026-10-27"));
  assert.equal(moved.time, "15:00:00 (backfilled in 2026-10-31)");
  // folded back, so a reprocess files the rewrite rather than "On tuesday ..."
  assert.equal(moved.raw_text, "I fixed the bike with [[Ada]]");
});

test("undo puts back the words the rewrite replaced, in the line and the source", async () => {
  const { service, moves, stored } = scenario({
    jot: { past_text: "I fixed the bike" },
  });
  assert.equal(await service.move("abcd1234", "2026-10-27"), "moved");
  assert.equal(stored.get("abcd1234")!.raw_text, "I fixed the bike");
  // a second move between past days keeps the first words, not the rewrite
  assert.equal(await service.move("abcd1234", "2026-10-26"), "moved");
  assert.equal(stored.get("abcd1234")!.pre_move_text, "Fixed the bike");
  assert.equal(await service.undo("abcd1234"), "moved");
  assert.equal(moves[2]!.line, "- _22:45:13 ::_ Fixed the bike ^abcd1234");
  assert.equal(stored.get("abcd1234")!.raw_text, "Fixed the bike");
  assert.equal(stored.get("abcd1234")!.pre_move_text, null);
});

test("a move without a rewrite keeps the line's own text", async () => {
  const { service, moves } = scenario();
  assert.equal(await service.move("abcd1234", "2026-10-27"), "moved");
  assert.equal(
    moves[0]!.line,
    "- _15:00:00 (backfilled in 2026-10-31) ::_ Fixed the bike ^abcd1234",
  );
});

test("a vague day asks without calling the second model", async () => {
  const { service, leader, moves, sent, confirms } = scenario();
  await service.offer(
    leader,
    past({ specific: false, phrase: "last week" }),
    "x",
  );
  assert.deepEqual(confirms, []);
  assert.deepEqual(moves, []);
  assert.match(sent[0]!.text, /Did this happen on Tue 2026-10-27\?/);
  assert.ok(sent[0]!.buttons.includes("bf:m:abcd1234:2026-10-27"));
  assert.ok(sent[0]!.buttons.includes("bf:k:abcd1234"));
});

test("a second model that disagrees, or a move that fails, sends the card instead", async () => {
  const doubt = scenario({ sameDay: false });
  await doubt.service.offer(doubt.leader, past(), "x");
  assert.deepEqual(doubt.moves, []);
  assert.match(doubt.sent[0]!.text, /Did this happen/);
  const broken = scenario({ moveResult: new Error("obsidian is down") });
  await broken.service.offer(broken.leader, past(), "x");
  assert.match(broken.sent[0]!.text, /Did this happen/);
});

test("a card that fails to send is left unmarked so a reprocess can ask again", async () => {
  const { service, leader, marked } = scenario({
    sendFails: true,
    sameDay: false,
  });
  await service.offer(leader, past(), "x");
  assert.deepEqual(marked, []);
});

test("a move carries squashed followers along, and undo puts the arrival time back", async () => {
  const follower = sampleJot("ffff0000", {
    anchor: "abcd1234",
    status: "done",
    note_path: dailyPath(TODAY),
    time: "22:45:20",
    received_at: ARRIVED + 7000,
  });
  const { service, stored, moves } = scenario({
    followers: [follower],
    jot: { past_text: "Fixed the bike" },
  });
  assert.equal(await service.move("abcd1234", "2026-10-27"), "moved");
  assert.equal(stored.get("ffff0000")!.note_path, dailyPath("2026-10-27"));
  assert.equal(
    stored.get("ffff0000")!.time,
    "15:00:00 (backfilled in 2026-10-31)",
  );
  // a squashed line has no single source to fold the rewrite into
  assert.equal(stored.get("abcd1234")!.raw_text, "hi");
  assert.equal(await service.undo("abcd1234"), "moved");
  assert.equal(moves[1]!.to, TODAY);
  assert.equal(moves[1]!.line, "- _22:45:13 ::_ Fixed the bike ^abcd1234");
  assert.equal(stored.get("abcd1234")!.time, "22:45:13");
  assert.equal(stored.get("abcd1234")!.note_path, dailyPath(TODAY));
});

test("a move refuses a gone, busy or same-day jot and reports a missing line", async () => {
  assert.equal(await scenario().service.move(undefined, "2026-10-27"), "gone");
  const deleted = scenario({ jot: { status: "deleted" } });
  assert.equal(await deleted.service.move("abcd1234", "2026-10-27"), "gone");
  const busy = scenario({ jot: { status: "processing" } });
  assert.equal(await busy.service.move("abcd1234", "2026-10-27"), "busy");
  assert.equal(await scenario().service.move("abcd1234", TODAY), "busy");
  const lost = scenario({ moveResult: "no-line" });
  assert.equal(await lost.service.move("abcd1234", "2026-10-27"), "no-line");
  assert.equal(await scenario().service.undo("nope0000"), "gone");
});

test("the calendar and the past check use today's date", () => {
  const { service } = scenario();
  assert.ok(service.isPast("2026-10-30"));
  assert.ok(!service.isPast(TODAY));
  const grid = service.calendar("abcd1234", "2026-10").inline_keyboard;
  assert.equal(grid[0]![1]!.text, "October 2026");
});
