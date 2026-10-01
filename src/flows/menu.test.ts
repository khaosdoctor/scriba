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

// --- link wizard, settings screens, jots browser, maintenance ---

type Pair = { surface: string; note: string };

/** A menu over stateful fake repository lists. `events` is one ordered log of every
 *  ack, edit and write, so a test can assert whether an ack comes before or after the I/O. */
function wizardHarness(
  init: {
    stopwords?: string[];
    rejections?: Pair[];
    pairs?: Pair[];
    settings?: Record<string, string>;
    aliases?: { note: string; alias: string }[];
    jots?: any[];
  } = {},
) {
  const events: string[] = [];
  const sent: { text: string; opts: any }[] = [];
  const jots = init.jots ?? [];
  const state = {
    stopwords: [...(init.stopwords ?? [])],
    rejections: [...(init.rejections ?? [])],
    pairs: [...(init.pairs ?? [])],
    settings: { ...init.settings } as Record<string, string>,
  };
  const without = (list: Pair[], s: string, n: string) =>
    list.filter((r) => r.surface !== s || r.note !== n);
  const repo = {
    getSetting: async (k: string) => state.settings[k],
    setSetting: async (k: string, v: string) => {
      events.push(`set ${k}=${v}`);
      state.settings[k] = v;
    },
    stopwordList: async () => [...state.stopwords],
    addStopword: async (w: string) => {
      events.push(`addStopword ${w}`);
      state.stopwords.push(w);
    },
    delStopword: async (w: string) => {
      events.push(`delStopword ${w}`);
      state.stopwords = state.stopwords.filter((s) => s !== w);
      return 1;
    },
    rejectionList: async () => [...state.rejections],
    unreject: async (s: string, n: string) => {
      events.push(`unreject ${s}|${n}`);
      state.rejections = without(state.rejections, s, n);
      return 1;
    },
    registeredLinks: async () => [...state.pairs],
    addRegisteredLink: async (s: string, n: string) => {
      events.push(`addPair ${s}|${n}`);
      state.pairs.push({ surface: s, note: n });
    },
    delRegisteredLink: async (s: string, n: string) => {
      events.push(`delPair ${s}|${n}`);
      state.pairs = without(state.pairs, s, n);
      return 1;
    },
    getJot: async (id: string) => jots.find((j) => j.id === id),
    recentJots: async () => jots,
    failedJots: async () => jots.filter((j) => j.status === "failed"),
    resetForRetry: async (id: string) => void events.push(`reset ${id}`),
    mapMessage: async (m: number, id: string) =>
      void events.push(`map ${m} ${id}`),
    resetFailed: async (all: boolean) => {
      events.push(`resetFailed all=${all}`);
      return 2;
    },
    resetProcessing: async () => 2,
  };
  const deps = {
    repo,
    links: {
      list: () => init.aliases ?? [],
      stats: () => ({ enabled: true, aliases: 3, files: 2 }),
    },
    enricher: { setModel: (m: string) => events.push(`enricher ${m}`) },
    queue: {
      depth: 3,
      add: (id: string) => events.push(`queue ${id}`),
      flush: async () => void events.push("flush"),
    },
    processor: { retrySweep: async () => void events.push("sweep") },
  };
  const bot = {
    api: {
      sendMessage: async (_chat: number, text: string, opts: any) => {
        sent.push({ text, opts });
        return { chat: { id: 1 }, message_id: 50 };
      },
    },
  };
  const menu = new MenuController(
    bot as any,
    {} as any,
    {} as any,
    {} as any,
    (() => deps) as any,
    (async (jot: any) => {
      events.push(`deleteJot ${jot.id}`);
      return "🗑 deleted";
    }) as any,
  ) as any;

  async function tap(data: string, over: { deleteFails?: boolean } = {}) {
    const answers: (string | undefined)[] = [];
    const edits: { text: string; kb: any }[] = [];
    const replies: string[] = [];
    const ctx = {
      chat: { id: 1 },
      callbackQuery: { message: { chat: { id: 1 }, message_id: 2 } },
      answerCallbackQuery: async (a?: { text: string }) => {
        answers.push(a?.text);
        events.push(a?.text ? `ack ${a.text}` : "ack");
      },
      editMessageText: async (text: string, opts: any) => {
        edits.push({ text, kb: opts.reply_markup });
        events.push("edit");
      },
      reply: async (text: string) => void replies.push(text),
      deleteMessage: async () => {
        if (over.deleteFails) throw new Error("message can't be deleted");
        events.push("delete");
      },
    };
    await menu.handleCallback(ctx, data.split(":"));
    const last = edits.at(-1);
    return { answers, edits, replies, text: last?.text, kb: last?.kb };
  }

  async function reply(marker: string, body: string) {
    const r = timeReply(body);
    await menu.handleWizardReply(r.ctx, `prompt ${marker}`);
    return { replies: r.replies, menus: r.menus };
  }

  return {
    menu,
    events,
    take: () => events.splice(0),
    sent,
    state,
    tap,
    reply,
  };
}

const callbacks = (kb: any) =>
  kb.inline_keyboard.flat().map((b: any) => b.callback_data);
const words = (n: number, prefix = "w") =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const pair = (surface: string, note: string): Pair => ({ surface, note });

test("the never-link screen summarises the words and offers removal only when there are some", async () => {
  const empty = await wizardHarness().tap("lsw");
  assert.ok(empty.text?.includes("No never-link words yet."));
  assert.deepEqual(buttonTexts(empty.kb), [
    ["➕ Add a word"],
    ["‹ Back"],
    ["✖ Close"],
  ]);

  const some = await wizardHarness({ stopwords: ["a", "b"] }).tap("lsw");
  assert.ok(
    some.text?.includes("2 word(s) are skipped as link candidates:\na, b"),
  );
  assert.ok(findButton(some.kb, "menu:lswl:0"));

  const many = await wizardHarness({ stopwords: words(45) }).tap("lsw");
  assert.ok(many.text?.includes("w39 … +5 more"));
  assert.ok(
    many.text?.includes('Tap "🗑 Remove a word" to page through all of them.'),
  );
});

test("typed never-link words are normalised, de-duplicated and stored one by one", async () => {
  const h = wizardHarness();
  const r = await h.reply("(lw:sw)", "Foo, bar\nfoo");
  assert.deepEqual(h.take(), ["addStopword foo", "addStopword bar"]);
  assert.equal(r.menus[0]?.text, "🔇 never linking: foo, bar");
  assert.ok(findButton(r.menus[0]!.opts.reply_markup, "menu:links"));

  const none = await h.reply("(lw:sw)", " , ");
  assert.deepEqual(none.replies, ["Nothing to add \u{2014} send a word."]);
  assert.deepEqual(h.take(), []);
});

test("the stopword list pages eight at a time and clamps an out-of-range page", async () => {
  const h = wizardHarness({ stopwords: words(10) });
  const first = await h.tap("lswl:0");
  assert.equal(
    callbacks(first.kb).filter((c: string) => c.startsWith("menu:lswd:"))
      .length,
    8,
  );
  assert.ok(first.text?.endsWith("(page 1/2)"));
  assert.ok(findButton(first.kb, "menu:lswl:1"));
  assert.equal(findButton(first.kb, "menu:lswl:-1"), undefined);

  const last = await h.tap("lswl:9");
  assert.ok(last.text?.endsWith("(page 2/2)"));
  assert.deepEqual(callbacks(last.kb).slice(0, 3), [
    "menu:lswd:8",
    "menu:lswd:9",
    "menu:lswl:0",
  ]);

  const gone = await wizardHarness().tap("lswl:0");
  assert.equal(gone.text, "🔇 No never-link words left.");
});

test("removing a never-link word answers before the write and redraws its page", async () => {
  const h = wizardHarness({ stopwords: words(10) });
  const t = await h.tap("lswd:9");
  assert.deepEqual(h.take(), ["ack", "delStopword w9", "edit"]);
  assert.ok(t.text?.endsWith("(page 2/2)"));
  assert.deepEqual(callbacks(t.kb).slice(0, 2), ["menu:lswd:8", "menu:lswl:0"]);

  const stale = await h.tap("lswd:99");
  assert.deepEqual(h.take(), ["ack expired"]);
  assert.deepEqual(stale.edits, []);
});

test("rejected pairs page by word, then by note, and an undo falls back one level when the word is cleared", async () => {
  const h = wizardHarness({
    rejections: [
      pair("go", "Go (lang)"),
      pair("go", "Go game"),
      pair("rust", "Rust"),
    ],
  });
  const wordsPage = await h.tap("lrj:0");
  assert.deepEqual(buttonTexts(wordsPage.kb).slice(0, 2), [
    ["🚫 go · 2 note(s)"],
    ["🚫 rust · 1 note(s)"],
  ]);
  assert.equal(
    findButton(wordsPage.kb, "menu:lrjs:1").text,
    "🚫 rust · 1 note(s)",
  );

  const notes = await h.tap("lrjs:0");
  assert.equal(
    notes.text,
    '🔗 Link rules › 🚫 go \u{2014} step 3 of 3\n\n2 note(s) rejected. Tap one to let "go" link to it again.',
  );
  assert.deepEqual(callbacks(notes.kb).slice(0, 3), [
    "menu:lrju:0:0",
    "menu:lrju:0:1",
    "menu:lrj:0",
  ]);

  h.take();
  const one = await h.tap("lrju:0:1");
  assert.deepEqual(h.take(), ["ack", "unreject go|Go game", "edit"]);
  assert.deepEqual(callbacks(one.kb).slice(0, 2), [
    "menu:lrju:0:0",
    "menu:lrj:0",
  ]);

  const last = await h.tap("lrju:0:0");
  assert.ok(
    last.text?.startsWith(
      "🔗 Link rules › 🚫 Rejected pairs \u{2014} step 2 of 3",
    ),
  );
  assert.deepEqual(buttonTexts(last.kb).slice(0, 1), [["🚫 rust · 1 note(s)"]]);
});

test("a rejected-pair tap that no longer resolves answers expired and a bad word index shows the word list", async () => {
  const h = wizardHarness({ rejections: [pair("go", "Go game")] });
  const stale = await h.tap("lrju:5:0");
  assert.deepEqual(stale.answers, ["expired"]);
  assert.deepEqual((await h.tap("lrju:0:7")).answers, ["expired"]);
  assert.deepEqual(
    h.take().filter((e) => e.startsWith("unreject")),
    [],
  );
  assert.ok(
    (await h.tap("lrjs:9")).text?.startsWith(
      "🔗 Link rules › 🚫 Rejected pairs",
    ),
  );
  assert.equal(
    (await wizardHarness().tap("lrj:0")).text,
    "🚫 No rejected links.",
  );
});

test("one word with many rejected notes pages through its notes", async () => {
  const rejections = words(10, "n").map((n) => pair("go", n));
  const h = wizardHarness({ rejections });
  const page = await h.tap("lrjs:0:1");
  assert.ok(page.text?.endsWith("(page 2/2)"));
  assert.deepEqual(callbacks(page.kb), [
    "menu:lrju:0:8",
    "menu:lrju:0:9",
    "menu:lrjs:0:0",
    "menu:lrj:0",
    "menu:close",
  ]);
});

test("registered pairs page, show a detail screen, and drop with the ack first", async () => {
  const pairs = words(10, "s").map((s) => pair(s, `Note ${s}`));
  const h = wizardHarness({ pairs });
  const list = await h.tap("lrg:1");
  assert.deepEqual(buttonTexts(list.kb).slice(0, 3), [
    ["➕ Add word(s)"],
    ["s8 → Note s8"],
    ["s9 → Note s9"],
  ]);
  assert.ok(
    list.text?.includes(
      "10 pair(s) linked with no judgment call. Tap one to change it. (page 2/2)",
    ),
  );
  assert.ok(
    (await wizardHarness().tap("lrg")).text?.endsWith(
      "No always-link pairs yet.",
    ),
  );

  const detail = await h.tap("lrgv:9");
  assert.equal(
    detail.text,
    '🔗 Link rules › 🔗 Always link › s9 \u{2014} step 3 of 3\n\n"s9" always links to [[Note s9]].',
  );
  assert.deepEqual(callbacks(detail.kb).slice(0, 4), [
    "menu:lrgt:9",
    "menu:lrgw:9",
    "menu:lrgd:9",
    "menu:lrg:1",
  ]);
  assert.ok(
    (await h.tap("lrgv:99")).text?.startsWith(
      "🔗 Link rules › 🔗 Always link \u{2014} step 2",
    ),
  );

  h.take();
  const drop = await h.tap("lrgd:9");
  assert.deepEqual(h.take(), ["ack dropped s9", "delPair s9|Note s9", "edit"]);
  assert.ok(drop.text?.includes("9 pair(s)"));
  assert.deepEqual((await h.tap("lrgd:99")).answers, ["expired"]);
});

test("retargeting a pair swaps its note and returns to the pair list", async () => {
  const h = wizardHarness({
    pairs: [pair("ts", "Old note")],
    aliases: [{ note: "TypeScript", alias: "ts" }],
  });
  const picker = await h.tap("lrgt:0");
  assert.equal(
    picker.text,
    '🔗 "ts" → which note?\n\n1 match(es) for "ts". Tap one, or search again.',
  );
  assert.deepEqual(buttonTexts(picker.kb), [
    ["📝 TypeScript"],
    ["🔎 Search by another name"],
    ["✍️ Type a note that doesn't exist yet"],
    ["✖ Cancel"],
    ["✖ Close"],
  ]);
  h.take();
  const done = await h.tap("lrgp:0");
  assert.deepEqual(h.take(), [
    "ack ts → TypeScript",
    "delPair ts|Old note",
    "addPair ts|TypeScript",
    "edit",
  ]);
  assert.ok(
    done.text?.startsWith(
      "🔗 Link rules › 🔗 Always link \u{2014} step 2 of 3",
    ),
  );
  assert.deepEqual((await h.tap("lrgp:0")).answers, ["expired"]);
  assert.deepEqual((await h.tap("lrgt:7")).answers, ["expired"]);
});

test("a queue of typed words walks through the picker, and skip and cancel clear or advance it", async () => {
  const h = wizardHarness({ aliases: [{ note: "TypeScript", alias: "ts" }] });
  await h.reply("(lw:rg)", "ts, js");
  assert.equal(
    h.sent[0]?.text,
    '🔗 "ts" → which note? (word 1 of 2)\n\n1 match(es) for "ts". Tap one, or search again.',
  );
  assert.ok(findButton(h.sent[0]!.opts.reply_markup, "menu:lrgs"));
  assert.ok(findButton(h.sent[0]!.opts.reply_markup, "menu:close"));

  const skipped = await h.tap("lrgs");
  assert.deepEqual(skipped.answers, ["skipped"]);
  assert.equal(
    skipped.text,
    '🔗 "js" → which note? (word 2 of 2)\n\nNothing in the vault matches "js". Search again with another part of the title.',
  );
  const end = await h.tap("lrgs");
  assert.ok(
    end.text?.startsWith("🔗 Link rules › 🔗 Always link \u{2014} step 2 of 3"),
  );
  assert.deepEqual((await h.tap("lrgp:0")).answers, ["expired"]);

  await h.reply("(lw:rg)", "ts");
  const cancelled = await h.tap("lrgc");
  assert.deepEqual(cancelled.answers, ["cancelled"]);
  assert.ok(cancelled.text?.startsWith("🔗 Link rules › 🔗 Always link"));
  assert.deepEqual((await h.tap("lrgp:0")).answers, ["expired"]);
  assert.ok(!h.events.some((e) => e.startsWith("addPair")));
});

test("the note picker pages six matches at a time and a pick on page two takes that page's row", async () => {
  const aliases = words(14, "note").map((a) => ({
    note: `Note ${a}`,
    alias: a,
  }));
  const h = wizardHarness({ aliases });
  await h.reply("(lw:rg)", "note");
  const page = await h.tap("lrgn:1");
  assert.ok(page.text?.includes('14 match(es) for "note", page 2/3.'));
  assert.deepEqual(callbacks(page.kb).slice(0, 8), [
    "menu:lrgp:0",
    "menu:lrgp:1",
    "menu:lrgp:2",
    "menu:lrgp:3",
    "menu:lrgp:4",
    "menu:lrgp:5",
    "menu:lrgn:0",
    "menu:lrgn:2",
  ]);
  const picked = await h.tap("lrgp:0");
  assert.equal(picked.answers[0], "note → Note note6");
  assert.ok(h.events.includes("addPair note|Note note6"));
});

test("the note picker without a pending flow tells the user to reopen the menu", async () => {
  const t = await wizardHarness().tap("lrgn:0");
  assert.deepEqual(t.replies, [
    "That link flow expired \u{2014} reopen /menu.",
  ]);
});

test("the search and manual-title replies drive the pending flow, and need one", async () => {
  const h = wizardHarness({
    aliases: [{ note: "TypeScript", alias: "typescript" }],
  });
  const gone = await h.reply("(lw:rgn)", "type");
  assert.deepEqual(gone.replies, [
    "That link flow expired \u{2014} reopen /menu.",
  ]);
  assert.deepEqual((await h.reply("(lw:rgm)", "x")).replies, [
    "That link flow expired \u{2014} reopen /menu.",
  ]);

  await h.reply("(lw:rg)", "ts");
  await h.reply("(lw:rgn)", "[[type]]");
  assert.ok(h.sent.at(-1)?.text.includes('1 match(es) for "type"'));

  const empty = await h.reply("(lw:rgm)", "[[ ]]");
  assert.deepEqual(empty.replies, [
    "Nothing to link to \u{2014} send a note title.",
  ]);

  const manual = await h.reply("(lw:rgm)", '"My new note"');
  assert.deepEqual(manual.replies, ['🔗 "ts" → [[My new note]]']);
  assert.ok(h.events.includes("addPair ts|My new note"));
  assert.equal(h.sent.at(-1)?.text, "🔗 Always-link rules updated.");
  assert.ok(findButton(h.sent.at(-1)!.opts.reply_markup, "menu:links"));
});

test("renaming a pair's word keeps its note, and a vanished pair is reported", async () => {
  const h = wizardHarness({ pairs: [pair("ts", "TypeScript")] });
  const ok = await h.reply("(lw:rgw:0)", "TypeScript lang");
  assert.deepEqual(h.take(), [
    "delPair ts|TypeScript",
    "addPair typescript lang|TypeScript",
  ]);
  assert.equal(
    ok.menus[0]?.text,
    '✏️ "typescript lang" always links to [[TypeScript]]',
  );

  assert.deepEqual((await h.reply("(lw:rgw:5)", "x")).replies, [
    "That pair is gone \u{2014} reopen /menu.",
  ]);
  assert.deepEqual((await h.reply("(lw:rgw:0)", " ")).replies, [
    "Nothing to rename to \u{2014} send a word.",
  ]);
  assert.deepEqual((await h.reply("(lw:rg)", " ")).replies, [
    "Nothing to add \u{2014} send a word.",
  ]);
});

test("each link-rule button sends a force-reply prompt carrying its marker", async () => {
  const h = wizardHarness({ pairs: [pair("ts", "TypeScript")] });
  for (const [data, kind] of [
    ["lswa", "sw"],
    ["lrga", "rg"],
    ["lrgw:0", "rgw"],
  ] as const) {
    const t = await h.tap(data);
    assert.deepEqual(t.answers, ["Answer the prompt below ↓"]);
    assert.equal(parseWizardRef(h.sent.at(-1)!.text)?.kind, kind, data);
    assert.deepEqual(h.sent.at(-1)!.opts, {
      reply_markup: { force_reply: true },
    });
  }
  assert.deepEqual(parseWizardRef(h.sent.at(-1)!.text), {
    kind: "rgw",
    index: 0,
  });
});

test("the model picker marks the current model and a pick stores it, telling the enricher only for enrichment", async () => {
  const h = wizardHarness({ settings: { enrichModel: "claude-sonnet-5" } });
  const picker = await h.tap("em");
  assert.equal(picker.text, "🧠 Enrichment model\n\nCurrent: claude-sonnet-5");
  assert.deepEqual(buttonTexts(picker.kb), [
    ["haiku 4.5"],
    ["✅ sonnet 5"],
    ["opus 5"],
    ["✍️ Type a model"],
    ["‹ Back"],
    ["✖ Close"],
  ]);
  assert.ok(findButton(picker.kb, "menu:ems:claude-opus-5"));

  h.take();
  const pick = await h.tap("ems:claude-opus-5");
  assert.deepEqual(h.take(), [
    "set enrichModel=claude-opus-5",
    "enricher claude-opus-5",
    "ack enrichment: opus 5",
    "edit",
  ]);
  assert.equal(pick.kb.inline_keyboard[2][0].text, "✅ opus 5");

  const vf = await h.tap("vfs:claude-haiku-4-5");
  assert.deepEqual(h.take(), [
    "set voiceFixModel=claude-haiku-4-5",
    "ack voice fix: haiku 4.5",
    "edit",
  ]);
  assert.equal(vf.text, "🎤 Voice fix model\n\nCurrent: claude-haiku-4-5");

  assert.deepEqual((await h.tap("ems")).answers, ["expired"]);
  assert.deepEqual((await h.tap("vfs:  ")).answers, ["expired"]);
  assert.deepEqual(h.take(), ["ack expired", "ack expired"]);
});

test("a typed model id is trimmed and stored, and the custom-model buttons send their prompts", async () => {
  const h = wizardHarness();
  const em = await h.reply("(md:em)", " claude-sonnet-5-20260101 ");
  assert.deepEqual(h.take(), [
    "set enrichModel=claude-sonnet-5-20260101",
    "enricher claude-sonnet-5-20260101",
  ]);
  assert.equal(
    em.menus[0]?.text,
    "🧠 enrichment model: claude-sonnet-5-20260101",
  );
  assert.ok(findButton(em.menus[0]!.opts.reply_markup, "menu:em"));

  const vf = await h.reply("(md:vfm)", "claude-haiku-4-5");
  assert.deepEqual(h.take(), ["set voiceFixModel=claude-haiku-4-5"]);
  assert.equal(vf.menus[0]?.text, "🧠 voice fix model: claude-haiku-4-5");
  assert.ok(findButton(vf.menus[0]!.opts.reply_markup, "menu:vfm"));

  const empty = await h.reply("(md:em)", "  ");
  assert.deepEqual(empty.replies, ["Send a model ID (e.g. claude-sonnet-5)."]);

  await h.tap("emc");
  assert.ok(
    h.sent.at(-1)!.text.includes("model ID for enrichment") &&
      h.sent.at(-1)!.text.includes("(md:em)"),
  );
  await h.tap("vfc");
  assert.ok(
    h.sent.at(-1)!.text.includes("model ID for voice fix") &&
      h.sent.at(-1)!.text.includes("(md:vfm)"),
  );
});

test("the entry-size screen marks the current preset, and the default applies when nothing is stored", async () => {
  const stored = await wizardHarness({
    settings: { entryMaxChars: "560" },
  }).tap("esz");
  assert.deepEqual(buttonTexts(stored.kb), [
    ["140 chars"],
    ["280 chars"],
    ["✅ 560 chars"],
    ["1000 chars"],
    ["Don't split"],
    ["✍️ Type a size"],
    ["‹ Back"],
    ["✖ Close"],
  ]);
  assert.ok(
    stored.text?.includes(
      "Entries longer than 560 characters are split into several journal lines.",
    ),
  );

  const off = await wizardHarness({ settings: { entryMaxChars: "0" } }).tap(
    "esz",
  );
  assert.ok(off.text?.includes("Splitting is off"));
  assert.equal(buttonTexts(off.kb)[4]![0], "✅ Don't split");

  const unset = await wizardHarness().tap("esz");
  assert.equal(buttonTexts(unset.kb)[1]![0], "✅ 280 chars");
});

test("an entry-size tap answers first, stores the number and redraws; a bad payload expires", async () => {
  const h = wizardHarness();
  const t = await h.tap("ess:1000");
  assert.deepEqual(h.take(), [
    "ack 1000 chars",
    "set entryMaxChars=1000",
    "edit",
  ]);
  assert.equal(buttonTexts(t.kb)[3]![0], "✅ 1000 chars");

  assert.deepEqual((await h.tap("ess:0")).answers, ["splitting off"]);
  h.take();
  for (const bad of ["ess", "ess:abc", "ess:-5", "ess:2.5"]) {
    assert.deepEqual((await h.tap(bad)).answers, ["expired"], bad);
  }
  assert.deepEqual(h.take(), Array(4).fill("ack expired"));
});

test("a typed entry size is validated, 'off' stops splitting, and the prompt button carries its marker", async () => {
  const h = wizardHarness();
  const on = await h.reply("(es:n)", "500");
  assert.deepEqual(h.take(), ["set entryMaxChars=500"]);
  assert.equal(on.menus[0]?.text, "✂️ entries split above 500 characters");
  assert.ok(findButton(on.menus[0]!.opts.reply_markup, "menu:esz"));

  const off = await h.reply("(es:n)", "off");
  assert.deepEqual(h.take(), ["set entryMaxChars=0"]);
  assert.equal(
    off.menus[0]?.text,
    "✂️ splitting off \u{2014} entries stay on one line",
  );

  for (const bad of ["39", "4001", "lots", ""]) {
    const r = await h.reply("(es:n)", bad);
    assert.deepEqual(
      r.replies,
      ['Give me a whole number between 40 and 4000, or "off".'],
      bad,
    );
  }
  assert.deepEqual(h.take(), []);

  await h.tap("esc");
  assert.ok(h.sent.at(-1)!.text.includes("(es:n)"));
});

test("the voice-fix button toggles the stored value, defaulting to on from unset", async () => {
  const h = wizardHarness();
  const first = await h.tap("vfix");
  assert.deepEqual(h.take(), [
    "set fixVoiceTranscript=on",
    "ack Voice fix on",
    "edit",
  ]);
  assert.equal(findButton(first.kb, "menu:vfix").text, "🔧 Voice fix: on");
  await h.tap("vfix");
  assert.equal(h.state.settings.fixVoiceTranscript, "off");
});

test("closing deletes the menu message, or clears its buttons when the delete fails", async () => {
  const h = wizardHarness();
  const closed = await h.tap("close");
  assert.deepEqual(h.take(), ["ack", "delete"]);
  assert.deepEqual(closed.edits, []);

  const stuck = await h.tap("close", { deleteFails: true });
  assert.equal(stuck.text, "🗂 Menu closed.");
  assert.deepEqual(stuck.kb.inline_keyboard.flat(), []);
});

test("the jots browser lists recent jots, shows a detail card and handles a missing id", async () => {
  const jot = {
    id: "abc12345",
    kind: "text",
    status: "failed",
    time: "10:00",
    raw_text: "hello  there",
    transcript: null,
    note_path: "Daily/2026-10-01.md",
    anchor: "abc12345",
    asset_path: null,
    attempts: 3,
    error: "boom",
    received_at: 0,
  };
  const h = wizardHarness({ jots: [jot] });
  const list = await h.tap("jots");
  assert.equal(list.text, "🗒 Recent jots:");
  assert.equal(
    findButton(list.kb, "menu:jot:abc12345").text,
    "❌ 10:00 hello there",
  );
  assert.equal((await wizardHarness().tap("jots")).text, "No jots yet.");

  const detail = await h.tap("jot:abc12345");
  assert.ok(detail.text?.startsWith("🧾 abc12345 [text] \u{2014} failed\n"));
  assert.ok(detail.text?.includes("Error: boom"));
  assert.deepEqual(callbacks(detail.kb).slice(0, 4), [
    "menu:jr:abc12345",
    "menu:je:abc12345",
    "menu:jd:abc12345",
    "menu:jots",
  ]);
  const missing = await h.tap("jot:nope");
  assert.equal(missing.text, "No jot nope.");
  assert.deepEqual(callbacks(missing.kb), ["menu:jots", "menu:close"]);
});

test("retry resets and queues before it answers, delete answers before the note work, edit maps its prompt", async () => {
  const h = wizardHarness({ jots: [{ id: "abc12345", status: "failed" }] });
  const retry = await h.tap("jr:abc12345");
  assert.deepEqual(h.take(), [
    "reset abc12345",
    "queue abc12345",
    "ack retrying",
    "edit",
  ]);
  assert.equal(retry.text, "🔄 retrying abc12345…");

  const confirm = await h.tap("jd:abc12345");
  assert.equal(
    confirm.text,
    "Delete jot abc12345? This removes its line from the journal.",
  );
  assert.deepEqual(callbacks(confirm.kb).slice(0, 2), [
    "menu:jdy:abc12345",
    "menu:jot:abc12345",
  ]);

  h.take();
  const del = await h.tap("jdy:abc12345");
  assert.deepEqual(h.take(), ["ack", "deleteJot abc12345", "edit"]);
  assert.equal(del.text, "🗑 deleted");

  await h.tap("je:abc12345");
  assert.deepEqual(h.take(), ["ack", "map 50 abc12345"]);
  assert.ok(h.sent.at(-1)!.text.includes("with your edit for abc12345"));

  for (const data of ["jr:zzz", "jdy:zzz", "je:zzz"]) {
    assert.deepEqual((await h.tap(data)).answers, ["gone"], data);
  }
  assert.deepEqual(h.take(), Array(3).fill("ack gone"));
});

test("the failed list shows each failure with a retry button, and says so when none failed", async () => {
  const failed = {
    id: "f1",
    kind: "text",
    status: "failed",
    attempts: 3,
    error: "boom",
  };
  const t = await wizardHarness({ jots: [failed] }).tap("failed");
  assert.equal(t.text, "⚠️ 1 failed:\nf1 [text] failed ×3 \u{2014} boom");
  assert.deepEqual(callbacks(t.kb), ["rt:f1", "menu:root", "menu:close"]);
  assert.equal(
    (await wizardHarness().tap("failed")).text,
    "✅ nothing failed.",
  );
});

test("maintenance actions answer first, run their command, and show the result over the maintenance menu", async () => {
  const h = wizardHarness();
  const screen = await h.tap("maint");
  assert.equal(screen.text, "🛠 Maintenance");
  assert.deepEqual(buttonTexts(screen.kb), [
    ["⚡ Flush", "🧹 Sweep"],
    ["🔧 Unstick", "🔄 Retry all"],
    ["‹ Back"],
    ["✖ Close"],
  ]);

  h.take();
  const flush = await h.tap("flush");
  assert.deepEqual(h.take(), ["ack", "flush", "edit"]);
  assert.equal(flush.text, "⚡ flushed (3 queued)");
  assert.ok(findButton(flush.kb, "menu:retryall"));
  assert.equal((await h.tap("sweep")).text, "🧹 sweep done");
  assert.equal((await h.tap("unstick")).text, "🔧 unstuck 2 jots");
});

test("retry-all asks for confirmation, then requeues failed and abandoned jots", async () => {
  const h = wizardHarness();
  const ask = await h.tap("retryall");
  assert.equal(ask.text, "Requeue every failed jot?");
  assert.deepEqual(callbacks(ask.kb).slice(0, 2), [
    "menu:retryally",
    "menu:maint",
  ]);
  assert.deepEqual(h.take(), ["ack", "edit"]);

  const done = await h.tap("retryally");
  assert.deepEqual(h.take(), ["ack", "resetFailed all=true", "sweep", "edit"]);
  assert.equal(done.text, "🔄 requeued 2 jots (incl. abandoned)");
});

test("the stats button offers a range picker, and an unknown action is answered silently", async () => {
  const h = wizardHarness();
  const picker = await h.tap("stats");
  assert.equal(picker.text, "📈 Stats range:");
  assert.deepEqual(callbacks(picker.kb).slice(0, 3), [
    "menu:stats:today",
    "menu:stats:week",
    "menu:stats:all",
  ]);
  h.take();
  const unknown = await h.tap("nope");
  assert.deepEqual(
    [unknown.answers, unknown.edits, h.take()],
    [[undefined], [], ["ack"]],
  );
});
