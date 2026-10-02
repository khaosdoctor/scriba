import assert from "node:assert/strict";
import { test } from "node:test";
import { testConfig } from "../../test/config.ts";
import { previousDate } from "../../time.ts";
import { HabitsCommand } from "./index.ts";

const DATE = "2026-07-05";
const PATH = `Daily/${DATE}.md`;
const CHAT = testConfig.telegram.allowedUserId;
const FLOW_MSG = 500;

const NOTE = `---
date: ${DATE}
---
## Journal
- hi
## ${testConfig.obsidian.habitsHeading}
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
const buttons = (opts: any): Buttons => opts?.reply_markup?.inline_keyboard;

/** A command wired to an in-memory vault and a Telegram that only records. `notes` maps a
 *  date to its note; a date with no entry is a missing daily note. `events` is every
 *  Telegram and vault effect in the order it happened. */
function harness(
  notes: Record<string, string> = { [DATE]: NOTE },
  opts: { deleteFails?: boolean } = {},
) {
  const events: string[] = [];
  const sent: { chat: number; text: string; opts: any }[] = [];
  const edits: { chat: number; id: number; text: string; opts: any }[] = [];
  const deletes: [number, number][] = [];
  const writes: { path: string; content: string }[] = [];
  const reads: string[] = [];
  const commands = new Map<string, (ctx: any) => Promise<void>>();
  const vault = new Map<string, string>();
  for (const [date, content] of Object.entries(notes))
    vault.set(`Daily/${date}.md`, content);

  const bot = {
    command: (name: string, fn: (ctx: any) => Promise<void>) =>
      void commands.set(name, fn),
    api: {
      sendMessage: async (chat: number, text: string, opts: any) => {
        events.push(`send:${text}`);
        sent.push({ chat, text, opts });
        return { message_id: FLOW_MSG };
      },
      editMessageText: async (
        chat: number,
        id: number,
        text: string,
        opts: any,
      ) => {
        events.push(`edit:${id}:${text}`);
        edits.push({ chat, id, text, opts });
      },
      deleteMessage: async (chat: number, id: number) => {
        events.push(`delete:${id}`);
        deletes.push([chat, id]);
        if (opts.deleteFails) throw new Error("message to delete not found");
      },
    },
  };
  const obsidian = {
    readDailyNote: async (date: string) => {
      reads.push(date);
      const content = vault.get(`Daily/${date}.md`);
      return content === undefined
        ? null
        : { path: `Daily/${date}.md`, content };
    },
    readNote: async (path: string) => {
      const content = vault.get(path);
      if (content === undefined) throw new Error(`note not found: ${path}`);
      return content;
    },
    writeNote: async (path: string, content: string) => {
      events.push(`write:${path}`);
      writes.push({ path, content });
      vault.set(path, content);
    },
    withNoteLock: async (_path: string, fn: () => Promise<unknown>) => {
      events.push("lock");
      return fn();
    },
  };
  const habits = new HabitsCommand(bot as any, testConfig, obsidian as any);
  habits.register();

  const tap = async (
    date: string | undefined,
    action?: string,
    verd?: string,
    messageId: number | null = FLOW_MSG,
  ) => {
    const toasts: (string | undefined)[] = [];
    const ctx = {
      callbackQuery: messageId ? { message: { message_id: messageId } } : {},
      answerCallbackQuery: async (answer?: { text: string }) => {
        events.push(`answer:${answer?.text ?? ""}`);
        toasts.push(answer?.text);
      },
    };
    await habits.handleTap(ctx, date, action, verd);
    return toasts;
  };
  const reply = async (promptText: string, text: string) => {
    const replies: string[] = [];
    const ctx = {
      chat: { id: 77 },
      message: {
        message_id: 900,
        text,
        reply_to_message: { text: promptText },
      },
      reply: async (message: string) => void replies.push(message),
    };
    await habits.handleReply(ctx);
    return replies;
  };
  const slash = async (match: string) => {
    const replies: string[] = [];
    await commands.get("habits")!({
      match,
      reply: async (message: string) => void replies.push(message),
    });
    return replies;
  };
  return {
    habits,
    events,
    sent,
    edits,
    deletes,
    writes,
    reads,
    vault,
    tap,
    reply,
    slash,
  };
}

test("/habits with a malformed date answers with usage and starts nothing", async () => {
  const fixture = harness();
  assert.deepEqual(await fixture.slash("yesterday"), [
    "Usage: /habits or /habits YYYY-MM-DD",
  ]);
  assert.deepEqual(fixture.reads, []);
  assert.deepEqual(fixture.sent, []);
});

test("/habits with no argument reviews yesterday", async () => {
  const fixture = harness({});
  await fixture.slash("");
  assert.deepEqual(fixture.reads, [previousDate()]);
  assert.equal(fixture.sent[0]?.text, `No habits found for ${previousDate()}.`);
});

test("/habits with a date sends one Begin card counting what is pending", async () => {
  const fixture = harness();
  assert.deepEqual(await fixture.slash(` ${DATE} `), []);
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0]!.chat, CHAT);
  assert.equal(
    fixture.sent[0]!.text,
    `🌱 Time to review habits for ${DATE} ${String.fromCharCode(8212)} 2 to go.`,
  );
  assert.deepEqual(buttons(fixture.sent[0]!.opts), [
    [{ text: "🌱 Begin", callback_data: `hb:${DATE}:begin` }],
  ]);
});

test("a day already reviewed is skipped: said aloud for /habits, silent for the nightly prompt", async () => {
  const manual = harness({ [DATE]: REVIEWED });
  await manual.habits.prompt(DATE, true);
  assert.deepEqual(manual.events, [
    `send:✅ Habits already reviewed for ${DATE}.`,
  ]);

  const nightly = harness({ [DATE]: REVIEWED });
  await nightly.habits.prompt(DATE);
  assert.deepEqual(nightly.events, []);
});

test("a day with nothing left to tick is skipped, and a missing note is told apart from a finished one", async () => {
  const done = harness({ [DATE]: ALL_DONE });
  await done.habits.prompt(DATE, true);
  assert.deepEqual(done.events, [
    `send:✅ All habits already done for ${DATE}.`,
  ]);

  const missing = harness({});
  await missing.habits.prompt(DATE, true);
  assert.deepEqual(missing.events, [`send:No habits found for ${DATE}.`]);

  const nightly = harness({});
  await nightly.habits.prompt(DATE);
  assert.deepEqual(nightly.events, []);
});

test("Begin answers the tap empty, then edits the card into the first pending question with Yes and No", async () => {
  const fixture = harness();
  await fixture.habits.prompt(DATE);
  const toasts = await fixture.tap(DATE, "begin");
  assert.deepEqual(toasts, [undefined]);
  assert.equal(fixture.edits.length, 1);
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

test("Begin edits the message that was tapped, even when the prompt was sent before a restart", async () => {
  const fixture = harness();
  await fixture.tap(DATE, "begin", undefined, 321);
  assert.equal(fixture.edits.length, 1);
  assert.equal(fixture.edits[0]!.id, 321);
});

test("Yes ticks the line and stamps its completion before answering the tap, then asks the next habit", async () => {
  const fixture = harness();
  await fixture.habits.prompt(DATE);
  fixture.events.length = 0;
  await fixture.tap(DATE, "0", "y");
  assert.deepEqual(fixture.writes, [
    {
      path: PATH,
      content: NOTE.replace(
        "- [ ] Practiced music #meta/habits/music",
        `- [x] Practiced music #meta/habits/music [completion:: ${DATE}]`,
      ),
    },
  ]);
  assert.deepEqual(fixture.events, [
    `write:${PATH}`,
    "answer:",
    `edit:${FLOW_MSG}:🌱 Pages read? Reply to this message with a number.\n(hb:${DATE}:1)`,
  ]);
  assert.equal(fixture.edits[0]!.opts, undefined);
});

test("No leaves the note untouched and moves on to the next habit", async () => {
  const fixture = harness();
  await fixture.habits.prompt(DATE);
  await fixture.tap(DATE, "0", "n");
  assert.deepEqual(fixture.writes, []);
  assert.match(fixture.edits[0]!.text, /^🌱 Pages read\?/);
});

test("answering a value habit fills the number, ticks the line, deletes the reply, and finishes the review", async () => {
  const fixture = harness();
  await fixture.habits.prompt(DATE);
  await fixture.tap(DATE, "0", "n");
  const prompt = fixture.edits[0]!.text;
  const replies = await fixture.reply(prompt, " 42 ");
  assert.deepEqual(replies, []);
  assert.deepEqual(fixture.deletes.slice(0, 1), [[77, 900]]);
  const after = fixture.vault.get(PATH)!;
  assert.match(
    after,
    new RegExp(
      `- \\[x\\] \\[Pages read:: 42\\] #meta/habits/reading \\[completion:: ${DATE}\\]`,
    ),
  );
  assert.match(after, /habitsReviewed: true/);
  assert.deepEqual(fixture.deletes, [
    [77, 900],
    [CHAT, FLOW_MSG],
  ]);
});

test("finishing stamps habitsReviewed under the note lock, keeps the other frontmatter, and a second run is refused", async () => {
  const fixture = harness();
  await fixture.habits.prompt(DATE);
  await fixture.tap(DATE, "0", "y");
  fixture.events.length = 0;
  await fixture.reply(fixture.edits[0]!.text, "12");
  assert.deepEqual(fixture.events, [
    `write:${PATH}`,
    "delete:900",
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
    fixture.sent.at(-1)!.text,
    `✅ Habits already reviewed for ${DATE}.`,
  );
});

test("a reply that is not a number is refused and nothing is written", async () => {
  const fixture = harness();
  await fixture.habits.prompt(DATE);
  await fixture.tap(DATE, "0", "n");
  const replies = await fixture.reply(fixture.edits[0]!.text, "a lot");
  assert.deepEqual(replies, ["That's not a number. Reply with a number only."]);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.deletes, []);
});

test("a decimal and a negative number are both accepted as a value", async () => {
  for (const value of ["2.5", "-3"]) {
    const fixture = harness();
    await fixture.habits.prompt(DATE);
    await fixture.reply(`(hb:${DATE}:1)`, value);
    assert.match(
      fixture.vault.get(PATH)!,
      new RegExp(`\\[Pages read:: ${value}\\]`),
    );
  }
});

test("a reply to something that is not a habit question is ignored", async () => {
  const fixture = harness();
  assert.deepEqual(await fixture.reply("some other message", "5"), []);
  assert.deepEqual(fixture.events, []);
});

test("a value reply for a habit that is gone gets a plain answer and no write", async () => {
  const noHabit = harness();
  assert.deepEqual(await noHabit.reply(`(hb:${DATE}:9)`, "5"), [
    "Couldn't find that habit to update.",
  ]);
  assert.deepEqual(noHabit.writes, []);

  const noNote = harness({});
  assert.deepEqual(await noNote.reply(`(hb:${DATE}:1)`, "5"), [
    "Couldn't find that habit to update.",
  ]);
});

test("a failed delete of the user's reply does not stop the review", async () => {
  const fixture = harness({ [DATE]: NOTE }, { deleteFails: true });
  await fixture.habits.prompt(DATE);
  await fixture.tap(DATE, "0", "y");
  await fixture.reply(fixture.edits[0]!.text, "30");
  assert.match(fixture.vault.get(PATH)!, /habitsReviewed: true/);
  assert.deepEqual(fixture.deletes, [
    [77, 900],
    [CHAT, FLOW_MSG],
  ]);
});

test("a tap with a bad date or a non-numeric index is answered 'bad habit' and touches nothing", async () => {
  const fixture = harness();
  assert.deepEqual(await fixture.tap(undefined, "begin"), ["bad habit"]);
  assert.deepEqual(await fixture.tap("2026-7-5", "0", "y"), ["bad habit"]);
  assert.deepEqual(await fixture.tap(DATE, "x", "y"), ["bad habit"]);
  assert.deepEqual(fixture.reads, []);
  assert.deepEqual(fixture.writes, []);
});

test("a stale tap on a habit that no longer exists is answered 'gone'", async () => {
  const fixture = harness();
  assert.deepEqual(await fixture.tap(DATE, "9", "y"), ["gone"]);
  assert.deepEqual(await fixture.tap("2026-01-01", "0", "y"), ["gone"]);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.edits, []);
});

test("when the note disappears mid-review the card is deleted and the flow stops", async () => {
  const fixture = harness();
  await fixture.habits.prompt(DATE);
  fixture.vault.delete(PATH);
  await fixture.tap(DATE, "begin");
  assert.deepEqual(fixture.deletes, [[CHAT, FLOW_MSG]]);
  assert.deepEqual(fixture.edits, []);
});

test("after a restart a Yes tap is still recorded but there is no card to continue on", async () => {
  const fixture = harness();
  const toasts = await fixture.tap(DATE, "0", "y", null);
  assert.deepEqual(toasts, [undefined]);
  assert.equal(fixture.writes.length, 1);
  assert.deepEqual(fixture.edits, []);
});
