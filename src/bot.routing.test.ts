import assert from "node:assert/strict";
import { test } from "node:test";
import type { Jot } from "./db.ts";
import { parseHabitRef } from "./lib/habits.ts";
import {
  botHarness,
  EM,
  type Harness,
  JOT_ID,
  type Run,
  sampleJot,
} from "./test/bot-harness.ts";
import { parseFollowupRef } from "./views/replies/followup.ts";

const FALLBACK = "scriba handles text, voice, images, and video for now.";
const COMMAND_ON = "🧭 Command mode is on.";

const first = (texts: string[]) => texts[0] ?? "";
const sticker = {
  sticker: {
    file_id: "s",
    file_unique_id: "su",
    type: "regular",
    width: 1,
    height: 1,
    is_animated: false,
    is_video: false,
  },
};
const photoSizes = (...ids: string[]) =>
  ids.map((file_id) => ({
    file_id,
    file_unique_id: file_id,
    width: 1,
    height: 1,
  }));

/** Collects every jot row the intake inserts. */
function rowsOf(harness: Harness): Jot[] {
  const rows: Jot[] = [];
  harness.repo.insertJot = (row: Jot) => void rows.push(row);
  return rows;
}

/** Command mode with its agent turn replaced, so a routed message is observable without
 *  starting the SDK. */
async function openCommandMode(harness: Harness): Promise<string[]> {
  await harness.say("/command");
  assert.equal(harness.bot.command.isOpen(), true);
  const handled: string[] = [];
  harness.bot.command.handle = async (_ctx: unknown, text: string) =>
    void handled.push(text);
  return handled;
}

test("a slash command is claimed before the text handler", async () => {
  const harness = await botHarness();
  const run = await harness.say("/start");
  assert.equal(run.rendered, "tg.sendMessage");
  assert.equal(
    first(run.texts("sendMessage")),
    "scriba ready. Send text or a voice note to journal. /help for admin commands.",
  );
});

test("text starting with / is ignored when no command claims it, in every mode", async () => {
  const harness = await botHarness();
  assert.equal((await harness.say("/nosuchcommand")).rendered, "");
  assert.equal((await harness.say("/ not a command entity")).rendered, "");

  await harness.say("/task");
  assert.equal((await harness.say("/nosuchcommand")).rendered, "");
  await harness.say("/done");

  const handled = await openCommandMode(harness);
  assert.equal((await harness.say("/nosuchcommand")).rendered, "");
  assert.deepEqual(handled, []);
});

test("plain text is an intake: lookup, react, insert, map, note, queue, in that order", async () => {
  const harness = await botHarness();
  const run = await harness.say("bought milk");
  assert.equal(
    run.rendered,
    "repo.lastPendingEnrichableJot > tg.setMessageReaction > repo.insertJot > repo.mapMessage > obsidian.ensureDailyNote > obsidian.appendJournalLine > queue.add",
  );
  assert.equal(
    run.calls.find((call) => call.method === "setMessageReaction")?.payload
      .reaction[0].emoji,
    "✍",
  );
});

test("a squashed follower reacts 🤝 and writes no placeholder of its own", async () => {
  const harness = await botHarness();
  harness.repo.lastPendingEnrichableJot = sampleJot({ status: "pending" });
  const run = await harness.say("and bread");
  assert.equal(
    run.rendered,
    "repo.lastPendingEnrichableJot > tg.setMessageReaction > repo.insertJot > repo.mapMessage > queue.add",
  );
  assert.equal(
    run.calls.find((call) => call.method === "setMessageReaction")?.payload
      .reaction[0].emoji,
    "🤝",
  );
});

test("command mode takes the text before any reply routing", async () => {
  const harness = await botHarness();
  const handled = await openCommandMode(harness);
  const rows = rowsOf(harness);
  await harness.say("research cats");
  await harness.say("1", {
    message_id: 7,
    text: "🌱 Pages read? (hb:2026-08-15:1)",
  });
  assert.deepEqual(handled, ["research cats", "1"]);
  assert.deepEqual(rows, []);
});

test("a message stream mode refuses to open over the other one", async () => {
  const harness = await botHarness();
  await harness.say("/task");
  assert.equal(
    first((await harness.say("/command")).texts("sendMessage")),
    "📝 Task mode is open. Send /done to close it first, then /command.",
  );
  await harness.say("/done");
  await harness.say("/command");
  assert.equal(
    first((await harness.say("/task")).texts("sendMessage")),
    "🧭 Command mode is open. Send /done to close it first, then /task.",
  );
});

test("/command re-opens and resets the session without an 'already open' check", async () => {
  const harness = await botHarness();
  await harness.say("/command");
  harness.bot.command.sessionId = "previous-session";
  const run = await harness.say("/command");
  assert.equal(
    first(run.texts("sendMessage")).slice(0, COMMAND_ON.length),
    COMMAND_ON,
  );
  assert.equal(harness.bot.command.sessionId, undefined);
});

test("/command is refused without a vault path", async () => {
  const harness = await botHarness();
  harness.bot.command.service = { enabled: false };
  assert.equal(
    first((await harness.say("/command")).texts("sendMessage")),
    `⚠️ command mode needs SCRIBA_VAULT_HOST_PATH ${EM} the vault isn't mounted.`,
  );
  assert.equal(harness.bot.command.isOpen(), false);
});

test("/task while task mode is on says so, and keeps it on", async () => {
  const harness = await botHarness();
  await harness.say("/task");
  assert.equal(
    first((await harness.say("/task")).texts("sendMessage")),
    "📝 Task mode is already on. /done closes it.",
  );
  assert.equal(harness.bot.tasks.isOpen(), true);
});

test("/done closes whichever mode is open, and says so when none is", async () => {
  const harness = await botHarness();
  assert.equal(
    first((await harness.say("/done")).texts("sendMessage")),
    "Command mode isn't open.",
  );
  await harness.say("/task");
  assert.equal(
    first((await harness.say("/done")).texts("sendMessage")),
    `📝 Task mode off ${EM} back to journaling.`,
  );
  await harness.say("/command");
  assert.equal(
    first((await harness.say("/done")).texts("sendMessage")),
    `🧭 Command mode off ${EM} back to journaling.`,
  );
  assert.equal(harness.bot.command.isOpen(), false);
});

// --- replies ---

const HABIT =
  "🌱 Pages read? Reply to this message with a number.\n(hb:2026-08-15:1)";
const FOLLOWUP =
  "💡 Learned anything today? Reply to this message, or skip.\n(fu:t:2026-08-15)";
const WIZARD =
  "✂️ Reply to this message with how many characters one journal entry may be. (es:n)";
const TASK = "🏁 Reply to this message with the due date. (tk:u:abc123)";

test("a reply goes to the first owner of its prompt: habit, follow-up, wizard, task prompt, task mode, edit", async () => {
  const harness = await botHarness();
  const rows = rowsOf(harness);
  const all = [HABIT, FOLLOWUP, WIZARD, TASK].join("\n");
  const reply = (text: string, prompt: string) =>
    harness.say(text, { message_id: 7, text: prompt });

  const habit = await reply("abc", all);
  assert.equal(
    first(habit.texts("sendMessage")),
    "That's not a number. Reply with a number only.",
  );

  assert.equal(rows.length, 0);
  await reply("a thing I learned", [FOLLOWUP, WIZARD, TASK].join("\n"));
  assert.equal(rows[0]?.section, "til");
  assert.equal(rows[0]?.raw_text, "a thing I learned");
  assert.equal(rows[0]?.note_path, "notes/daily notes/2026-08-15.md");

  const wizard = await reply("abc", [WIZARD, TASK].join("\n"));
  assert.equal(
    first(wizard.texts("sendMessage")),
    'Give me a whole number between 40 and 4000, or "off".',
  );

  const task = await reply("friday", TASK);
  assert.equal(
    first(task.texts("sendMessage")),
    "That task is already settled.",
  );

  const edit = await reply("make it shorter", "✅ some other message");
  assert.equal(edit.rendered, "repo.jotForMessage > tg.sendMessage");
  assert.equal(
    first(edit.texts("sendMessage")),
    "Can't find that jot to edit.",
  );
});

test("while task mode is open a reply is a task, and a task prompt still wins", async () => {
  const harness = await botHarness();
  await harness.say("/task");
  const reply = await harness.say("buy cat sand next week", {
    message_id: 7,
    text: "✅ some other message",
  });
  assert.equal(reply.rendered.startsWith("repo.insertTaskDraft"), true);

  const prompt = await harness.say("friday", { message_id: 8, text: TASK });
  assert.equal(
    first(prompt.texts("sendMessage")),
    "That task is already settled.",
  );
  assert.equal(prompt.events.includes("repo.insertTaskDraft"), false);
});

test("task mode takes the text that is not a reply, instead of an intake", async () => {
  const harness = await botHarness();
  const rows = rowsOf(harness);
  await harness.say("/task");
  const run = await harness.say("buy cat sand next week");
  assert.equal(run.events.includes("repo.insertTaskDraft"), true);
  assert.deepEqual(rows, []);
});

// --- media ---

test("a voice note or audio file while task mode is open becomes a spoken task", async () => {
  const harness = await botHarness();
  const rows = rowsOf(harness);
  harness.bot.downloadFile = async () => ({
    bytes: new Uint8Array(),
    ext: "oga",
    mime: "audio/ogg",
  });
  harness.transcriber.transcribe = "buy cat sand next week";
  await harness.say("/task");
  const voice = await harness.media({
    voice: { file_id: "v1", file_unique_id: "u1", duration: 3 },
  });
  assert.equal(
    voice.rendered,
    "tg.setMessageReaction > transcriber.transcribe > repo.insertTaskDraft > tg.sendMessage > repo.updateTaskDraft",
  );
  const audio = await harness.media({
    audio: { file_id: "a1", file_unique_id: "u2", duration: 3 },
  });
  assert.equal(audio.events.includes("repo.insertTaskDraft"), true);
  assert.deepEqual(rows, []);
});

test("a voice note or audio file with task mode closed is an audio jot", async () => {
  const harness = await botHarness();
  const rows = rowsOf(harness);
  await harness.media({
    voice: { file_id: "v1", file_unique_id: "u1", duration: 3 },
  });
  await harness.media({
    audio: { file_id: "a1", file_unique_id: "u2", duration: 3 },
  });
  assert.deepEqual(
    rows.map((row) => [row.kind, row.file_id]),
    [
      ["audio", "v1"],
      ["audio", "a1"],
    ],
  );
});

test("captionless photo and video store an empty text, a video note stores none", async () => {
  const harness = await botHarness();
  const rows = rowsOf(harness);
  await harness.media({ photo: photoSizes("small", "big") });
  await harness.media({
    video: {
      file_id: "vid",
      file_unique_id: "vu",
      width: 1,
      height: 1,
      duration: 1,
    },
  });
  await harness.media({
    video_note: {
      file_id: "note",
      file_unique_id: "nu",
      length: 1,
      duration: 1,
    },
  });
  assert.deepEqual(
    rows.map((row) => [row.kind, row.file_id, row.raw_text]),
    [
      ["image", "big", ""],
      ["video", "vid", ""],
      ["video", "note", null],
    ],
  );
});

test("a message of any other kind gets the fallback reply, last", async () => {
  const harness = await botHarness();
  const run = await harness.media(sticker);
  assert.equal(run.rendered, "tg.sendMessage");
  assert.equal(first(run.texts("sendMessage")), FALLBACK);
});

// --- edited messages ---

test("an edited caption starting with / is applied while edited text starting with / is ignored", async () => {
  const harness = await botHarness();
  harness.repo.jotForMessage = JOT_ID;
  harness.repo.getJot = sampleJot({ status: "processing" });
  const queued: string[] = [];
  harness.repo.queueEdit = (_id: string, text: string) =>
    void queued.push(text);

  const text = await harness.edited({ text: "/looks like a command" });
  assert.equal(text.rendered, "");
  assert.deepEqual(queued, []);

  const caption = await harness.edited({
    caption: "/looks like a command",
    photo: photoSizes("p"),
  });
  assert.equal(
    caption.rendered,
    "repo.jotForMessage > repo.getJot > repo.queueEdit > tg.sendMessage",
  );
  assert.deepEqual(queued, ["/looks like a command"]);
});

test("an edited text is queued while the jot is still processing", async () => {
  const harness = await botHarness();
  harness.repo.jotForMessage = JOT_ID;
  harness.repo.getJot = sampleJot({ status: "processing" });
  const run = await harness.edited({ text: "bought oat milk" });
  assert.equal(
    run.rendered,
    "repo.jotForMessage > repo.getJot > repo.queueEdit > tg.sendMessage",
  );
  assert.equal(
    first(run.texts("sendMessage")),
    `⏳ still processing ${EM} I'll apply that edit once it's done.`,
  );
});

// --- prompts that carry a marker ---

type Owner = "habit" | "followup" | "wizard" | "task";
type Producer = {
  name: string;
  owner: Owner;
  text: string;
  /** Drives the bot until the prompt is on screen and returns its text. */
  produce: (harness: Harness) => Promise<string>;
};

const sent = async (run: Promise<Run>) =>
  first((await run).texts("sendMessage"));
const withFlow = (harness: Harness) => {
  harness.bot.menu.pending = { words: ["milk"], i: 0, query: "milk", page: 0 };
};
const withDraft = (harness: Harness) => {
  harness.repo.getTaskDraft = { id: "d1d1d1d1", status: "pending", chat_id: 1 };
};

const PRODUCERS: Producer[] = [
  {
    name: "habit value question",
    owner: "habit",
    text: "🌱 Pages read? Reply to this message with a number.\n(hb:2026-08-15:0)",
    produce: async (harness) => {
      harness.obsidian.readDailyNote = {
        path: "p.md",
        content: "## Habits\n- [ ] [Pages read:: 0] #meta/habits/reading\n",
      };
      return first(
        (await harness.tap("hb:2026-08-15:begin")).texts("editMessageText"),
      );
    },
  },
  {
    name: "follow-up question, journal line",
    owner: "followup",
    text: "📝 One line for the day? Reply to this message, or skip.\n(fu:j:2026-08-15)",
    produce: (harness) => {
      harness.repo.recordRating = { recorded: true, current: 5 };
      return sent(harness.tap("rate:2026-08-15:5"));
    },
  },
  {
    name: "follow-up question, TIL",
    owner: "followup",
    text: "💡 Learned anything today? Reply to this message, or skip.\n(fu:t:2026-08-15)",
    produce: (harness) => sent(harness.tap("fu:j:2026-08-15")),
  },
  {
    name: "never-link words",
    owner: "wizard",
    text: "➕ Reply to this message with the word(s) that should never be linked. One per line, or comma-separated. (lw:sw)",
    produce: (harness) => sent(harness.tap("menu:lswa")),
  },
  {
    name: "always-link words",
    owner: "wizard",
    text: `➕ Reply to this message with the word(s) that should always link. One per line, or comma-separated ${EM} spaces are fine, and I'll ask for each one's note next. (lw:rg)`,
    produce: (harness) => sent(harness.tap("menu:lrga")),
  },
  {
    name: "note search",
    owner: "wizard",
    text: '🔎 Search the vault for the note "milk" should link to. Reply to this message with any part of its title. (lw:rgn)',
    produce: (harness) => {
      withFlow(harness);
      return sent(harness.tap("menu:lrgq"));
    },
  },
  {
    name: "typed note title",
    owner: "wizard",
    text: `✍️ Reply to this message with the exact title of the note "milk" should link to ${EM} it doesn't have to exist yet. (lw:rgm)`,
    produce: (harness) => {
      withFlow(harness);
      return sent(harness.tap("menu:lrgm"));
    },
  },
  {
    name: "pair rename",
    owner: "wizard",
    text: "✏️ Reply to this message with the new word for this pair. (lw:rgw:3)",
    produce: (harness) => sent(harness.tap("menu:lrgw:3")),
  },
  {
    name: "entry size",
    owner: "wizard",
    text: '✂️ Reply to this message with how many characters one journal entry may be: 40–4000, or "off" to stop splitting. (es:n)',
    produce: (harness) => sent(harness.tap("menu:esc")),
  },
  {
    name: "enrichment model",
    owner: "wizard",
    text: "🧠 Reply with the model ID for enrichment (e.g. claude-sonnet-5): (md:em)",
    produce: (harness) => sent(harness.tap("menu:emc")),
  },
  {
    name: "voice fix model",
    owner: "wizard",
    text: "🧠 Reply with the model ID for voice fix (e.g. claude-sonnet-5): (md:vfm)",
    produce: (harness) => sent(harness.tap("menu:vfc")),
  },
  {
    name: "rating time",
    owner: "wizard",
    text: "🕛 Reply to this message with the time for the nightly rating, as HH:MM in 24-hour time, like 23:30. A time before 12:00 rates the day that just ended, a later one rates today. (rt:time)",
    produce: (harness) => sent(harness.tap("menu:rtt")),
  },
  {
    name: "/taskadd without text",
    owner: "task",
    text: `📝 Reply to this message with the task ${EM} say when it's due in your own words. (tk:add)`,
    produce: (harness) => sent(harness.say("/taskadd")),
  },
  {
    name: "task description",
    owner: "task",
    text: "✏️ Reply to this message with what the task should say. (tk:d:d1d1d1d1)",
    produce: (harness) => {
      withDraft(harness);
      return sent(harness.tap("tk:d:d1d1d1d1"));
    },
  },
  {
    name: "task start date",
    owner: "task",
    text: `📅 Reply to this message with the start date ${EM} a date, “next monday”, or “none” to leave it to the deadline. (tk:s:d1d1d1d1)`,
    produce: (harness) => {
      withDraft(harness);
      return sent(harness.tap("tk:s:d1d1d1d1"));
    },
  },
  {
    name: "task due date",
    owner: "task",
    text: `🏁 Reply to this message with the due date ${EM} a date, or something like “next friday”. This one it needs. (tk:u:d1d1d1d1)`,
    produce: (harness) => {
      withDraft(harness);
      return sent(harness.tap("tk:u:d1d1d1d1"));
    },
  },
];

test("every marker-bearing prompt is worded as before", async () => {
  const actual: Record<string, string> = {};
  for (const producer of PRODUCERS)
    actual[producer.name] = await producer.produce(await botHarness());
  assert.deepEqual(
    actual,
    Object.fromEntries(
      PRODUCERS.map((producer) => [producer.name, producer.text]),
    ),
  );
});

test("every marker-bearing prompt is claimed by the flow that sent it and by no other", async () => {
  const harness = await botHarness();
  const claimedBy = (text: string): Owner[] =>
    (
      [
        ["habit", parseHabitRef(text) !== null],
        ["followup", parseFollowupRef(text) !== null],
        ["wizard", harness.bot.menu.isWizardPrompt(text)],
        ["task", harness.bot.tasks.isTaskPrompt(text)],
      ] as const
    )
      .filter(([, claimed]) => claimed)
      .map(([owner]) => owner);
  for (const producer of PRODUCERS)
    assert.deepEqual(claimedBy(producer.text), [producer.owner], producer.name);
});
