import assert from "node:assert/strict";
import { test } from "node:test";
import { noteOps } from "../test/note-ops.ts";
import { HabitController } from "./habits.ts";

const DATE = "2026-07-05";
const PATH = `Daily/${DATE}.md`;
const FLOW_MSG = 500;

const NOTE = `---
date: ${DATE}
---
## Journal
- hi
## Habits
- [ ] Practiced music #meta/habits/music
- [ ] [Pages read:: 0] #meta/habits/reading
- [x] Exercised #meta/habits/exercise [completion:: ${DATE}]
## TIL
-
`;
const ALL_DONE = NOTE.replace("- [ ] Practiced music", "- [x] Practiced music")
  .replace("[Pages read:: 0]", "[Pages read:: 9]")
  .replace("- [ ] [Pages", "- [x] [Pages");
const REVIEWED = NOTE.replace("date:", "habitsReviewed: true\ndate:");

type Buttons = { text: string; callback_data: string }[][];
const buttons = (opts: any): Buttons => opts?.keyboard?.inline_keyboard;

/** A controller over an in-memory vault and a chat that only records. `notes` maps a date
 *  to its note; a date with no entry is a missing daily note. `events` is every chat and
 *  vault effect in the order it happened. */
function setup(
  notes: Record<string, string> = { [DATE]: NOTE },
  opts: { deleteFails?: boolean } = {},
) {
  const events: string[] = [];
  const sent: { text: string; opts: any }[] = [];
  const edits: { id: number; text: string; opts: any }[] = [];
  const deletes: number[] = [];
  const writes: { path: string; content: string }[] = [];
  const vault = new Map<string, string>();
  for (const [date, content] of Object.entries(notes))
    vault.set(`Daily/${date}.md`, content);

  const notifier = {
    notify: async (text: string) => void events.push(`send:${text}`),
    send: async (text: string, opts?: unknown) => {
      events.push(`send:${text}`);
      sent.push({ text, opts });
      return FLOW_MSG;
    },
    edit: async (id: number, text: string, opts?: unknown) => {
      events.push(`edit:${id}:${text}`);
      edits.push({ id, text, opts });
    },
    delete: async (id: number) => {
      events.push(`delete:${id}`);
      deletes.push(id);
      if (opts.deleteFails) throw new Error("message to delete not found");
    },
  };
  const obsidian: any = {
    readDailyNote: async (date: string) => {
      const content = vault.get(`Daily/${date}.md`);
      return content === undefined
        ? null
        : { path: `Daily/${date}.md`, content };
    },
    readNote: async (path: string) => vault.get(path),
    writeNote: async (path: string, content: string) => {
      events.push(`write:${path}`);
      writes.push({ path, content });
      vault.set(path, content);
    },
    ...noteOps(
      () => obsidian,
      () => events.push("lock"),
    ),
  };
  const habits = new HabitController({
    obsidian,
    notifier,
    heading: "Habits",
  });
  return { habits, events, sent, edits, deletes, writes, vault };
}

test("a review sends one Begin card counting what is still pending", async () => {
  const fixture = setup();
  await fixture.habits.prompt(DATE);
  assert.equal(fixture.sent.length, 1);
  assert.equal(
    fixture.sent[0]!.text,
    `🌱 Time to review habits for ${DATE} — 2 to go.`,
  );
  assert.deepEqual(buttons(fixture.sent[0]!.opts), [
    [{ text: "🌱 Begin", callback_data: `hb:${DATE}:begin` }],
  ]);
});

test("a day already reviewed is skipped: said aloud for a manual review, silent for the nightly one", async () => {
  const manual = setup({ [DATE]: REVIEWED });
  await manual.habits.prompt(DATE, true);
  assert.deepEqual(manual.events, [
    `send:✅ Habits already reviewed for ${DATE}.`,
  ]);

  const nightly = setup({ [DATE]: REVIEWED });
  await nightly.habits.prompt(DATE);
  assert.deepEqual(nightly.events, []);
});

test("a day with nothing left to tick is skipped, and a missing note is told apart from a finished one", async () => {
  const done = setup({ [DATE]: ALL_DONE });
  await done.habits.prompt(DATE, true);
  assert.deepEqual(done.events, [
    `send:✅ All habits already done for ${DATE}.`,
  ]);

  const missing = setup({});
  await missing.habits.prompt(DATE, true);
  assert.deepEqual(missing.events, [`send:No habits found for ${DATE}.`]);

  const nightly = setup({});
  await nightly.habits.prompt(DATE);
  assert.deepEqual(nightly.events, []);
});

test("a yes/no habit turns the card into a question with Yes and No", async () => {
  const fixture = setup();
  await fixture.habits.prompt(DATE);
  await fixture.habits.ask(DATE, 0);
  assert.deepEqual(
    { id: fixture.edits[0]!.id, text: fixture.edits[0]!.text },
    { id: FLOW_MSG, text: "🌱 Practiced music?" },
  );
  assert.deepEqual(buttons(fixture.edits[0]!.opts), [
    [
      { text: "✅ Yes", callback_data: `hb:${DATE}:0:y` },
      { text: "❌ No", callback_data: `hb:${DATE}:0:n` },
    ],
  ]);
});

test("a value habit asks for a number in a reply that carries its marker, with no buttons", async () => {
  const fixture = setup();
  await fixture.habits.prompt(DATE);
  await fixture.habits.ask(DATE, 1);
  assert.equal(
    fixture.edits[0]!.text,
    `🌱 Pages read? Reply to this message with a number.\n(hb:${DATE}:1)`,
  );
  assert.equal(fixture.edits[0]!.opts, undefined);
});

test("the tapped card is the one edited, even when the prompt was sent before a restart", async () => {
  const fixture = setup();
  await fixture.habits.ask(DATE, 0, 321);
  assert.equal(fixture.edits[0]!.id, 321);
});

test("Yes ticks the line and stamps its completion under the note lock", async () => {
  const fixture = setup();
  assert.equal(await fixture.habits.tap(DATE, 0, true), true);
  assert.deepEqual(fixture.events, ["lock", `write:${PATH}`]);
  assert.equal(
    fixture.vault.get(PATH),
    NOTE.replace(
      "- [ ] Practiced music #meta/habits/music",
      `- [x] Practiced music #meta/habits/music [completion:: ${DATE}]`,
    ),
  );
});

test("No leaves the note untouched", async () => {
  const fixture = setup();
  assert.equal(await fixture.habits.tap(DATE, 0, false), true);
  assert.deepEqual(fixture.writes, []);
});

test("a tap on a habit or note that no longer exists is refused and writes nothing", async () => {
  const fixture = setup();
  assert.equal(await fixture.habits.tap(DATE, 9, true), false);
  assert.equal(await fixture.habits.tap("2026-01-01", 0, true), false);
  assert.deepEqual(fixture.events, []);
});

test("a number fills the value habit and ticks it; decimals and negatives are numbers too", async () => {
  for (const value of ["42", "2.5", "-3"]) {
    const fixture = setup();
    assert.equal(await fixture.habits.fill(DATE, 1, value), "saved", value);
    assert.match(
      fixture.vault.get(PATH)!,
      new RegExp(
        `- \\[x\\] \\[Pages read:: ${value}\\] #meta/habits/reading \\[completion:: ${DATE}\\]`,
      ),
    );
  }
});

test("an answer that is not a number is refused and nothing is written", async () => {
  const fixture = setup();
  assert.equal(await fixture.habits.fill(DATE, 1, "a lot"), "notNumber");
  assert.deepEqual(fixture.events, []);
});

test("an answer for a habit or note that is gone is refused and nothing is written", async () => {
  const noHabit = setup();
  assert.equal(await noHabit.habits.fill(DATE, 9, "5"), "gone");
  assert.deepEqual(noHabit.writes, []);

  assert.equal(await setup({}).habits.fill(DATE, 1, "5"), "gone");
});

test("the last answer stamps habitsReviewed under the lock, keeps the other frontmatter, deletes the card, and a second review is refused", async () => {
  const fixture = setup();
  await fixture.habits.prompt(DATE);
  await fixture.habits.tap(DATE, 0, true);
  await fixture.habits.fill(DATE, 1, "12");
  fixture.events.length = 0;
  await fixture.habits.ask(DATE, 2);
  assert.deepEqual(fixture.events, [
    "lock",
    `write:${PATH}`,
    `delete:${FLOW_MSG}`,
  ]);
  assert.match(
    fixture.vault.get(PATH)!,
    /^---\ndate: 2026-07-05\nhabitsReviewed: true\n---/,
  );

  await fixture.habits.prompt(DATE, true);
  assert.equal(
    fixture.events.at(-1),
    `send:✅ Habits already reviewed for ${DATE}.`,
  );
});

test("a card that cannot be deleted does not stop the review from finishing", async () => {
  const fixture = setup({ [DATE]: ALL_DONE }, { deleteFails: true });
  await fixture.habits.ask(DATE, 0, FLOW_MSG);
  assert.match(fixture.vault.get(PATH)!, /habitsReviewed: true/);
  assert.deepEqual(fixture.deletes, [FLOW_MSG]);
});

test("when the note disappears mid-review the card is deleted and nothing is asked", async () => {
  const fixture = setup();
  await fixture.habits.prompt(DATE);
  fixture.vault.delete(PATH);
  await fixture.habits.ask(DATE, 0);
  assert.deepEqual(fixture.deletes, [FLOW_MSG]);
  assert.deepEqual(fixture.edits, []);
});

test("after a restart a Yes is still recorded but there is no card to continue on", async () => {
  const fixture = setup();
  assert.equal(await fixture.habits.tap(DATE, 0, true), true);
  await fixture.habits.ask(DATE, 1);
  assert.equal(fixture.writes.length, 1);
  assert.deepEqual(fixture.edits, []);
});
