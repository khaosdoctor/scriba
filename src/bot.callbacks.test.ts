import assert from "node:assert/strict";
import { test } from "node:test";
import { createScriba } from "./app.ts";
import type { Jot } from "./domain/jot/entity.ts";
import { journalLine } from "./libs/note.ts";
import { testConfig } from "./test/config.ts";
import { BOT_INFO, recordingApi } from "./test/fakes.ts";
import { noteOps } from "./test/note-ops.ts";
import { sampleJot } from "./test/sqlite.ts";

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

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

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
  const events: string[] = [];
  const rec = recordingApi({
    onCall: (call) => events.push(`api.${call.method}`),
  });
  const jots = new Map(
    (over.jots ?? [jot()]).map((storedJot) => [storedJot.id, storedJot]),
  );
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
    jotForMessage: async (messageId: number) => messages.get(messageId),
    mapMessage: async (messageId: number, id: string) =>
      void messages.set(messageId, id),
    unmapMessage: async (messageId: number) => void messages.delete(messageId),
    messageForJot: async (id: string) =>
      [...messages].find(([, mappedJotId]) => mappedJotId === id)?.[0],
    insertJot: async (newJot: Jot) => void jots.set(newJot.id, newJot),
    lastPendingEnrichableJot: async () => undefined,
    queueEdit: async (id: string, text: string) =>
      void queuedEdits.push([id, text]),
    queuedEdits: async (id: string) => over.queuedEdits?.[id] ?? [],
    clearQueuedEdits: async (id: string) =>
      void events.push(`repo.clearQueuedEdits:${id}`),
    markDeleted: async (id: string) => {
      events.push(`repo.markDeleted:${id}`);
      const existing = jots.get(id);
      if (existing) jots.set(id, { ...existing, status: "deleted" });
    },
    groupFollowers: async (id: string) => over.followers?.[id] ?? [],
    updateJot: async (id: string, patch: object) =>
      void updates.push([id, patch]),
    resetForRetry: async (id: string) => {
      events.push(`repo.resetForRetry:${id}`);
      return jots.get(id)?.status !== "processing";
    },
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
  const bot: any = await createScriba(
    testConfig,
    { version: "0.0.0", sha: "0123456789" },
    {
      repo,
      obsidian,
      enricher,
      queue: {
        add: (ids: string[]) => void events.push(`queue.add:${ids.join(",")}`),
      } as never,
      transcriber: {} as never,
      links: {} as never,
      scheduler: { daily() {}, every() {} } as never,
      processing: {} as never,
      health: {} as never,
      github: {} as never,
    },
  );
  bot.bot.botInfo = BOT_INFO;
  bot.bot.api.config.use(rec.transformer as never);

  const from = { id: 1, is_bot: false, first_name: "me" };
  const chat = { id: 1, type: "private" as const };
  let updateId = 0;
  // Long polling routes a handler's BotError to bot.catch; handleUpdate alone rethrows it.
  const update = (payload: object) =>
    bot.bot
      .handleUpdate({ update_id: ++updateId, ...payload })
      .catch((err: unknown) => bot.bot.errorHandler(err));

  return {
    bot,
    repo,
    obsidian,
    events,
    api: rec.calls,
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
    tap: (data: string, message: object = {}) =>
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
            ...message,
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

async function openVoiceFix(fixture: Awaited<ReturnType<typeof harness>>) {
  const pending: Promise<"original" | "proposed"> =
    fixture.bot.jotController.awaitVoiceFix(
      ID,
      "a <b> original",
      "the fixed one",
    );
  while (!fixture.bot.jotController.voiceFixPending.has(ID)) await tick();
  return pending;
}

test("the voice-fix prompt shows both transcripts and the two choice buttons in one message", async (testContext) => {
  testContext.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = await harness();
  const pending = openVoiceFix(fixture);
  await tick();
  const sent = fixture.api.find((call) => call.method === "sendMessage");
  assert.equal(
    sent?.payload.text,
    "<b>Original transcript:</b>\n<i>a &lt;b&gt; original</i>\n\n<b>Proposed fix:</b>\n<i>the fixed one</i>",
  );
  assert.equal(sent?.payload.parse_mode, "HTML");
  assert.deepEqual(fixture.buttons(sent), [
    ["📝 Use original", `vf:o:${ID}`],
    ["✨ Use fixed", `vf:p:${ID}`],
  ]);
  assert.deepEqual(
    fixture.api.map((call) => call.method),
    ["sendMessage"],
  );
  await fixture.tap(`vf:o:${ID}`);
  await pending;
});

test("tapping a voice-fix button resolves the wait with that choice", async (testContext) => {
  testContext.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [data, choice, toast] of [
    [`vf:p:${ID}`, "proposed", "using fixed version"],
    [`vf:o:${ID}`, "original", "keeping original"],
  ] as const) {
    const fixture = await harness();
    const pending = openVoiceFix(fixture);
    await tick();
    await fixture.tap(data);
    assert.equal(await pending, choice);
    assert.deepEqual(fixture.answers(), [toast]);
    assert.equal(fixture.bot.jotController.voiceFixPending.has(ID), false);
  }
});

test("an unanswered voice-fix prompt falls back to the original after five minutes", async (testContext) => {
  testContext.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = await harness();
  const pending = openVoiceFix(fixture);
  await tick();
  testContext.mock.timers.tick(5 * 60 * 1000);
  assert.equal(await pending, "original");
  assert.equal(fixture.bot.jotController.voiceFixPending.has(ID), false);

  await fixture.tap(`vf:p:${ID}`);
  assert.deepEqual(fixture.answers(), ["expired"]);
});

test("a voice-fix tap with no pending choice says expired, and a malformed one is just acknowledged", async () => {
  const fixture = await harness();
  await fixture.tap(`vf:o:${ID}`);
  await fixture.tap("vf:o");
  assert.deepEqual(fixture.answers(), ["expired", undefined]);
});

// --- rt: retry ---

test("retry resets the jot and queues it before answering, then rewrites the status card", async () => {
  const fixture = await harness({ jots: [jot({ status: "failed" })] });
  await fixture.tap(`rt:${ID}`);
  assert.deepEqual(fixture.events, [
    `repo.resetForRetry:${ID}`,
    `queue.add:${ID}`,
    "api.answerCallbackQuery",
    "api.editMessageText",
  ]);
  assert.deepEqual(fixture.answers(), ["retrying"]);
  assert.deepEqual(fixture.edits(), ["🔄 retrying…"]);
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

test("retry on a jot being processed is refused and nothing is queued", async () => {
  const busy = await harness({ jots: [jot({ status: "processing" })] });
  await busy.tap(`rt:${ID}`);
  assert.deepEqual(busy.events, [
    `repo.resetForRetry:${ID}`,
    "api.answerCallbackQuery",
  ]);
  assert.deepEqual(busy.answers(), ["still processing"]);
  assert.deepEqual(busy.edits(), []);
});

// --- un / dl: undo and discard ---

test("undo and discard answer first, then pull the line out and clear the buttons", async () => {
  for (const [ns, toast] of [
    ["un", "undoing"],
    ["dl", "deleting"],
  ] as const) {
    const fixture = await harness();
    await fixture.tap(`${ns}:${ID}`);
    assert.deepEqual(fixture.events, [
      "api.answerCallbackQuery",
      "obsidian.read",
      "obsidian.write",
      `repo.markDeleted:${ID}`,
      "api.sendMessage",
    ]);
    assert.deepEqual(fixture.answers(), [toast]);
    assert.deepEqual(fixture.sends(), ["🗑️ removed that from your journal."]);
    assert.deepEqual(
      fixture.buttons(
        fixture.api.find((call) => call.method === "sendMessage"),
      ),
      [],
    );
    assert.equal(fixture.note(), "# Journal\n\n");
  }
});

test("removing a squashed leader also marks its followers deleted", async () => {
  const fixture = await harness({
    jots: [jot(), jot({ id: "bbbbbbbb", anchor: ID })],
    followers: { [ID]: [{ id: "bbbbbbbb" }] },
  });
  await fixture.tap(`dl:${ID}`);
  assert.deepEqual(
    fixture.events.filter((event) => event.startsWith("repo.")),
    [`repo.markDeleted:${ID}`, "repo.markDeleted:bbbbbbbb"],
  );
});

test("removing a jot whose line is already gone still marks it deleted", async () => {
  const fixture = await harness({ notes: { [NOTE]: "# Journal\n" } });
  await fixture.tap(`un:${ID}`);
  assert.deepEqual(fixture.events, [
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
    removed.events.filter((event) => !event.startsWith("api.")),
    [],
  );
});

test("undo on a jot sent back for processing drops the Undo button, keeps the others and leaves the note alone", async () => {
  for (const status of ["pending", "processing", "failed"] as const) {
    const bot = await harness({ jots: [jot({ status })] });
    await bot.tap(`un:${ID}`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "↩️ Undo", callback_data: `un:${ID}` },
            { text: "🖼 Embed", callback_data: `em:${ID}:1` },
          ],
        ],
      },
    });
    assert.deepEqual(bot.answers(), [undefined], status);
    assert.deepEqual(
      bot.events,
      ["api.answerCallbackQuery", "api.editMessageReplyMarkup"],
      status,
    );
    assert.deepEqual(
      bot.buttons(
        bot.api.find((call) => call.method === "editMessageReplyMarkup"),
      ),
      [["🖼 Embed", `em:${ID}:1`]],
      status,
    );
    assert.deepEqual(bot.queuedEdits, [], status);
    assert.equal(bot.note(), noteWith("bought milk"), status);
  }
});

test("discard on a jot still in flight queues the delete like a /delete reply", async () => {
  for (const status of ["pending", "processing"] as const) {
    const bot = await harness({ jots: [jot({ status })] });
    await bot.tap(`dl:${ID}`);
    assert.deepEqual(bot.queuedEdits, [[ID, "delete"]], status);
    assert.deepEqual(
      bot.answers(),
      ["⏳ still processing \u{2014} I'll remove it once it's done."],
      status,
    );
    assert.deepEqual(bot.events, ["api.answerCallbackQuery"], status);
    assert.equal(bot.note(), noteWith("bought milk"), status);
  }
});

test("discard on a failed, abandoned or finished jot and undo on an abandoned one remove the line now", async () => {
  for (const [ns, status] of [
    ["dl", "failed"],
    ["dl", "abandoned"],
    ["dl", "done"],
    ["un", "abandoned"],
  ] as const) {
    const bot = await harness({ jots: [jot({ status })] });
    await bot.tap(`${ns}:${ID}`);
    assert.ok(bot.events.includes(`repo.markDeleted:${ID}`), `${ns} ${status}`);
    assert.equal(bot.note(), "# Journal\n\n", `${ns} ${status}`);
    assert.deepEqual(bot.queuedEdits, [], `${ns} ${status}`);
  }
});

test("undo on a squashed follower removes the shared line through its leader and marks both deleted", async () => {
  const bot = await harness({
    jots: [jot(), jot({ id: "bbbbbbbb", anchor: ID })],
    followers: { [ID]: [{ id: "bbbbbbbb" }] },
  });
  await bot.tap("un:bbbbbbbb");
  assert.deepEqual(
    bot.events.filter((event) => event.startsWith("repo.")),
    [`repo.markDeleted:${ID}`, "repo.markDeleted:bbbbbbbb"],
  );
  assert.equal(bot.note(), "# Journal\n\n");

  const alone = await harness({
    jots: [jot({ status: "deleted" }), jot({ id: "bbbbbbbb", anchor: ID })],
  });
  await alone.tap("un:bbbbbbbb");
  assert.deepEqual(
    alone.events.filter((event) => event.startsWith("repo.")),
    ["repo.markDeleted:bbbbbbbb"],
  );
  assert.equal(alone.note(), "# Journal\n\n");
});

// --- em: embed toggle ---

test("embed rewrites the URL, answers after the write, and offers the opposite toggle", async () => {
  const fixture = await harness({ notes: { [NOTE]: noteWith(`watch ${YT}`) } });
  await fixture.tap(`em:${ID}:1`);
  assert.deepEqual(fixture.events, [
    "obsidian.read",
    "obsidian.write",
    "api.answerCallbackQuery",
    "api.sendMessage",
  ]);
  assert.deepEqual(fixture.answers(), ["embedded"]);
  assert.equal(fixture.note(), noteWith(`watch ![](${YT})`));
  assert.deepEqual(fixture.updates, [[ID, { raw_text: `watch ![](${YT})` }]]);
  assert.deepEqual(
    fixture.buttons(fixture.api.find((call) => call.method === "sendMessage")),
    [
      ["↩️ Undo", `un:${ID}`],
      ["🔗 Plain link", `em:${ID}:0`],
    ],
  );

  await fixture.tap(`em:${ID}:0`);
  assert.deepEqual(fixture.answers(), ["embedded", "plain link"]);
  assert.equal(fixture.note(), noteWith(`watch ${YT}`));
  const last = fixture.api
    .filter((call) => call.method === "editMessageText")
    .at(-1);
  assert.deepEqual(fixture.buttons(last), [
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
  const fixture = await harness({ links: pending });
  await fixture.tap("lk:y:p1");
  assert.deepEqual(fixture.events, [
    "repo.takePendingLink:p1",
    "obsidian.read",
    "obsidian.write",
    "api.answerCallbackQuery",
    "api.editMessageText",
  ]);
  assert.deepEqual(fixture.answers(), ["linked"]);
  assert.deepEqual(fixture.edits(), ['🔗 "milk" → [[Dairy]]']);
  assert.equal(fixture.note(), noteWith("bought [[Dairy|milk]]"));
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
    noJot.events.filter((event) => event.startsWith("obsidian.")),
    [],
  );
});

test("rejecting a link teaches it before answering", async () => {
  const fixture = await harness({ links: pending });
  await fixture.tap("lk:n:p1");
  assert.deepEqual(fixture.events, [
    "repo.takePendingLink:p1",
    "repo.reject",
    "api.answerCallbackQuery",
    "api.editMessageText",
  ]);
  assert.deepEqual(fixture.rejected, [["milk", "Dairy"]]);
  assert.deepEqual(fixture.answers(), ["won't link again"]);
  assert.deepEqual(fixture.edits(), [
    '✋ "milk" ✗ [[Dairy]] (won\'t ask again)',
  ]);
});

test("a link tap with no pending record says expired, and one without an id is acknowledged", async () => {
  const fixture = await harness();
  await fixture.tap("lk:y:p9");
  await fixture.tap("lk:y");
  assert.deepEqual(fixture.answers(), ["expired", undefined]);
  assert.deepEqual(fixture.edits(), []);
});

// --- ur: unreject picker ---

const rejections = [
  { surface: "foo", note: "Alpha" },
  { surface: "foo", note: "Beta" },
  { surface: "bar", note: "Gamma" },
];

test("the unreject picker lists the notes rejected for a word", async () => {
  const fixture = await harness({ rejections });
  await fixture.tap("ur:s:0");
  assert.deepEqual(fixture.events, [
    "api.answerCallbackQuery",
    "api.editMessageText",
  ]);
  assert.deepEqual(fixture.answers(), [undefined]);
  assert.deepEqual(fixture.edits(), ['Unreject "foo" → which note?']);
  assert.deepEqual(
    fixture.buttons(
      fixture.api.find((call) => call.method === "editMessageText"),
    ),
    [
      ["Alpha", "ur:p:0:0"],
      ["Beta", "ur:p:0:1"],
    ],
  );
});

test("picking a rejected note undoes it, and says so when it is already gone", async () => {
  const fixture = await harness({ rejections });
  await fixture.tap("ur:p:0:1");
  assert.deepEqual(fixture.unrejectCalls, [["foo", "Beta"]]);
  assert.deepEqual(fixture.events, [
    "repo.unreject",
    "api.answerCallbackQuery",
    "api.editMessageText",
  ]);
  assert.deepEqual(fixture.answers(), ["unrejected"]);
  assert.deepEqual(fixture.edits(), ['↩️ "foo" may link to [[Beta]] again']);

  const gone = await harness({ rejections, unrejected: 0 });
  await gone.tap("ur:p:1:0");
  assert.deepEqual(gone.answers(), ["already gone"]);
  assert.deepEqual(gone.edits(), ['no rejection for "bar" → [[Gamma]]']);
});

test("a shifted unreject index answers expired instead of undoing the wrong pair", async () => {
  const fixture = await harness({ rejections });
  await fixture.tap("ur:s:5");
  await fixture.tap("ur:p:5:0");
  await fixture.tap("ur:p:0:5");
  assert.deepEqual(fixture.answers(), ["expired", "expired", "expired"]);
  assert.deepEqual(fixture.unrejectCalls, []);
  assert.deepEqual(fixture.edits(), []);
});

test("an unknown unreject step is acknowledged and nothing changes", async () => {
  const fixture = await harness({ rejections });
  await fixture.tap("ur:x:0");
  assert.deepEqual(fixture.answers(), [undefined]);
  assert.deepEqual(fixture.unrejectCalls, []);
});

test("an unknown callback namespace is answered with no text", async () => {
  const fixture = await harness();
  await fixture.tap("zz:whatever");
  assert.deepEqual(fixture.events, ["api.answerCallbackQuery"]);
  assert.deepEqual(fixture.answers(), [undefined]);
});

// --- /delete ---

test("/delete removes the replied-to jot's line and reports it on the status message", async () => {
  const fixture = await harness();
  await fixture.deleteCommand(true);
  assert.deepEqual(fixture.events, [
    "obsidian.read",
    "obsidian.write",
    `repo.markDeleted:${ID}`,
    "api.sendMessage",
  ]);
  assert.deepEqual(fixture.sends(), ["🗑️ removed that from your journal."]);
  assert.equal(fixture.note(), "# Journal\n\n");
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
  for (const fixture of [noReply, unmapped, noJot])
    assert.equal(fixture.events.includes("obsidian.write"), false);
});

test("/delete on a jot still processing queues the delete", async () => {
  for (const status of ["pending", "processing"] as const) {
    const fixture = await harness({ jots: [jot({ status })] });
    await fixture.deleteCommand(true);
    assert.deepEqual(fixture.queuedEdits, [[ID, "delete"]], status);
    assert.deepEqual(
      fixture.sends(),
      ["⏳ still processing \u{2014} I'll remove it once it's done."],
      status,
    );
    assert.equal(fixture.events.includes("obsidian.write"), false, status);
  }
});

// --- reply edit ---

test("a reply with a literal edit rewrites the line without calling the model", async () => {
  const fixture = await harness();
  await fixture.replyTo("s/milk/oat milk/");
  assert.equal(fixture.note(), noteWith("bought oat milk"));
  assert.deepEqual(fixture.editCalls, []);
  assert.deepEqual(fixture.updates, [[ID, { raw_text: "bought oat milk" }]]);
  const card = fixture.api.find((call) => call.method === "sendMessage");
  assert.equal(
    card?.payload.text,
    "✏️ Updated\n<blockquote>🕒 10:00:00 · bought oat milk</blockquote>",
  );
  assert.deepEqual(fixture.buttons(card), [["↩️ Undo", `un:${ID}`]]);
});

test("a freeform reply goes to the model with the line's text", async () => {
  const fixture = await harness();
  await fixture.replyTo("make it shorter");
  assert.deepEqual(fixture.editCalls, [["bought milk", "make it shorter"]]);
  assert.equal(fixture.note(), noteWith("bought milk (make it shorter)"));
});

test("a reply of delete removes the entry and offers no Undo", async () => {
  const fixture = await harness();
  await fixture.replyTo("delete");
  assert.equal(fixture.note(), "# Journal\n\n");
  assert.deepEqual(fixture.sends(), ["🗑️ removed that from your journal."]);
  assert.deepEqual(
    fixture.buttons(fixture.api.find((call) => call.method === "sendMessage")),
    [],
  );
});

test("a reply to a line that is no longer in the note says so", async () => {
  const fixture = await harness({ notes: { [NOTE]: "# Journal\n" } });
  await fixture.replyTo("s/milk/oat/");
  assert.deepEqual(fixture.sends(), ["Couldn't find that line in the note."]);
  assert.deepEqual(fixture.updates, []);
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
  const fixture = await harness({
    queuedEdits: { [ID]: ["s/milk/oat milk/", "s/bought/got/"] },
  });
  await fixture.bot.edits.drainQueued(ID);
  assert.equal(fixture.note(), noteWith("got oat milk"));
  assert.equal(fixture.events.at(-1), "api.sendMessage");
  assert.ok(
    fixture.events.indexOf(`repo.clearQueuedEdits:${ID}`) <
      fixture.events.indexOf("api.sendMessage"),
  );
  assert.match(fixture.sends()[0]!, /\(applied 2 queued edits\)$/);

  const none = await harness();
  await none.bot.edits.drainQueued(ID);
  assert.deepEqual(none.events, []);
});

test("one queued edit is reported in the singular", async () => {
  const fixture = await harness({ queuedEdits: { [ID]: ["s/milk/tea/"] } });
  await fixture.bot.edits.drainQueued(ID);
  assert.match(fixture.sends()[0]!, /\(applied 1 queued edit\)$/);
});

// --- edited messages and captions ---

test("editing a message text rewrites the processed jot's line and updates its status", async () => {
  const fixture = await harness();
  await fixture.edited({ text: "bought oat milk" });
  assert.equal(fixture.note(), noteWith("bought oat milk"));
  assert.deepEqual(
    fixture.api.map((call) => call.method),
    ["sendMessage", "editMessageText"],
  );
  assert.equal(fixture.sends()[0], "✍️ got your edit \u{2014} applying…");
  assert.equal(
    fixture.edits()[0],
    "✏️ Updated\n<blockquote>🕒 10:00:00 · bought oat milk</blockquote>",
  );
  assert.deepEqual(fixture.buttons(fixture.api.at(-1)), [
    ["↩️ Undo", `un:${ID}`],
  ]);
});

test("editing an image caption keeps the image embed in the line", async () => {
  const fixture = await harness({
    jots: [
      jot({ kind: "image", asset_path: "assets/cat.png", raw_text: "a cat" }),
    ],
    notes: { [NOTE]: noteWith("a cat ![[assets/cat.png]]") },
  });
  await fixture.edited({ caption: "a sleepy cat" });
  assert.equal(fixture.note(), noteWith("a sleepy cat ![[assets/cat.png]]"));
  assert.deepEqual(fixture.updates, []);
});

test("edited text carries its formatting into the line as markdown", async () => {
  const fixture = await harness();
  await fixture.edited({
    text: "bought oat milk",
    entities: [{ type: "bold", offset: 7, length: 3 }],
  });
  assert.equal(fixture.note(), noteWith("bought **oat** milk"));
});

test("clearing a processed message's text removes the line", async () => {
  const fixture = await harness();
  await fixture.edited({ text: "  " });
  assert.equal(fixture.note(), "# Journal\n\n");
  assert.equal(fixture.sends()[0], "🗑️ got it \u{2014} removing…");
  assert.equal(fixture.edits()[0], "🗑️ removed that from your journal.");
  assert.equal(fixture.events.includes(`repo.markDeleted:${ID}`), true);
});

test("an edit while the jot is still processing is queued and acknowledged", async () => {
  const fixture = await harness({ jots: [jot({ status: "processing" })] });
  await fixture.edited({ text: "bought oat milk" });
  await fixture.edited({ caption: " " });
  assert.deepEqual(fixture.queuedEdits, [
    [ID, "bought oat milk"],
    [ID, "delete"],
  ]);
  assert.deepEqual(fixture.sends(), [
    "⏳ still processing \u{2014} I'll apply that edit once it's done.",
    "⏳ still processing \u{2014} I'll remove it once it's done.",
  ]);
  assert.equal(fixture.events.includes("obsidian.write"), false);
});

test("editing a message with no jot behind it does nothing", async () => {
  const unmapped = await harness({ mapped: [] });
  await unmapped.edited({ text: "hello" });
  const noJot = await harness({ jots: [] });
  await noJot.edited({ caption: "hello" });
  for (const fixture of [unmapped, noJot]) {
    assert.deepEqual(fixture.api, []);
    assert.deepEqual(fixture.queuedEdits, []);
  }
});

// --- status message map ---

test("the first status message is sent and mapped to the jot, later ones edit it in place", async () => {
  const fixture = await harness({ mapped: [] });
  await fixture.bot.jotController.status(ID, "working", {
    retry: true,
    discard: true,
  });
  const first = fixture.api[0]!;
  assert.equal(first.method, "sendMessage");
  assert.equal(first.payload.parse_mode, "HTML");
  assert.deepEqual(fixture.buttons(first), [
    ["🔄 Retry", `rt:${ID}`],
    ["🗑 Delete", `dl:${ID}`],
  ]);
  assert.equal(fixture.messages.get(900), ID);

  await fixture.bot.jotController.status(ID, "done", { undo: true });
  const second = fixture.api[1]!;
  assert.equal(second.method, "editMessageText");
  assert.equal(second.payload.message_id, 900);
  assert.equal(second.payload.text, "done");
  assert.deepEqual(fixture.buttons(second), [["↩️ Undo", `un:${ID}`]]);

  await fixture.bot.jotController.status(ID, "plain");
  assert.deepEqual(fixture.buttons(fixture.api[2]), []);
});

test("a status edit Telegram rejects is sent as a fresh message that replaces the old one", async () => {
  const fixture = await harness({ mapped: [] });
  await fixture.bot.jotController.status(ID, "one");
  fixture.failApi.add("editMessageText");
  await fixture.bot.jotController.status(ID, "two");
  assert.deepEqual(
    fixture.api.map((call) => call.method),
    ["sendMessage", "editMessageText", "sendMessage"],
  );
  assert.equal(fixture.messages.get(901), ID);

  fixture.failApi.delete("editMessageText");
  await fixture.bot.jotController.status(ID, "three");
  assert.equal(fixture.api.at(-1)?.payload.message_id, 901);
});

test("deleting a status message unmaps it and tolerates Telegram refusing", async () => {
  const none = await harness();
  await none.bot.jotController.deleteStatus(ID);
  assert.deepEqual(none.api, []);

  const fixture = await harness({ mapped: [] });
  await fixture.bot.jotController.status(ID, "stray");
  await fixture.bot.jotController.deleteStatus(ID);
  assert.equal(fixture.messages.has(900), false);
  assert.deepEqual(fixture.api.at(-1), {
    method: "deleteMessage",
    payload: { chat_id: 1, message_id: 900 },
  });
  await fixture.bot.jotController.deleteStatus(ID);
  assert.equal(fixture.api.length, 2);

  const refused = await harness({ mapped: [] });
  await refused.bot.jotController.status(ID, "stray");
  refused.failApi.add("deleteMessage");
  await refused.bot.jotController.deleteStatus(ID);
  assert.equal(refused.messages.has(900), false);
});

test("the outcome reaction follows the jot's message and never throws", async () => {
  const fixture = await harness();
  await fixture.bot.jotController.react(ID, "done");
  await fixture.bot.jotController.react(ID, "retrying");
  await fixture.bot.jotController.react(ID, "failed");
  assert.deepEqual(
    fixture.api.map((call) => [
      call.method,
      call.payload.message_id,
      call.payload.reaction,
    ]),
    [
      ["setMessageReaction", 77, [{ type: "emoji", emoji: "👌" }]],
      ["setMessageReaction", 77, [{ type: "emoji", emoji: "🤔" }]],
      ["setMessageReaction", 77, [{ type: "emoji", emoji: "😱" }]],
    ],
  );

  fixture.failApi.add("setMessageReaction");
  await fixture.bot.jotController.react(ID, "done");

  const unmapped = await harness({ mapped: [] });
  await unmapped.bot.jotController.react(ID, "done");
  assert.deepEqual(unmapped.api, []);
});

// --- error handler ---

test("a failed button tap gets a toast of at most 200 characters and no other message", async () => {
  const fixture = await harness();
  fixture.repo.getJot = async () => {
    throw new Error("db is locked");
  };
  await fixture.tap(`rt:${ID}`);
  assert.deepEqual(fixture.answers(), ["⚠️ db is locked"]);
  assert.deepEqual(fixture.sends(), []);

  fixture.repo.getJot = async () => {
    throw new Error("x".repeat(500));
  };
  await fixture.tap(`rt:${ID}`);
  const long = fixture.answers()[1]!;
  assert.equal(long.length, 200);
  assert.ok(long.startsWith("⚠️ xxx"));
});

test("a failed message that already has a jot gets Retry and Delete buttons", async () => {
  const fixture = await harness({ jots: [], mapped: [] });
  fixture.obsidian.appendJournalLine = async () => {
    throw new Error("obsidian is down");
  };
  await fixture.send("buy milk");
  const reply = fixture.api.find((call) => call.method === "sendMessage");
  assert.equal(reply?.payload.text, "⚠️ Couldn't save that: obsidian is down");
  const [row] = [...fixture.jots.keys()];
  assert.deepEqual(fixture.buttons(reply), [
    ["🔄 Retry", `rt:${row}`],
    ["🗑 Delete", `dl:${row}`],
  ]);
});

test("a failed message with no jot gets a plain error and a non-Error reason is stringified", async () => {
  const fixture = await harness({ mapped: [] });
  fixture.repo.insertJot = async () => {
    throw "disk full";
  };
  await fixture.send("buy milk");
  const reply = fixture.api.find((call) => call.method === "sendMessage");
  assert.equal(reply?.payload.text, "⚠️ Couldn't save that: disk full");
  assert.deepEqual(fixture.buttons(reply), []);
});
