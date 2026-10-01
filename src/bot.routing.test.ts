import assert from "node:assert/strict";
import { test } from "node:test";
import type { Jot } from "./db.ts";
import { parseHabitRef } from "./flows/habits/parse.ts";
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
function rowsOf(h: Harness): Jot[] {
  const rows: Jot[] = [];
  h.repo.insertJot = (row: Jot) => void rows.push(row);
  return rows;
}

/** Command mode with its agent turn replaced, so a routed message is observable without
 *  starting the SDK. */
async function openCommandMode(h: Harness): Promise<string[]> {
  await h.say("/command");
  assert.equal(h.bot.command.isOpen(), true);
  const handled: string[] = [];
  h.bot.command.handle = async (_ctx: unknown, text: string) =>
    void handled.push(text);
  return handled;
}

test("a slash command is claimed before the text handler", async () => {
  const h = await botHarness();
  const run = await h.say("/start");
  assert.equal(run.rendered, "tg.sendMessage");
  assert.equal(
    first(run.texts("sendMessage")),
    "scriba ready. Send text or a voice note to journal. /help for admin commands.",
  );
});

test("text starting with / is ignored when no command claims it, in every mode", async () => {
  const h = await botHarness();
  assert.equal((await h.say("/nosuchcommand")).rendered, "");
  assert.equal((await h.say("/ not a command entity")).rendered, "");

  await h.say("/task");
  assert.equal((await h.say("/nosuchcommand")).rendered, "");
  await h.say("/done");

  const handled = await openCommandMode(h);
  assert.equal((await h.say("/nosuchcommand")).rendered, "");
  assert.deepEqual(handled, []);
});

test("plain text is an intake: lookup, react, insert, map, note, queue, in that order", async () => {
  const h = await botHarness();
  const run = await h.say("bought milk");
  assert.equal(
    run.rendered,
    "repo.lastPendingEnrichableJot > tg.setMessageReaction > repo.insertJot > repo.mapMessage > obsidian.ensureDailyNote > obsidian.appendJournalLine > queue.add",
  );
  assert.equal(
    run.calls.find((c) => c.method === "setMessageReaction")?.payload
      .reaction[0].emoji,
    "✍",
  );
});

test("a squashed follower reacts 🤝 and writes no placeholder of its own", async () => {
  const h = await botHarness();
  h.repo.lastPendingEnrichableJot = sampleJot({ status: "pending" });
  const run = await h.say("and bread");
  assert.equal(
    run.rendered,
    "repo.lastPendingEnrichableJot > tg.setMessageReaction > repo.insertJot > repo.mapMessage > queue.add",
  );
  assert.equal(
    run.calls.find((c) => c.method === "setMessageReaction")?.payload
      .reaction[0].emoji,
    "🤝",
  );
});

test("command mode takes the text before any reply routing", async () => {
  const h = await botHarness();
  const handled = await openCommandMode(h);
  const rows = rowsOf(h);
  await h.say("research cats");
  await h.say("1", { message_id: 7, text: "🌱 Pages read? (hb:2026-08-15:1)" });
  assert.deepEqual(handled, ["research cats", "1"]);
  assert.deepEqual(rows, []);
});

test("a message stream mode refuses to open over the other one", async () => {
  const h = await botHarness();
  await h.say("/task");
  assert.equal(
    first((await h.say("/command")).texts("sendMessage")),
    "📝 Task mode is open. Send /done to close it first, then /command.",
  );
  await h.say("/done");
  await h.say("/command");
  assert.equal(
    first((await h.say("/task")).texts("sendMessage")),
    "🧭 Command mode is open. Send /done to close it first, then /task.",
  );
});

test("/command re-opens and resets the session without an 'already open' check", async () => {
  const h = await botHarness();
  await h.say("/command");
  h.bot.command.sessionId = "previous-session";
  const run = await h.say("/command");
  assert.equal(
    first(run.texts("sendMessage")).slice(0, COMMAND_ON.length),
    COMMAND_ON,
  );
  assert.equal(h.bot.command.sessionId, undefined);
});

test("/command is refused without a vault path", async () => {
  const h = await botHarness();
  h.bot.command.service = { enabled: false };
  assert.equal(
    first((await h.say("/command")).texts("sendMessage")),
    `⚠️ command mode needs SCRIBA_VAULT_HOST_PATH ${EM} the vault isn't mounted.`,
  );
  assert.equal(h.bot.command.isOpen(), false);
});

test("/task while task mode is on says so, and keeps it on", async () => {
  const h = await botHarness();
  await h.say("/task");
  assert.equal(
    first((await h.say("/task")).texts("sendMessage")),
    "📝 Task mode is already on. /done closes it.",
  );
  assert.equal(h.bot.tasks.isOpen(), true);
});

test("/done closes whichever mode is open, and says so when none is", async () => {
  const h = await botHarness();
  assert.equal(
    first((await h.say("/done")).texts("sendMessage")),
    "Command mode isn't open.",
  );
  await h.say("/task");
  assert.equal(
    first((await h.say("/done")).texts("sendMessage")),
    `📝 Task mode off ${EM} back to journaling.`,
  );
  await h.say("/command");
  assert.equal(
    first((await h.say("/done")).texts("sendMessage")),
    `🧭 Command mode off ${EM} back to journaling.`,
  );
  assert.equal(h.bot.command.isOpen(), false);
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
  const h = await botHarness();
  const rows = rowsOf(h);
  const all = [HABIT, FOLLOWUP, WIZARD, TASK].join("\n");
  const reply = (text: string, prompt: string) =>
    h.say(text, { message_id: 7, text: prompt });

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
  const h = await botHarness();
  await h.say("/task");
  const reply = await h.say("buy cat sand next week", {
    message_id: 7,
    text: "✅ some other message",
  });
  assert.equal(reply.rendered.startsWith("repo.insertTaskDraft"), true);

  const prompt = await h.say("friday", { message_id: 8, text: TASK });
  assert.equal(
    first(prompt.texts("sendMessage")),
    "That task is already settled.",
  );
  assert.equal(prompt.events.includes("repo.insertTaskDraft"), false);
});

test("task mode takes the text that is not a reply, instead of an intake", async () => {
  const h = await botHarness();
  const rows = rowsOf(h);
  await h.say("/task");
  const run = await h.say("buy cat sand next week");
  assert.equal(run.events.includes("repo.insertTaskDraft"), true);
  assert.deepEqual(rows, []);
});

// --- media ---

test("a voice note or audio file while task mode is open becomes a spoken task", async () => {
  const h = await botHarness();
  const rows = rowsOf(h);
  h.bot.downloadFile = async () => ({
    bytes: new Uint8Array(),
    ext: "oga",
    mime: "audio/ogg",
  });
  h.transcriber.transcribe = "buy cat sand next week";
  await h.say("/task");
  const voice = await h.media({
    voice: { file_id: "v1", file_unique_id: "u1", duration: 3 },
  });
  assert.equal(
    voice.rendered,
    "tg.setMessageReaction > transcriber.transcribe > repo.insertTaskDraft > tg.sendMessage > repo.updateTaskDraft",
  );
  const audio = await h.media({
    audio: { file_id: "a1", file_unique_id: "u2", duration: 3 },
  });
  assert.equal(audio.events.includes("repo.insertTaskDraft"), true);
  assert.deepEqual(rows, []);
});

test("a voice note or audio file with task mode closed is an audio jot", async () => {
  const h = await botHarness();
  const rows = rowsOf(h);
  await h.media({
    voice: { file_id: "v1", file_unique_id: "u1", duration: 3 },
  });
  await h.media({
    audio: { file_id: "a1", file_unique_id: "u2", duration: 3 },
  });
  assert.deepEqual(
    rows.map((r) => [r.kind, r.file_id]),
    [
      ["audio", "v1"],
      ["audio", "a1"],
    ],
  );
});

test("captionless photo and video store an empty text, a video note stores none", async () => {
  const h = await botHarness();
  const rows = rowsOf(h);
  await h.media({ photo: photoSizes("small", "big") });
  await h.media({
    video: {
      file_id: "vid",
      file_unique_id: "vu",
      width: 1,
      height: 1,
      duration: 1,
    },
  });
  await h.media({
    video_note: {
      file_id: "note",
      file_unique_id: "nu",
      length: 1,
      duration: 1,
    },
  });
  assert.deepEqual(
    rows.map((r) => [r.kind, r.file_id, r.raw_text]),
    [
      ["image", "big", ""],
      ["video", "vid", ""],
      ["video", "note", null],
    ],
  );
});

test("a message of any other kind gets the fallback reply, last", async () => {
  const h = await botHarness();
  const run = await h.media(sticker);
  assert.equal(run.rendered, "tg.sendMessage");
  assert.equal(first(run.texts("sendMessage")), FALLBACK);
});

// --- edited messages ---

test("an edited caption starting with / is applied while edited text starting with / is ignored", async () => {
  const h = await botHarness();
  h.repo.jotForMessage = JOT_ID;
  h.repo.getJot = sampleJot({ status: "processing" });
  const queued: string[] = [];
  h.repo.queueEdit = (_id: string, text: string) => void queued.push(text);

  const text = await h.edited({ text: "/looks like a command" });
  assert.equal(text.rendered, "");
  assert.deepEqual(queued, []);

  const caption = await h.edited({
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
  const h = await botHarness();
  h.repo.jotForMessage = JOT_ID;
  h.repo.getJot = sampleJot({ status: "processing" });
  const run = await h.edited({ text: "bought oat milk" });
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
  produce: (h: Harness) => Promise<string>;
};

const sent = async (run: Promise<Run>) =>
  first((await run).texts("sendMessage"));
const withFlow = (h: Harness) => {
  h.bot.menu.pending = { words: ["milk"], i: 0, query: "milk", page: 0 };
};
const withDraft = (h: Harness) => {
  h.repo.getTaskDraft = { id: "d1d1d1d1", status: "pending", chat_id: 1 };
};

const PRODUCERS: Producer[] = [
  {
    name: "habit value question",
    owner: "habit",
    text: "🌱 Pages read? Reply to this message with a number.\n(hb:2026-08-15:0)",
    produce: async (h) => {
      h.obsidian.readDailyNote = {
        path: "p.md",
        content: "## Habits\n- [ ] [Pages read:: 0] #meta/habits/reading\n",
      };
      return first(
        (await h.tap("hb:2026-08-15:begin")).texts("editMessageText"),
      );
    },
  },
  {
    name: "follow-up question, journal line",
    owner: "followup",
    text: "📝 One line for the day? Reply to this message, or skip.\n(fu:j:2026-08-15)",
    produce: (h) => {
      h.repo.recordRating = { recorded: true, current: 5 };
      return sent(h.tap("rate:2026-08-15:5"));
    },
  },
  {
    name: "follow-up question, TIL",
    owner: "followup",
    text: "💡 Learned anything today? Reply to this message, or skip.\n(fu:t:2026-08-15)",
    produce: (h) => sent(h.tap("fu:j:2026-08-15")),
  },
  {
    name: "never-link words",
    owner: "wizard",
    text: "➕ Reply to this message with the word(s) that should never be linked. One per line, or comma-separated. (lw:sw)",
    produce: (h) => sent(h.tap("menu:lswa")),
  },
  {
    name: "always-link words",
    owner: "wizard",
    text: `➕ Reply to this message with the word(s) that should always link. One per line, or comma-separated ${EM} spaces are fine, and I'll ask for each one's note next. (lw:rg)`,
    produce: (h) => sent(h.tap("menu:lrga")),
  },
  {
    name: "note search",
    owner: "wizard",
    text: '🔎 Search the vault for the note "milk" should link to. Reply to this message with any part of its title. (lw:rgn)',
    produce: (h) => {
      withFlow(h);
      return sent(h.tap("menu:lrgq"));
    },
  },
  {
    name: "typed note title",
    owner: "wizard",
    text: `✍️ Reply to this message with the exact title of the note "milk" should link to ${EM} it doesn't have to exist yet. (lw:rgm)`,
    produce: (h) => {
      withFlow(h);
      return sent(h.tap("menu:lrgm"));
    },
  },
  {
    name: "pair rename",
    owner: "wizard",
    text: "✏️ Reply to this message with the new word for this pair. (lw:rgw:3)",
    produce: (h) => sent(h.tap("menu:lrgw:3")),
  },
  {
    name: "entry size",
    owner: "wizard",
    text: '✂️ Reply to this message with how many characters one journal entry may be: 40–4000, or "off" to stop splitting. (es:n)',
    produce: (h) => sent(h.tap("menu:esc")),
  },
  {
    name: "enrichment model",
    owner: "wizard",
    text: "🧠 Reply with the model ID for enrichment (e.g. claude-sonnet-5): (md:em)",
    produce: (h) => sent(h.tap("menu:emc")),
  },
  {
    name: "voice fix model",
    owner: "wizard",
    text: "🧠 Reply with the model ID for voice fix (e.g. claude-sonnet-5): (md:vfm)",
    produce: (h) => sent(h.tap("menu:vfc")),
  },
  {
    name: "rating time",
    owner: "wizard",
    text: "🕛 Reply to this message with the time for the nightly rating, as HH:MM in 24-hour time, like 23:30. A time before 12:00 rates the day that just ended, a later one rates today. (rt:time)",
    produce: (h) => sent(h.tap("menu:rtt")),
  },
  {
    name: "/taskadd without text",
    owner: "task",
    text: `📝 Reply to this message with the task ${EM} say when it's due in your own words. (tk:add)`,
    produce: (h) => sent(h.say("/taskadd")),
  },
  {
    name: "task description",
    owner: "task",
    text: "✏️ Reply to this message with what the task should say. (tk:d:d1d1d1d1)",
    produce: (h) => {
      withDraft(h);
      return sent(h.tap("tk:d:d1d1d1d1"));
    },
  },
  {
    name: "task start date",
    owner: "task",
    text: `📅 Reply to this message with the start date ${EM} a date, “next monday”, or “none” to leave it to the deadline. (tk:s:d1d1d1d1)`,
    produce: (h) => {
      withDraft(h);
      return sent(h.tap("tk:s:d1d1d1d1"));
    },
  },
  {
    name: "task due date",
    owner: "task",
    text: `🏁 Reply to this message with the due date ${EM} a date, or something like “next friday”. This one it needs. (tk:u:d1d1d1d1)`,
    produce: (h) => {
      withDraft(h);
      return sent(h.tap("tk:u:d1d1d1d1"));
    },
  },
];

test("every marker-bearing prompt is worded as before", async () => {
  const actual: Record<string, string> = {};
  for (const p of PRODUCERS)
    actual[p.name] = await p.produce(await botHarness());
  assert.deepEqual(
    actual,
    Object.fromEntries(PRODUCERS.map((p) => [p.name, p.text])),
  );
});

test("every marker-bearing prompt is claimed by the flow that sent it and by no other", async () => {
  const h = await botHarness();
  const claimedBy = (text: string): Owner[] =>
    (
      [
        ["habit", parseHabitRef(text) !== null],
        ["followup", parseFollowupRef(text) !== null],
        ["wizard", h.bot.menu.isWizardPrompt(text)],
        ["task", h.bot.tasks.isTaskPrompt(text)],
      ] as const
    )
      .filter(([, claimed]) => claimed)
      .map(([owner]) => owner);
  for (const p of PRODUCERS)
    assert.deepEqual(claimedBy(p.text), [p.owner], p.name);
});
