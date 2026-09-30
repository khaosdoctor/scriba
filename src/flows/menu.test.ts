import assert from "node:assert/strict";
import { test } from "node:test";

// menu.ts pulls in config.ts, which validates process.env at import time — give it the
// bare minimum before loading, the same trick config.test.ts uses.
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ALLOWED_TELEGRAM_USER_ID ??= "1";
process.env.OBSIDIAN_API_KEY ??= "o";
const { MenuController } = await import("./menu.ts");
const { InlineKeyboard } = await import("grammy");

/** A controller wired to a bot stub that only records deleteMessage calls. */
function harness() {
  const deleted: [number, number][] = [];
  const bot = {
    api: {
      deleteMessage: async (chatId: number, msgId: number) => {
        deleted.push([chatId, msgId]);
      },
    },
  };
  const menu = new MenuController(
    bot as any,
    {} as any,
    {} as any,
    {} as any,
    (() => ({})) as any,
    (async () => "") as any,
  ) as any;
  return { menu, deleted };
}

test("a menu message self-destructs after a minute of no taps", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { menu, deleted } = harness();
  menu.scheduleExpiry(7, 42);
  t.mock.timers.tick(59_000);
  assert.deepEqual(deleted, []);
  t.mock.timers.tick(2_000);
  assert.deepEqual(deleted, [[7, 42]]);
});

test("each tap restarts the countdown, and closing cancels it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { menu, deleted } = harness();
  menu.scheduleExpiry(7, 42);
  t.mock.timers.tick(50_000);
  menu.scheduleExpiry(7, 42); // a tap
  t.mock.timers.tick(50_000); // 100s since the send, 50s since the tap
  assert.deepEqual(deleted, []);
  menu.cancelExpiry(7, 42);
  t.mock.timers.tick(120_000);
  assert.deepEqual(deleted, []);
});

test("every screen gets a Close button, with no gap above it", () => {
  const { menu } = harness();
  // A keyboard that ends with .row() (most of them do) would otherwise render an empty
  // row between the last button and Close.
  const kb = new InlineKeyboard().text("a", "menu:a").row();
  const rows = menu.withClose(kb).inline_keyboard;
  assert.deepEqual(
    rows.map((r: any[]) => r.map((b) => b.text)),
    [["a"], ["✖ Close"]],
  );
  // And a Back button never travels alone any more.
  assert.deepEqual(
    menu
      .backTo("menu:root")
      .inline_keyboard.map((r: any[]) => r.map((b) => b.text)),
    [["‹ Back"], ["✖ Close"]],
  );
});

// --- nightly rating switches and time ---

const { parseWizardRef, WIZARD_RATING_TIME_REF } = await import("../core.ts");

/** A menu over a real settings map, with recorders for everything it sends. */
function settingsHarness(initial: Record<string, string> = {}) {
  const settings = { ...initial };
  const sets: [string, string][] = [];
  const sent: { chat: number; text: string; opts: any }[] = [];
  const bot = {
    api: {
      sendMessage: async (chat: number, text: string, opts: any) => {
        sent.push({ chat, text, opts });
        return { chat: { id: chat }, message_id: 50 };
      },
    },
  };
  const repo = {
    getSetting: async (key: string) => settings[key],
    setSetting: async (key: string, value: string) => {
      sets.push([key, value]);
      settings[key] = value;
    },
  };
  const menu = new MenuController(
    bot as any,
    {} as any,
    {} as any,
    {} as any,
    (() => ({ repo })) as any,
    (async () => "") as any,
  ) as any;
  return { menu, settings, sets, sent };
}

/** A callback context that records answers and edits, and can be told to fail. */
function callbackCtx(
  over: { answerFails?: boolean; editFails?: boolean } = {},
) {
  const answers: (string | undefined)[] = [];
  const edits: { text: string; opts: any }[] = [];
  const ctx = {
    callbackQuery: { message: { chat: { id: 1 }, message_id: 2 } },
    answerCallbackQuery: async (a?: { text: string }) => {
      if (over.answerFails) throw new Error("query is too old");
      answers.push(a?.text);
    },
    editMessageText: async (text: string, opts: any) => {
      if (over.editFails) throw new Error("message to edit not found");
      edits.push({ text, opts });
    },
  };
  return { ctx, answers, edits };
}

const buttonTexts = (kb: any) =>
  kb.inline_keyboard.map((row: any[]) => row.map((b) => b.text));
const findButton = (kb: any, data: string) =>
  kb.inline_keyboard.flat().find((b: any) => b.callback_data === data);

test("the root menu shows the switches on and the default rating time when nothing is stored", async () => {
  const { menu } = settingsHarness();
  const kb = await menu.rootMenu();
  assert.equal(findButton(kb, "menu:rtsw").text, "🌙 Nightly rating: on");
  assert.equal(findButton(kb, "menu:fusw").text, "💬 Follow-up: on");
  assert.equal(findButton(kb, "menu:rtt").text, "🕛 Rating time: 00:00");
  const rows = buttonTexts(kb);
  const at = (label: string) =>
    rows.find((r: string[]) => r.some((t) => t.includes(label)));
  assert.equal(at("Nightly rating").length, 2);
  assert.equal(at("Follow-up"), at("Nightly rating"));
  assert.equal(at("Rating time").length, 1);
});

test("the root menu shows stored switches and the stored time", async () => {
  const { menu } = settingsHarness({
    nightlyRating: "off",
    nightlyFollowup: "off",
    ratingTime: "23:30",
  });
  const kb = await menu.rootMenu();
  assert.equal(findButton(kb, "menu:rtsw").text, "🌙 Nightly rating: off");
  assert.equal(findButton(kb, "menu:fusw").text, "💬 Follow-up: off");
  assert.equal(findButton(kb, "menu:rtt").text, "🕛 Rating time: 23:30");
});

test("the rating and follow-up buttons each flip their own setting", async () => {
  const rating = settingsHarness();
  const r = callbackCtx();
  await rating.menu.handleCallback(r.ctx, ["rtsw"]);
  assert.deepEqual(rating.sets, [["nightlyRating", "off"]]);
  assert.deepEqual(r.answers, ["Nightly rating off"]);

  const followup = settingsHarness();
  const f = callbackCtx();
  await followup.menu.handleCallback(f.ctx, ["fusw"]);
  assert.deepEqual(followup.sets, [["nightlyFollowup", "off"]]);
  assert.deepEqual(f.answers, ["Follow-up off"]);
});

test("a toggle redraws the root menu from the value it just wrote", async () => {
  const { menu, settings } = settingsHarness();
  const first = callbackCtx();
  await menu.handleCallback(first.ctx, ["rtsw"]);
  assert.equal(first.edits[0]?.text, "🗂 scriba control menu");
  assert.equal(
    findButton(first.edits[0]!.opts.reply_markup, "menu:rtsw").text,
    "🌙 Nightly rating: off",
  );

  const second = callbackCtx();
  await menu.handleCallback(second.ctx, ["rtsw"]);
  assert.equal(settings.nightlyRating, "on");
  assert.deepEqual(second.answers, ["Nightly rating on"]);
  assert.equal(
    findButton(second.edits[0]!.opts.reply_markup, "menu:rtsw").text,
    "🌙 Nightly rating: on",
  );
});

test("a stored off switch flips back on", async () => {
  const { menu, sets } = settingsHarness({ nightlyFollowup: "off" });
  const c = callbackCtx();
  await menu.handleCallback(c.ctx, ["fusw"]);
  assert.deepEqual(sets, [["nightlyFollowup", "on"]]);
  assert.deepEqual(c.answers, ["Follow-up on"]);
});

test("a toggle on a menu that is gone keeps the setting and does not throw", async () => {
  const { menu, sets } = settingsHarness();
  const c = callbackCtx({ editFails: true });
  await menu.handleCallback(c.ctx, ["fusw"]);
  assert.deepEqual(sets, [["nightlyFollowup", "off"]]);
  assert.deepEqual(c.answers, ["Follow-up off"]);
});

test("an expired callback query still gets the menu redrawn after the switch flipped", async () => {
  const { menu, sets } = settingsHarness();
  const c = callbackCtx({ answerFails: true });
  await menu.handleCallback(c.ctx, ["rtsw"]);
  assert.deepEqual(sets, [["nightlyRating", "off"]]);
  assert.equal(c.edits.length, 1);
  assert.equal(
    findButton(c.edits[0]!.opts.reply_markup, "menu:rtsw").text,
    "🌙 Nightly rating: off",
  );
});

test("a toggle survives both the ack and the redraw failing", async () => {
  const { menu, sets } = settingsHarness();
  const c = callbackCtx({ answerFails: true, editFails: true });
  await menu.handleCallback(c.ctx, ["fusw"]);
  assert.deepEqual(sets, [["nightlyFollowup", "off"]]);
});

test("the time button opens the time prompt and nothing else", async () => {
  const { menu, sent } = settingsHarness();
  const c = callbackCtx();
  await menu.handleCallback(c.ctx, ["rtt"]);
  assert.deepEqual(c.answers, ["Answer the prompt below ↓"]);
  assert.deepEqual(c.edits, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.chat, 1);
  assert.deepEqual(sent[0]?.opts, { reply_markup: { force_reply: true } });
  assert.ok(sent[0]?.text.includes(WIZARD_RATING_TIME_REF));
  assert.deepEqual(parseWizardRef(sent[0]!.text), { kind: "rt" });
});

function timeReply(body: string) {
  const replies: string[] = [];
  const menus: { text: string; opts: any }[] = [];
  return {
    replies,
    menus,
    ctx: {
      message: { text: body },
      reply: async (text: string, opts?: any) => {
        if (opts) menus.push({ text, opts });
        else replies.push(text);
        return { chat: { id: 1 }, message_id: 60 };
      },
    },
  };
}
const PROMPT = `when? ${WIZARD_RATING_TIME_REF}`;

test("a valid typed time is stored, handed to the scheduler, and confirmed with a menu button", async () => {
  const { menu, sets } = settingsHarness();
  const times: string[] = [];
  const scheduler = { setRatingTime: (t: string) => void times.push(t) };
  menu.setScheduler(scheduler);
  assert.equal(menu.scheduler, scheduler);
  const r = timeReply("23:30");
  await menu.handleWizardReply(r.ctx, PROMPT);
  assert.deepEqual(sets, [["ratingTime", "23:30"]]);
  assert.deepEqual(times, ["23:30"]);
  assert.equal(r.menus[0]?.text, "🕛 nightly rating at 23:30");
  assert.ok(findButton(r.menus[0]!.opts.reply_markup, "menu:root"));
});

test("typed times are stored as normalised HH:MM", async () => {
  for (const [body, stored] of [
    ["9:30", "09:30"],
    [" 09:30 ", "09:30"],
    ["0:00", "00:00"],
    ["00:00", "00:00"],
    ["23:59", "23:59"],
    ["12:30\n", "12:30"], // a trailing newline from a paste is trimmed, not rejected
  ]) {
    const { menu, sets } = settingsHarness();
    await menu.handleWizardReply(timeReply(body!).ctx, PROMPT);
    assert.deepEqual(sets, [["ratingTime", stored]], body);
  }
});

test("an unusable typed time gets the format message and changes nothing", async () => {
  for (const body of [
    "",
    "   ",
    "noon",
    "24:00",
    "12:60",
    "12:5",
    "1230",
    "12.30",
    "12:30pm",
    "७:३०",
    "12：30",
    "x".repeat(5000),
    "🕛",
    "12:30 13:30",
    "-1:30",
  ]) {
    const { menu, sets } = settingsHarness();
    const times: string[] = [];
    menu.setScheduler({ setRatingTime: (t: string) => void times.push(t) });
    const r = timeReply(body);
    await menu.handleWizardReply(r.ctx, PROMPT);
    assert.deepEqual(
      r.replies,
      ["That isn't a time. Use HH:MM in 24-hour time, like 23:30 or 00:00."],
      JSON.stringify(body.slice(0, 20)),
    );
    assert.deepEqual([sets, times, r.menus], [[], [], []]);
  }
});

test("a typed time is stored even before a scheduler is wired", async () => {
  const { menu, sets } = settingsHarness();
  const r = timeReply("22:00");
  await menu.handleWizardReply(r.ctx, PROMPT);
  assert.deepEqual(sets, [["ratingTime", "22:00"]]);
  assert.equal(r.menus.length, 1);
});
