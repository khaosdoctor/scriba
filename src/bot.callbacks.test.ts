import assert from "node:assert/strict";
import { test } from "node:test";
import { AdminController } from "./controllers/admin.ts";
import { journalLine } from "./lib/note.ts";
import type { Jot } from "./models/domain.ts";
import { BOT_INFO, recordingApi } from "./test/fakes.ts";
import { noteOps } from "./test/note-ops.ts";
import { sampleJot } from "./test/sqlite.ts";

// config.ts reads process.env at import time, so the bot is imported after these are set.
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ALLOWED_TELEGRAM_USER_ID ??= "1";
process.env.OBSIDIAN_API_KEY ??= "o";

const NOW = Date.UTC(2026, 7, 16, 10, 0, 0);
const SEC = NOW / 1000;
const NOTE = "notes/daily notes/2026-08-16.md";
const ID = "aaaaaaaa";
const YT = "https://youtu.be/dQw4w9WgXcQ";

const jot = (over: Partial<Jot> = {}): Jot =>
  sampleJot(ID, {
    note_path: NOTE,
    raw_text: "bought milk",
    status: "done",
    received_at: NOW,
    updated_at: NOW,
    ...over,
  });

const noteWith = (text: string, id = ID) =>
  `# Journal\n${journalLine("10:00:00", text, id)}\n`;

const tick = () => new Promise<void>((r) => setImmediate(r));

type Opts = {
  jots?: Jot[];
  /** message id -> jot id; the default maps message 77 to the default jot */
  mapped?: [number, string][];
  notes?: Record<string, string>;
  followers?: Record<string, { id: string }[]>;
  queuedEdits?: Record<string, string[]>;
  rejections?: { surface: string; note: string }[];
  links?: Record<string, { jot_id: string; surface: string; note: string }>;
  unrejected?: number;
};

async function harness(over: Opts = {}) {
  const { ScribaBot } = await import("./bot.ts");
  const events: string[] = [];
  const rec = recordingApi({ onCall: (c) => events.push(`api.${c.method}`) });
  const jots = new Map((over.jots ?? [jot()]).map((j) => [j.id, j]));
  const messages = new Map<number, string>(over.mapped ?? [[77, ID]]);
  const notes = new Map(
    Object.entries(over.notes ?? { [NOTE]: noteWith("bought milk") }),
  );
  const queuedEdits: [string, string][] = [];
  const updates: [string, object][] = [];
  const rejected: [string, string][] = [];
  const unrejectCalls: [string, string][] = [];
  const editCalls: [string, string][] = [];
  const links = new Map(Object.entries(over.links ?? {}));

  const repo: any = {
    getJot: async (id: string) => jots.get(id),
    jotForMessage: async (m: number) => messages.get(m),
    mapMessage: async (m: number, id: string) => void messages.set(m, id),
    unmapMessage: async (m: number) => void messages.delete(m),
    messageForJot: async (id: string) =>
      [...messages].find(([, j]) => j === id)?.[0],
    insertJot: async (j: Jot) => void jots.set(j.id, j),
    lastPendingEnrichableJot: async () => undefined,
    queueEdit: async (id: string, text: string) =>
      void queuedEdits.push([id, text]),
    queuedEdits: async (id: string) => over.queuedEdits?.[id] ?? [],
    clearQueuedEdits: async (id: string) =>
      void events.push(`repo.clearQueuedEdits:${id}`),
    markDeleted: async (id: string) => {
      events.push(`repo.markDeleted:${id}`);
      const j = jots.get(id);
      if (j) jots.set(id, { ...j, status: "deleted" });
    },
    groupFollowers: async (id: string) => over.followers?.[id] ?? [],
    updateJot: async (id: string, patch: object) =>
      void updates.push([id, patch]),
    resetForRetry: async (id: string) =>
      void events.push(`repo.resetForRetry:${id}`),
    takePendingLink: async (pid: string) => {
      events.push(`repo.takePendingLink:${pid}`);
      const rec = links.get(pid);
      links.delete(pid);
      return rec;
    },
    reject: async (surface: string, note: string) => {
      events.push("repo.reject");
      rejected.push([surface, note]);
    },
    rejectionList: async () => over.rejections ?? [],
    unreject: async (surface: string, note: string) => {
      events.push("repo.unreject");
      unrejectCalls.push([surface, note]);
      return over.unrejected ?? 1;
    },
  };
  const obsidian: any = {
    dailyPath: (date: string) => `notes/daily notes/${date}.md`,
    ensureDailyNote: async () => {},
    appendJournalLine: async () => {},
    readNote: async (path: string) => {
      events.push("obsidian.read");
      return notes.get(path) ?? "";
    },
    writeNote: async (path: string, content: string) => {
      events.push("obsidian.write");
      notes.set(path, content);
    },
    ...noteOps(() => obsidian),
  };
  const enricher: any = {
    editText: async (text: string, instruction: string) => {
      editCalls.push([text, instruction]);
      return `${text} (${instruction})`;
    },
  };
  const bot: any = new ScribaBot(
    repo,
    obsidian,
    enricher,
    {} as any,
    {} as any,
    {} as any,
  );
  bot.setQueue({
    add: (ids: string[]) => void events.push(`queue.add:${ids.join(",")}`),
  });
  bot.setAdmin(new AdminController({ repo } as any));
  bot.bot.botInfo = BOT_INFO;
  bot.bot.api.config.use(rec.transformer as never);

  const from = { id: 1, is_bot: false, first_name: "me" };
  const chat = { id: 1, type: "private" as const };
  let updateId = 0;
  // Long polling routes a handler's BotError to bot.catch; handleUpdate alone rethrows it.
  const update = (u: object) =>
    bot.bot
      .handleUpdate({ update_id: ++updateId, ...u })
      .catch((err: unknown) => bot.bot.errorHandler(err));

  return {
    bot,
    repo,
    obsidian,
    events,
    api: rec.calls,
    apiResult: rec.results,
    failApi: rec.fail,
    answers: rec.answers,
    sends: () => rec.texts("sendMessage"),
    edits: () => rec.texts("editMessageText"),
    buttons: rec.buttons,
    jots,
    messages,
    notes,
    queuedEdits,
    updates,
    rejected,
    unrejectCalls,
    editCalls,
    note: () => notes.get(NOTE),
    tap: (data: string) =>
      update({
        callback_query: {
          id: `q${updateId}`,
          from,
          chat_instance: "c",
          data,
          message: {
            message_id: 50,
            date: SEC,
            chat,
            text: "card",
          },
        },
      }),
    send: (text: string, extra: object = {}) =>
      update({
        message: { message_id: 5, date: SEC, chat, from, text, ...extra },
      }),
    replyTo: (text: string, replyText = "an old message") =>
      update({
        message: {
          message_id: 6,
          date: SEC,
          chat,
          from,
          text,
          reply_to_message: {
            message_id: 77,
            date: SEC,
            chat,
            text: replyText,
          },
        },
      }),
    deleteCommand: (withReply: boolean, replyTo = 77) =>
      update({
        message: {
          message_id: 6,
          date: SEC,
          chat,
          from,
          text: "/delete",
          entities: [{ type: "bot_command", offset: 0, length: 7 }],
          reply_to_message: withReply
            ? { message_id: replyTo, date: SEC, chat, text: "an old message" }
            : undefined,
        },
      }),
    edited: (extra: object) =>
      update({
        edited_message: {
          message_id: 77,
          date: SEC,
          edit_date: SEC + 5,
          chat,
          from,
          ...extra,
        },
      }),
  };
}

// --- vf: voice fix choice ---

async function openVoiceFix(h: Awaited<ReturnType<typeof harness>>) {
  const pending: Promise<"original" | "proposed"> =
    h.bot.jotController.awaitVoiceFix(ID, "a <b> original", "the fixed one");
  while (!h.bot.jotController.voiceFixPending.has(ID)) await tick();
  return pending;
}

test("the voice-fix prompt shows both transcripts and the two choice buttons in one message", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness();
  const pending = openVoiceFix(h);
  await tick();
  const sent = h.api.find((c) => c.method === "sendMessage");
  assert.equal(
    sent?.payload.text,
    "<b>Original transcript:</b>\n<i>a &lt;b&gt; original</i>\n\n<b>Proposed fix:</b>\n<i>the fixed one</i>",
  );
  assert.equal(sent?.payload.parse_mode, "HTML");
  assert.deepEqual(h.buttons(sent), [
    ["📝 Use original", `vf:o:${ID}`],
    ["✨ Use fixed", `vf:p:${ID}`],
  ]);
  assert.deepEqual(
    h.api.map((c) => c.method),
    ["sendMessage"],
  );
  await h.tap(`vf:o:${ID}`);
  await pending;
});

test("tapping a voice-fix button resolves the wait with that choice", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [data, choice, toast] of [
    [`vf:p:${ID}`, "proposed", "using fixed version"],
    [`vf:o:${ID}`, "original", "keeping original"],
  ] as const) {
    const h = await harness();
    const pending = openVoiceFix(h);
    await tick();
    await h.tap(data);
    assert.equal(await pending, choice);
    assert.deepEqual(h.answers(), [toast]);
    assert.equal(h.bot.jotController.voiceFixPending.has(ID), false);
  }
});

test("an unanswered voice-fix prompt falls back to the original after five minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness();
  const pending = openVoiceFix(h);
  await tick();
  t.mock.timers.tick(5 * 60 * 1000);
  assert.equal(await pending, "original");
  assert.equal(h.bot.jotController.voiceFixPending.has(ID), false);

  await h.tap(`vf:p:${ID}`);
  assert.deepEqual(h.answers(), ["expired"]);
});

test("a voice-fix tap with no pending choice says expired, and a malformed one is just acknowledged", async () => {
  const h = await harness();
  await h.tap(`vf:o:${ID}`);
  await h.tap("vf:o");
  assert.deepEqual(h.answers(), ["expired", undefined]);
});

// --- rt: retry ---

test("retry resets the jot and queues it before answering, then rewrites the status card", async () => {
  const h = await harness({ jots: [jot({ status: "failed" })] });
  await h.tap(`rt:${ID}`);
  assert.deepEqual(h.events, [
    `repo.resetForRetry:${ID}`,
    `queue.add:${ID}`,
    "api.answerCallbackQuery",
    "api.editMessageText",
  ]);
  assert.deepEqual(h.answers(), ["retrying"]);
  assert.deepEqual(h.edits(), ["🔄 retrying…"]);
});

test("retry on a missing jot says gone, and on a deleted jot refuses to put the line back", async () => {
  const gone = await harness({ jots: [] });
  await gone.tap(`rt:${ID}`);
  assert.deepEqual(gone.answers(), ["gone"]);
  assert.deepEqual(gone.events, ["api.answerCallbackQuery"]);

  const deleted = await harness({ jots: [jot({ status: "deleted" })] });
  await deleted.tap(`rt:${ID}`);
  assert.deepEqual(deleted.answers(), ["deleted \u{2014} not retrying"]);
  assert.deepEqual(deleted.events, ["api.answerCallbackQuery"]);

  const bare = await harness();
  await bare.tap("rt");
  assert.deepEqual(bare.answers(), ["gone"]);
});

// --- un / dl: undo and discard ---

test("undo and discard answer first, then pull the line out and clear the buttons", async () => {
  for (const [ns, toast] of [
    ["un", "undoing"],
    ["dl", "deleting"],
  ] as const) {
    const h = await harness();
    await h.tap(`${ns}:${ID}`);
    assert.deepEqual(h.events, [
      "api.answerCallbackQuery",
      "obsidian.read",
      "obsidian.write",
      `repo.markDeleted:${ID}`,
      "api.sendMessage",
    ]);
    assert.deepEqual(h.answers(), [toast]);
    assert.deepEqual(h.sends(), ["🗑️ removed that from your journal."]);
    assert.deepEqual(
      h.buttons(h.api.find((c) => c.method === "sendMessage")),
      [],
    );
    assert.equal(h.note(), "# Journal\n\n");
  }
});

test("removing a squashed leader also marks its followers deleted", async () => {
  const h = await harness({
    jots: [jot(), jot({ id: "bbbbbbbb", anchor: ID })],
    followers: { [ID]: [{ id: "bbbbbbbb" }] },
  });
  await h.tap(`dl:${ID}`);
  assert.deepEqual(
    h.events.filter((e) => e.startsWith("repo.")),
    [`repo.markDeleted:${ID}`, "repo.markDeleted:bbbbbbbb"],
  );
});

test("removing a jot whose line is already gone still marks it deleted", async () => {
  const h = await harness({ notes: { [NOTE]: "# Journal\n" } });
  await h.tap(`un:${ID}`);
  assert.deepEqual(h.events, [
    "api.answerCallbackQuery",
    "obsidian.read",
    `repo.markDeleted:${ID}`,
    "api.sendMessage",
  ]);
});

test("undo and discard on a missing or already removed jot only toast", async () => {
  const gone = await harness({ jots: [] });
  await gone.tap(`un:${ID}`);
  await gone.tap("dl");
  assert.deepEqual(gone.answers(), ["gone", "gone"]);

  const removed = await harness({ jots: [jot({ status: "deleted" })] });
  await removed.tap(`un:${ID}`);
  await removed.tap(`dl:${ID}`);
  assert.deepEqual(removed.answers(), ["already undone", "already deleted"]);
  assert.deepEqual(
    removed.events.filter((e) => !e.startsWith("api.")),
    [],
  );
});

// --- em: embed toggle ---

test("embed rewrites the URL, answers after the write, and offers the opposite toggle", async () => {
  const h = await harness({ notes: { [NOTE]: noteWith(`watch ${YT}`) } });
  await h.tap(`em:${ID}:1`);
  assert.deepEqual(h.events, [
    "obsidian.read",
    "obsidian.write",
    "api.answerCallbackQuery",
    "api.sendMessage",
  ]);
  assert.deepEqual(h.answers(), ["embedded"]);
  assert.equal(h.note(), noteWith(`watch ![](${YT})`));
  assert.deepEqual(h.updates, [[ID, { raw_text: `watch ![](${YT})` }]]);
  assert.deepEqual(h.buttons(h.api.find((c) => c.method === "sendMessage")), [
    ["↩️ Undo", `un:${ID}`],
    ["🔗 Plain link", `em:${ID}:0`],
  ]);

  await h.tap(`em:${ID}:0`);
  assert.deepEqual(h.answers(), ["embedded", "plain link"]);
  assert.equal(h.note(), noteWith(`watch ${YT}`));
  const last = h.api.filter((c) => c.method === "editMessageText").at(-1);
  assert.deepEqual(h.buttons(last), [
    ["↩️ Undo", `un:${ID}`],
    ["🖼 Embed", `em:${ID}:1`],
  ]);
});

test("embed on a jot that is gone, still processing, or has no line only toasts", async () => {
  const missing = await harness({ jots: [] });
  await missing.tap(`em:${ID}:1`);
  await missing.tap("em");
  assert.deepEqual(missing.answers(), ["gone", "gone"]);

  const busy = await harness({ jots: [jot({ status: "processing" })] });
  await busy.tap(`em:${ID}:1`);
  assert.deepEqual(busy.answers(), ["gone"]);

  const noLine = await harness({ notes: { [NOTE]: "# Journal\n" } });
  await noLine.tap(`em:${ID}:1`);
  assert.deepEqual(noLine.answers(), ["line not found"]);
  assert.deepEqual(noLine.sends(), []);
});

// --- lk: link confirmation ---

const pending = {
  p1: { jot_id: ID, surface: "milk", note: "Dairy" },
};

test("confirming a link reads and writes the note, then answers linked", async () => {
  const h = await harness({ links: pending });
  await h.tap("lk:y:p1");
  assert.deepEqual(h.events, [
    "repo.takePendingLink:p1",
    "obsidian.read",
    "obsidian.write",
    "api.answerCallbackQuery",
    "api.editMessageText",
  ]);
  assert.deepEqual(h.answers(), ["linked"]);
  assert.deepEqual(h.edits(), ['🔗 "milk" → [[Dairy]]']);
  assert.equal(h.note(), noteWith("bought [[Dairy|milk]]"));
});

test("confirming a link that changes nothing answers no change", async () => {
  const noSurface = await harness({
    links: { p1: { jot_id: ID, surface: "bread", note: "Bakery" } },
  });
  await noSurface.tap("lk:y:p1");
  assert.deepEqual(noSurface.answers(), ["no change"]);
  assert.deepEqual(noSurface.edits(), ['"bread": nothing to link']);
  assert.equal(noSurface.events.includes("obsidian.write"), false);

  const noJot = await harness({ jots: [], links: pending });
  await noJot.tap("lk:y:p1");
  assert.deepEqual(noJot.answers(), ["no change"]);
  assert.deepEqual(
    noJot.events.filter((e) => e.startsWith("obsidian.")),
    [],
  );
});

test("rejecting a link teaches it before answering", async () => {
  const h = await harness({ links: pending });
  await h.tap("lk:n:p1");
  assert.deepEqual(h.events, [
    "repo.takePendingLink:p1",
    "repo.reject",
    "api.answerCallbackQuery",
    "api.editMessageText",
  ]);
  assert.deepEqual(h.rejected, [["milk", "Dairy"]]);
  assert.deepEqual(h.answers(), ["won't link again"]);
  assert.deepEqual(h.edits(), ['✋ "milk" ✗ [[Dairy]] (won\'t ask again)']);
});

test("a link tap with no pending record says expired, and one without an id is acknowledged", async () => {
  const h = await harness();
  await h.tap("lk:y:p9");
  await h.tap("lk:y");
  assert.deepEqual(h.answers(), ["expired", undefined]);
  assert.deepEqual(h.edits(), []);
});

// --- ur: unreject picker ---

const rejections = [
  { surface: "foo", note: "Alpha" },
  { surface: "foo", note: "Beta" },
  { surface: "bar", note: "Gamma" },
];

test("the unreject picker lists the notes rejected for a word", async () => {
  const h = await harness({ rejections });
  await h.tap("ur:s:0");
  assert.deepEqual(h.events, [
    "api.answerCallbackQuery",
    "api.editMessageText",
  ]);
  assert.deepEqual(h.answers(), [undefined]);
  assert.deepEqual(h.edits(), ['Unreject "foo" → which note?']);
  assert.deepEqual(
    h.buttons(h.api.find((c) => c.method === "editMessageText")),
    [
      ["Alpha", "ur:p:0:0"],
      ["Beta", "ur:p:0:1"],
    ],
  );
});

test("picking a rejected note undoes it, and says so when it is already gone", async () => {
  const h = await harness({ rejections });
  await h.tap("ur:p:0:1");
  assert.deepEqual(h.unrejectCalls, [["foo", "Beta"]]);
  assert.deepEqual(h.events, [
    "repo.unreject",
    "api.answerCallbackQuery",
    "api.editMessageText",
  ]);
  assert.deepEqual(h.answers(), ["unrejected"]);
  assert.deepEqual(h.edits(), ['↩️ "foo" may link to [[Beta]] again']);

  const gone = await harness({ rejections, unrejected: 0 });
  await gone.tap("ur:p:1:0");
  assert.deepEqual(gone.answers(), ["already gone"]);
  assert.deepEqual(gone.edits(), ['no rejection for "bar" → [[Gamma]]']);
});

test("a shifted unreject index answers expired instead of undoing the wrong pair", async () => {
  const h = await harness({ rejections });
  await h.tap("ur:s:5");
  await h.tap("ur:p:5:0");
  await h.tap("ur:p:0:5");
  assert.deepEqual(h.answers(), ["expired", "expired", "expired"]);
  assert.deepEqual(h.unrejectCalls, []);
  assert.deepEqual(h.edits(), []);
});

test("an unknown unreject step is acknowledged and nothing changes", async () => {
  const h = await harness({ rejections });
  await h.tap("ur:x:0");
  assert.deepEqual(h.answers(), [undefined]);
  assert.deepEqual(h.unrejectCalls, []);
});

test("an unknown callback namespace is answered with no text", async () => {
  const h = await harness();
  await h.tap("zz:whatever");
  assert.deepEqual(h.events, ["api.answerCallbackQuery"]);
  assert.deepEqual(h.answers(), [undefined]);
});

// --- /delete ---

test("/delete removes the replied-to jot's line and reports it on the status message", async () => {
  const h = await harness();
  await h.deleteCommand(true);
  assert.deepEqual(h.events, [
    "obsidian.read",
    "obsidian.write",
    `repo.markDeleted:${ID}`,
    "api.sendMessage",
  ]);
  assert.deepEqual(h.sends(), ["🗑️ removed that from your journal."]);
  assert.equal(h.note(), "# Journal\n\n");
});

test("/delete asks for a reply, and says when it cannot find the jot", async () => {
  const noReply = await harness();
  await noReply.deleteCommand(false);
  assert.deepEqual(noReply.sends(), [
    "Reply to a journal message with /delete to remove that line.",
  ]);

  const unmapped = await harness();
  await unmapped.deleteCommand(true, 12);
  assert.deepEqual(unmapped.sends(), ["Can't find a jot for that message."]);

  const noJot = await harness({ jots: [] });
  await noJot.deleteCommand(true);
  assert.deepEqual(noJot.sends(), ["Jot not found."]);
  for (const h of [noReply, unmapped, noJot])
    assert.equal(h.events.includes("obsidian.write"), false);
});

test("/delete on a jot still processing queues the delete", async () => {
  for (const status of ["pending", "processing"] as const) {
    const h = await harness({ jots: [jot({ status })] });
    await h.deleteCommand(true);
    assert.deepEqual(h.queuedEdits, [[ID, "delete"]], status);
    assert.deepEqual(
      h.sends(),
      ["⏳ still processing \u{2014} I'll remove it once it's done."],
      status,
    );
    assert.equal(h.events.includes("obsidian.write"), false, status);
  }
});

// --- reply edit ---

test("a reply with a literal edit rewrites the line without calling the model", async () => {
  const h = await harness();
  await h.replyTo("s/milk/oat milk/");
  assert.equal(h.note(), noteWith("bought oat milk"));
  assert.deepEqual(h.editCalls, []);
  assert.deepEqual(h.updates, [[ID, { raw_text: "bought oat milk" }]]);
  const card = h.api.find((c) => c.method === "sendMessage");
  assert.equal(
    card?.payload.text,
    "✏️ Updated\n<blockquote>🕒 10:00:00 · bought oat milk</blockquote>",
  );
  assert.deepEqual(h.buttons(card), [["↩️ Undo", `un:${ID}`]]);
});

test("a freeform reply goes to the model with the line's text", async () => {
  const h = await harness();
  await h.replyTo("make it shorter");
  assert.deepEqual(h.editCalls, [["bought milk", "make it shorter"]]);
  assert.equal(h.note(), noteWith("bought milk (make it shorter)"));
});

test("a reply of delete removes the entry and offers no Undo", async () => {
  const h = await harness();
  await h.replyTo("delete");
  assert.equal(h.note(), "# Journal\n\n");
  assert.deepEqual(h.sends(), ["🗑️ removed that from your journal."]);
  assert.deepEqual(
    h.buttons(h.api.find((c) => c.method === "sendMessage")),
    [],
  );
});

test("a reply to a line that is no longer in the note says so", async () => {
  const h = await harness({ notes: { [NOTE]: "# Journal\n" } });
  await h.replyTo("s/milk/oat/");
  assert.deepEqual(h.sends(), ["Couldn't find that line in the note."]);
  assert.deepEqual(h.updates, []);
});

test("a reply to a jot still processing is queued, and one to an unknown jot is refused", async () => {
  const busy = await harness({ jots: [jot({ status: "processing" })] });
  await busy.replyTo("make it shorter");
  assert.deepEqual(busy.queuedEdits, [[ID, "make it shorter"]]);
  assert.deepEqual(busy.sends(), [
    "⏳ still processing \u{2014} I'll apply that edit once it's done.",
  ]);

  const unmapped = await harness({ mapped: [] });
  await unmapped.replyTo("make it shorter");
  assert.deepEqual(unmapped.sends(), ["Can't find that jot to edit."]);

  const noJot = await harness({ jots: [] });
  await noJot.replyTo("make it shorter");
  assert.deepEqual(noJot.sends(), ["Jot not found."]);
});

test("edits queued during processing are applied once the jot is done, in one status update", async () => {
  const h = await harness({
    queuedEdits: { [ID]: ["s/milk/oat milk/", "s/bought/got/"] },
  });
  await h.bot.edits.drainQueued(ID);
  assert.equal(h.note(), noteWith("got oat milk"));
  assert.equal(h.events.at(-1), "api.sendMessage");
  assert.ok(
    h.events.indexOf(`repo.clearQueuedEdits:${ID}`) <
      h.events.indexOf("api.sendMessage"),
  );
  assert.match(h.sends()[0]!, /\(applied 2 queued edits\)$/);

  const none = await harness();
  await none.bot.edits.drainQueued(ID);
  assert.deepEqual(none.events, []);
});

test("one queued edit is reported in the singular", async () => {
  const h = await harness({ queuedEdits: { [ID]: ["s/milk/tea/"] } });
  await h.bot.edits.drainQueued(ID);
  assert.match(h.sends()[0]!, /\(applied 1 queued edit\)$/);
});

// --- edited messages and captions ---

test("editing a message text rewrites the processed jot's line and updates its status", async () => {
  const h = await harness();
  await h.edited({ text: "bought oat milk" });
  assert.equal(h.note(), noteWith("bought oat milk"));
  assert.deepEqual(
    h.api.map((c) => c.method),
    ["sendMessage", "editMessageText"],
  );
  assert.equal(h.sends()[0], "✍️ got your edit \u{2014} applying…");
  assert.equal(
    h.edits()[0],
    "✏️ Updated\n<blockquote>🕒 10:00:00 · bought oat milk</blockquote>",
  );
  assert.deepEqual(h.buttons(h.api.at(-1)), [["↩️ Undo", `un:${ID}`]]);
});

test("editing an image caption keeps the image embed in the line", async () => {
  const h = await harness({
    jots: [
      jot({ kind: "image", asset_path: "assets/cat.png", raw_text: "a cat" }),
    ],
    notes: { [NOTE]: noteWith("a cat ![[assets/cat.png]]") },
  });
  await h.edited({ caption: "a sleepy cat" });
  assert.equal(h.note(), noteWith("a sleepy cat ![[assets/cat.png]]"));
  assert.deepEqual(h.updates, []);
});

test("edited text carries its formatting into the line as markdown", async () => {
  const h = await harness();
  await h.edited({
    text: "bought oat milk",
    entities: [{ type: "bold", offset: 7, length: 3 }],
  });
  assert.equal(h.note(), noteWith("bought **oat** milk"));
});

test("clearing a processed message's text removes the line", async () => {
  const h = await harness();
  await h.edited({ text: "  " });
  assert.equal(h.note(), "# Journal\n\n");
  assert.equal(h.sends()[0], "🗑️ got it \u{2014} removing…");
  assert.equal(h.edits()[0], "🗑️ removed that from your journal.");
  assert.equal(h.events.includes(`repo.markDeleted:${ID}`), true);
});

test("an edit while the jot is still processing is queued and acknowledged", async () => {
  const h = await harness({ jots: [jot({ status: "processing" })] });
  await h.edited({ text: "bought oat milk" });
  await h.edited({ caption: " " });
  assert.deepEqual(h.queuedEdits, [
    [ID, "bought oat milk"],
    [ID, "delete"],
  ]);
  assert.deepEqual(h.sends(), [
    "⏳ still processing \u{2014} I'll apply that edit once it's done.",
    "⏳ still processing \u{2014} I'll remove it once it's done.",
  ]);
  assert.equal(h.events.includes("obsidian.write"), false);
});

test("editing a message with no jot behind it does nothing", async () => {
  const unmapped = await harness({ mapped: [] });
  await unmapped.edited({ text: "hello" });
  const noJot = await harness({ jots: [] });
  await noJot.edited({ caption: "hello" });
  for (const h of [unmapped, noJot]) {
    assert.deepEqual(h.api, []);
    assert.deepEqual(h.queuedEdits, []);
  }
});

// --- status message map ---

test("the first status message is sent and mapped to the jot, later ones edit it in place", async () => {
  const h = await harness({ mapped: [] });
  await h.bot.jotController.status(ID, "working", {
    retry: true,
    discard: true,
  });
  const first = h.api[0]!;
  assert.equal(first.method, "sendMessage");
  assert.equal(first.payload.parse_mode, "HTML");
  assert.deepEqual(h.buttons(first), [
    ["🔄 Retry", `rt:${ID}`],
    ["🗑 Delete", `dl:${ID}`],
  ]);
  assert.equal(h.messages.get(900), ID);

  await h.bot.jotController.status(ID, "done", { undo: true });
  const second = h.api[1]!;
  assert.equal(second.method, "editMessageText");
  assert.equal(second.payload.message_id, 900);
  assert.equal(second.payload.text, "done");
  assert.deepEqual(h.buttons(second), [["↩️ Undo", `un:${ID}`]]);

  await h.bot.jotController.status(ID, "plain");
  assert.deepEqual(h.buttons(h.api[2]), []);
});

test("a status edit Telegram rejects is sent as a fresh message that replaces the old one", async () => {
  const h = await harness({ mapped: [] });
  await h.bot.jotController.status(ID, "one");
  h.failApi.add("editMessageText");
  await h.bot.jotController.status(ID, "two");
  assert.deepEqual(
    h.api.map((c) => c.method),
    ["sendMessage", "editMessageText", "sendMessage"],
  );
  assert.equal(h.messages.get(901), ID);

  h.failApi.delete("editMessageText");
  await h.bot.jotController.status(ID, "three");
  assert.equal(h.api.at(-1)?.payload.message_id, 901);
});

test("deleting a status message unmaps it and tolerates Telegram refusing", async () => {
  const none = await harness();
  await none.bot.jotController.deleteStatus(ID);
  assert.deepEqual(none.api, []);

  const h = await harness({ mapped: [] });
  await h.bot.jotController.status(ID, "stray");
  await h.bot.jotController.deleteStatus(ID);
  assert.equal(h.messages.has(900), false);
  assert.deepEqual(h.api.at(-1), {
    method: "deleteMessage",
    payload: { chat_id: 1, message_id: 900 },
  });
  await h.bot.jotController.deleteStatus(ID);
  assert.equal(h.api.length, 2);

  const refused = await harness({ mapped: [] });
  await refused.bot.jotController.status(ID, "stray");
  refused.failApi.add("deleteMessage");
  await refused.bot.jotController.deleteStatus(ID);
  assert.equal(refused.messages.has(900), false);
});

test("the outcome reaction follows the jot's message and never throws", async () => {
  const h = await harness();
  await h.bot.jotController.react(ID, "done");
  await h.bot.jotController.react(ID, "retrying");
  await h.bot.jotController.react(ID, "failed");
  assert.deepEqual(
    h.api.map((c) => [c.method, c.payload.message_id, c.payload.reaction]),
    [
      ["setMessageReaction", 77, [{ type: "emoji", emoji: "👌" }]],
      ["setMessageReaction", 77, [{ type: "emoji", emoji: "🤔" }]],
      ["setMessageReaction", 77, [{ type: "emoji", emoji: "😱" }]],
    ],
  );

  h.failApi.add("setMessageReaction");
  await h.bot.jotController.react(ID, "done");

  const unmapped = await harness({ mapped: [] });
  await unmapped.bot.jotController.react(ID, "done");
  assert.deepEqual(unmapped.api, []);
});

// --- downloadFile ---

test("a Telegram file is downloaded with its extension and mime type", async (t) => {
  const h = await harness();
  h.apiResult.getFile = { file_id: "f1", file_path: "voice/file_1.OGA" };
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const file = await h.bot.downloadFile("f1");
  assert.deepEqual(urls, [
    "https://api.telegram.org/file/bott/voice/file_1.OGA",
  ]);
  assert.deepEqual([...file.bytes], [1, 2, 3]);
  assert.equal(file.ext, "oga");
  assert.equal(file.mime, "audio/ogg");

  h.apiResult.getFile = { file_id: "f2", file_path: "documents/file_2" };
  const other = await h.bot.downloadFile("f2");
  assert.equal(other.ext, "bin");
  assert.equal(other.mime, "application/octet-stream");
});

test("a file Telegram will not serve fails the download with its reason", async (t) => {
  const h = await harness();
  h.apiResult.getFile = { file_id: "f1" };
  await assert.rejects(() => h.bot.downloadFile("f1"), /no file_path for f1/);

  h.apiResult.getFile = { file_id: "f1", file_path: "voice/a.oga" };
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("no", { status: 404 }),
  );
  await assert.rejects(
    () => h.bot.downloadFile("f1"),
    /telegram file download: 404/,
  );
});

// --- error handler ---

test("a failed button tap gets a toast of at most 200 characters and no other message", async () => {
  const h = await harness();
  h.repo.getJot = async () => {
    throw new Error("db is locked");
  };
  await h.tap(`rt:${ID}`);
  assert.deepEqual(h.answers(), ["⚠️ db is locked"]);
  assert.deepEqual(h.sends(), []);

  h.repo.getJot = async () => {
    throw new Error("x".repeat(500));
  };
  await h.tap(`rt:${ID}`);
  const long = h.answers()[1]!;
  assert.equal(long.length, 200);
  assert.ok(long.startsWith("⚠️ xxx"));
});

test("a failed message that already has a jot gets Retry and Delete buttons", async () => {
  const h = await harness({ jots: [], mapped: [] });
  h.obsidian.appendJournalLine = async () => {
    throw new Error("obsidian is down");
  };
  await h.send("buy milk");
  const reply = h.api.find((c) => c.method === "sendMessage");
  assert.equal(reply?.payload.text, "⚠️ Couldn't save that: obsidian is down");
  const [row] = [...h.jots.keys()];
  assert.deepEqual(h.buttons(reply), [
    ["🔄 Retry", `rt:${row}`],
    ["🗑 Delete", `dl:${row}`],
  ]);
});

test("a failed message with no jot gets a plain error and a non-Error reason is stringified", async () => {
  const h = await harness({ mapped: [] });
  h.repo.insertJot = async () => {
    throw "disk full";
  };
  await h.send("buy milk");
  const reply = h.api.find((c) => c.method === "sendMessage");
  assert.equal(reply?.payload.text, "⚠️ Couldn't save that: disk full");
  assert.deepEqual(h.buttons(reply), []);
});
