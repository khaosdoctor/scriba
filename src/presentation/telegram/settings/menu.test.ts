import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Jot } from "../../../domain/jot/entity.ts";
import { parseWizardRef } from "../../../libs/wizard.ts";
import {
  botHarness,
  EM,
  type Harness,
  OWNER,
  type Run,
  sampleJot,
} from "../../../test/bot-harness.ts";

type Payload = { text: string; reply_markup?: any };

const call = (run: Run, method: string): Payload | undefined =>
  run.calls.find((apiCall) => apiCall.method === method)?.payload;
const edit = (run: Run) => call(run, "editMessageText");
const buttons = (payload: Payload | undefined): any[] =>
  (payload?.reply_markup?.inline_keyboard ?? []).flat();
const button = (payload: Payload | undefined, data: string) =>
  buttons(payload).find((entry) => entry.callback_data === data);
const labels = (payload: Payload | undefined): string[][] =>
  (payload?.reply_markup?.inline_keyboard ?? []).map((row: any[]) =>
    row.map((entry) => entry.text),
  );
const callbacks = (payload: Payload | undefined): string[] =>
  buttons(payload).map((entry) => entry.callback_data);
const answers = (run: Run) =>
  run.calls
    .filter((apiCall) => apiCall.method === "answerCallbackQuery")
    .map((apiCall) => apiCall.payload.text);

const withStored = async (stored: Record<string, string> = {}) => {
  const harness = await botHarness();
  for (const [key, value] of Object.entries(stored))
    harness.settings.set(key, value);
  return harness;
};

test("the root menu shows every switch, the sizes and the models as stored, with defaults when nothing is", async () => {
  const bare = edit(await (await withStored()).tap("menu:root"));
  assert.equal(bare?.text, "🗂 scriba control menu");
  assert.equal(button(bare, "menu:esz").text, "✂️ Entry size: 280 chars");
  assert.equal(button(bare, "menu:vfix").text, "🔧 Voice fix: off");
  assert.equal(button(bare, "menu:rtsw").text, "🌙 Nightly rating: on");
  assert.equal(button(bare, "menu:fusw").text, "💬 Follow-up: on");
  assert.equal(button(bare, "menu:rtt").text, "🕛 Rating time: 00:00");
  assert.equal(button(bare, "menu:em").text, "🧠 Enrich: ?");
  const rows = labels(bare);
  const at = (label: string) =>
    rows.find((row) => row.some((text) => text.includes(label)));
  assert.equal(at("Nightly rating")?.length, 2);
  assert.equal(at("Follow-up"), at("Nightly rating"));
  assert.equal(at("Rating time")?.length, 1);

  const stored = edit(
    await (
      await withStored({
        entryMaxChars: "0",
        fixVoiceTranscript: "on",
        nightlyRating: "off",
        nightlyFollowup: "off",
        ratingTime: "23:30",
        enrichModel: "claude-sonnet-5-20260101",
        voiceFixModel: "claude-haiku-4-5-20251001",
      })
    ).tap("menu:root"),
  );
  assert.equal(button(stored, "menu:esz").text, "✂️ Entry size: off");
  assert.equal(button(stored, "menu:vfix").text, "🔧 Voice fix: on");
  assert.equal(button(stored, "menu:rtsw").text, "🌙 Nightly rating: off");
  assert.equal(button(stored, "menu:fusw").text, "💬 Follow-up: off");
  assert.equal(button(stored, "menu:rtt").text, "🕛 Rating time: 23:30");
  assert.equal(button(stored, "menu:em").text, "🧠 Enrich: sonnet 5-20260101");
  assert.equal(
    button(stored, "menu:vfm").text,
    "🎤 VF model: haiku 4.5-20251001",
  );
});

test("/menu sends a fresh root menu and retires the chat's previous one", async () => {
  const harness = await botHarness();
  const first = await harness.say("/menu");
  assert.equal(
    first.rendered,
    "repo.getSetting×6 > repo.ratingTime > tg.sendMessage",
  );
  const sent = call(first, "sendMessage");
  assert.equal(sent?.text, "🗂 scriba control menu");
  assert.ok(button(sent, "menu:close"));

  const second = await harness.say("/menu");
  assert.equal(
    second.rendered,
    "tg.deleteMessage > repo.getSetting×6 > repo.ratingTime > tg.sendMessage",
  );
  // The recording api numbers sent messages from 900 up, so 900 is the first menu.
  assert.equal(second.calls[0]?.payload.message_id, 900);
});

test("the rating and follow-up buttons each switch their own setting and redraw from the value just written", async () => {
  const harness = await botHarness();
  const first = await harness.tap("menu:rtsw");
  assert.equal(harness.settings.get("nightlyRating"), "off");
  assert.equal(harness.settings.has("nightlyFollowup"), false);
  assert.deepEqual(answers(first), ["Nightly rating off"]);
  assert.equal(edit(first)?.text, "🗂 scriba control menu");
  assert.equal(button(edit(first), "menu:rtsw").text, "🌙 Nightly rating: off");

  const second = await harness.tap("menu:rtsw");
  assert.equal(harness.settings.get("nightlyRating"), "on");
  assert.deepEqual(answers(second), ["Nightly rating on"]);
  assert.equal(button(edit(second), "menu:rtsw").text, "🌙 Nightly rating: on");

  const followup = await (await withStored({ nightlyFollowup: "off" })).tap(
    "menu:fusw",
  );
  assert.deepEqual(answers(followup), ["Follow-up on"]);
  assert.equal(button(edit(followup), "menu:fusw").text, "💬 Follow-up: on");
});

test("the voice-fix button toggles the stored value, defaulting to on from unset", async () => {
  const harness = await botHarness();
  const first = await harness.tap("menu:vfix");
  assert.equal(harness.settings.get("fixVoiceTranscript"), "on");
  assert.deepEqual(answers(first), ["Voice fix on"]);
  assert.equal(button(edit(first), "menu:vfix").text, "🔧 Voice fix: on");
  await harness.tap("menu:vfix");
  assert.equal(harness.settings.get("fixVoiceTranscript"), "off");
});

test("a toggle keeps its write when the menu is gone, when the query expired, and when both are refused", async () => {
  const gone = await botHarness();
  gone.failApi.add("editMessageText");
  const goneRun = await gone.tap("menu:fusw");
  assert.equal(gone.settings.get("nightlyFollowup"), "off");
  assert.deepEqual(answers(goneRun), ["Follow-up off"]);

  const expired = await botHarness();
  expired.failApi.add("answerCallbackQuery");
  const expiredRun = await expired.tap("menu:rtsw");
  assert.equal(expired.settings.get("nightlyRating"), "off");
  assert.equal(
    button(edit(expiredRun), "menu:rtsw").text,
    "🌙 Nightly rating: off",
  );

  const both = await botHarness();
  both.failApi.add("answerCallbackQuery");
  both.failApi.add("editMessageText");
  await both.tap("menu:fusw");
  assert.equal(both.settings.get("nightlyFollowup"), "off");
});

test("a typed-value button sends a force reply with its marker and leaves the menu as it is", async () => {
  const harness = await botHarness();
  for (const [data, kind] of [
    ["menu:rtt", "rt"],
    ["menu:esc", "es"],
    ["menu:emc", "em"],
    ["menu:vfc", "vfm"],
    ["menu:lswa", "sw"],
    ["menu:lrga", "rg"],
    ["menu:lrgw:0", "rgw"],
    ["menu:lrgq", "rgn"],
    ["menu:lrgm", "rgm"],
  ] as const) {
    const run = await harness.tap(data);
    assert.deepEqual(answers(run), ["Answer the prompt below ↓"], data);
    assert.equal(edit(run), undefined, data);
    const sent = run.calls.find(
      (apiCall) => apiCall.method === "sendMessage",
    )?.payload;
    assert.equal(sent?.chat_id, OWNER);
    assert.deepEqual(sent?.reply_markup, { force_reply: true });
    assert.equal(parseWizardRef(sent?.text)?.kind, kind, data);
  }
});

test("the model picker marks the current model, and a pick stores it, telling the enricher only for enrichment", async () => {
  const harness = await withStored({ enrichModel: "claude-sonnet-5-5" });
  const models: string[] = [];
  harness.enricher.setModel = (model: string) => void models.push(model);
  const picker = edit(await harness.tap("menu:em"));
  assert.equal(
    picker?.text,
    "🧠 Enrichment model\n\nCurrent: claude-sonnet-5-5",
  );
  assert.deepEqual(labels(picker), [
    ["haiku 5.5"],
    ["✅ sonnet 5.5"],
    ["opus 5"],
    ["✍️ Type a model"],
    ["‹ Back"],
    ["✖ Close"],
  ]);
  assert.ok(button(picker, "menu:ems:claude-opus-5"));

  const pick = await harness.tap("menu:ems:claude-opus-5");
  assert.equal(harness.settings.get("enrichModel"), "claude-opus-5");
  assert.deepEqual(models, ["claude-opus-5"]);
  assert.deepEqual(answers(pick), ["enrichment: opus 5"]);
  assert.deepEqual(labels(edit(pick))[2], ["✅ opus 5"]);

  const vf = await harness.tap("menu:vfs:claude-haiku-5-5");
  assert.equal(harness.settings.get("voiceFixModel"), "claude-haiku-5-5");
  assert.deepEqual(models, ["claude-opus-5"]);
  assert.deepEqual(answers(vf), ["voice fix: haiku 5.5"]);
  assert.equal(
    edit(vf)?.text,
    "🎤 Voice fix model\n\nCurrent: claude-haiku-5-5",
  );

  for (const stale of ["menu:ems", "menu:vfs:  "])
    assert.deepEqual(answers(await harness.tap(stale)), ["expired"], stale);
});

test("the entry-size screen marks the current preset, and the default applies when nothing is stored", async () => {
  const stored = edit(
    await (await withStored({ entryMaxChars: "560" })).tap("menu:esz"),
  );
  assert.deepEqual(labels(stored), [
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
    stored?.text.includes(
      "Entries longer than 560 characters are split into several journal lines.",
    ),
  );

  const off = edit(
    await (await withStored({ entryMaxChars: "0" })).tap("menu:esz"),
  );
  assert.ok(off?.text.includes("Splitting is off"));
  assert.deepEqual(labels(off)[4], ["✅ Don't split"]);

  const unset = edit(await (await botHarness()).tap("menu:esz"));
  assert.deepEqual(labels(unset)[1], ["✅ 280 chars"]);
});

test("an entry-size tap stores the number and redraws; a bad payload expires and writes nothing", async () => {
  const harness = await botHarness();
  const tapResult = await harness.tap("menu:ess:1000");
  assert.deepEqual(answers(tapResult), ["1000 chars"]);
  assert.equal(harness.settings.get("entryMaxChars"), "1000");
  assert.deepEqual(labels(edit(tapResult))[3], ["✅ 1000 chars"]);

  assert.deepEqual(answers(await harness.tap("menu:ess:0")), ["splitting off"]);
  assert.equal(harness.settings.get("entryMaxChars"), "0");
  for (const bad of ["menu:ess", "menu:ess:abc", "menu:ess:-5", "menu:ess:2.5"])
    assert.deepEqual(answers(await harness.tap(bad)), ["expired"], bad);
  assert.equal(harness.settings.get("entryMaxChars"), "0");
});

test("closing clears the menu's buttons when Telegram refuses to delete it", async () => {
  const harness = await botHarness();
  harness.failApi.add("deleteMessage");
  const stuck = edit(await harness.tap("menu:close"));
  assert.equal(stuck?.text, "🗂 Menu closed.");
  assert.deepEqual(buttons(stuck), []);
});

test("the failed list shows each failure with a retry button, and says so when none failed", async () => {
  const harness = await botHarness();
  harness.repo.failedJots = [
    sampleJot({ id: "f1", status: "failed", attempts: 3, error: "boom" }),
  ];
  const failedList = edit(await harness.tap("menu:failed"));
  assert.equal(failedList?.text, `⚠️ 1 failed:\nf1 [text] failed ×3 ${EM} boom`);
  assert.deepEqual(callbacks(failedList), ["rt:f1", "menu:root", "menu:close"]);
  assert.equal(
    edit(await (await botHarness()).tap("menu:failed"))?.text,
    "✅ nothing failed.",
  );
});

test("maintenance actions run their command and show the result over the maintenance menu", async () => {
  const harness = await botHarness();
  const screen = edit(await harness.tap("menu:maint"));
  assert.equal(screen?.text, "🛠 Maintenance");
  assert.deepEqual(labels(screen), [
    ["⚡ Flush", "🧹 Sweep"],
    ["🔧 Unstick", "🔄 Retry all"],
    ["‹ Back"],
    ["✖ Close"],
  ]);

  const flush = edit(await harness.tap("menu:flush"));
  assert.equal(flush?.text, "⚡ flushing (0 queued)");
  assert.ok(button(flush, "menu:retryall"));
  assert.equal(edit(await harness.tap("menu:sweep"))?.text, "🧹 sweep started");
  harness.repo.resetProcessing = 2;
  assert.equal(
    edit(await harness.tap("menu:unstick"))?.text,
    "🔧 unstuck 2 jots",
  );
});

test("retry-all asks for confirmation, then requeues failed and abandoned jots", async () => {
  const harness = await botHarness();
  const ask = edit(await harness.tap("menu:retryall"));
  assert.equal(ask?.text, "Requeue every failed jot?");
  assert.deepEqual(callbacks(ask).slice(0, 2), [
    "menu:retryally",
    "menu:maint",
  ]);

  harness.repo.resetFailed = 2;
  const done = await harness.tap("menu:retryally");
  assert.equal(edit(done)?.text, "🔄 requeued 2 jots (incl. abandoned)");
  assert.ok(done.events.includes("repo.resetFailed"));
});

test("the stats button offers a range picker, a range shows that window, and status shows the snapshot", async () => {
  const harness = await botHarness();
  const picker = edit(await harness.tap("menu:stats"));
  assert.equal(picker?.text, "📈 Stats range:");
  assert.deepEqual(callbacks(picker).slice(0, 3), [
    "menu:stats:today",
    "menu:stats:week",
    "menu:stats:all",
  ]);
  const week = edit(await harness.tap("menu:stats:week"));
  assert.ok(week?.text.startsWith("📊 last 7 days\n"));
  assert.deepEqual(callbacks(week), ["menu:stats", "menu:close"]);

  const status = edit(await harness.tap("menu:status"));
  assert.ok(status?.text.startsWith("🩺 scriba 0.0.0 (0123456)"));
  assert.deepEqual(callbacks(status), ["menu:root", "menu:close"]);
});

test("the link wizard answers through the menu namespace", async () => {
  const harness: Harness = await botHarness();
  assert.ok(
    edit(await harness.tap("menu:links"))?.text.startsWith("🔗 Link rules"),
  );
});

test("the jots browser lists recent jots, shows a detail card and handles a missing id", async () => {
  const jot = sampleJot({
    id: "abc12345",
    status: "failed",
    time: "10:00",
    raw_text: "hello  there",
    anchor: "abc12345",
    attempts: 3,
    error: "boom",
  });
  const harness = await botHarness();
  harness.repo.recentJots = [jot];
  harness.repo.getJot = async (id: string) => (id === jot.id ? jot : undefined);
  const list = edit(await harness.tap("menu:jots"));
  assert.equal(list?.text, "🗒 Recent jots:");
  assert.equal(button(list, "menu:jot:abc12345").text, "❌ 10:00 hello there");
  assert.deepEqual(callbacks(list).slice(1), ["menu:root", "menu:close"]);
  assert.equal(
    edit(await (await botHarness()).tap("menu:jots"))?.text,
    "No jots yet.",
  );

  const detail = edit(await harness.tap("menu:jot:abc12345"));
  assert.ok(detail?.text.startsWith(`🧾 abc12345 [text] ${EM} failed\n`));
  assert.ok(detail?.text.includes("Error: boom"));
  assert.deepEqual(callbacks(detail).slice(0, 4), [
    "menu:jr:abc12345",
    "menu:je:abc12345",
    "menu:jd:abc12345",
    "menu:jots",
  ]);
  const missing = edit(await harness.tap("menu:jot:nope"));
  assert.equal(missing?.text, "No jot nope.");
  assert.deepEqual(callbacks(missing), ["menu:jots", "menu:close"]);
});

test("the jot browser's retry, delete and edit buttons answer with their texts", async () => {
  const harness = await botHarness();
  const jot = sampleJot({
    id: "abc12345",
    anchor: "abc12345",
    status: "failed",
  });
  harness.repo.getJot = async (id: string) => (id === jot.id ? jot : undefined);
  const retry = await harness.tap("menu:jr:abc12345");
  assert.equal(edit(retry)?.text, "🔄 retrying abc12345…");
  assert.deepEqual(callbacks(edit(retry)), ["menu:jots", "menu:close"]);

  const confirm = edit(await harness.tap("menu:jd:abc12345"));
  assert.equal(
    confirm?.text,
    "Delete jot abc12345? This removes its line from the journal.",
  );
  assert.deepEqual(callbacks(confirm).slice(0, 2), [
    "menu:jdy:abc12345",
    "menu:jot:abc12345",
  ]);

  const del = await harness.tap("menu:jdy:abc12345");
  assert.equal(edit(del)?.text, "🗑️ removed that from your journal.");

  const prompt = await harness.tap("menu:je:abc12345");
  const sent = prompt.calls.find(
    (apiCall) => apiCall.method === "sendMessage",
  )?.payload;
  assert.equal(sent?.chat_id, OWNER);
  assert.deepEqual(sent?.reply_markup, { force_reply: true });
  assert.ok(sent?.text.includes("with your edit for abc12345"));

  const deleted = sampleJot({ id: "abc12345", status: "deleted" });
  harness.repo.getJot = async () => deleted;
  for (const data of ["menu:jr:abc12345", "menu:jdy:abc12345"])
    assert.deepEqual(answers(await harness.tap(data)), ["gone"], data);
});

test("retry from the browser refuses a jot being processed and leaves the queue alone", async () => {
  const harness = await botHarness();
  const jot = sampleJot({
    id: "abc12345",
    anchor: "abc12345",
    status: "processing",
  });
  harness.repo.getJot = async (id: string) => (id === jot.id ? jot : undefined);
  harness.repo.resetForRetry = false;
  const run = await harness.tap("menu:jr:abc12345");
  assert.equal(
    run.rendered,
    "repo.getJot > repo.resetForRetry > ack(still processing)",
  );
  assert.equal(edit(run), undefined);
});

test("delete from the browser on a jot still processing is queued and says so", async () => {
  const harness = await botHarness();
  const jot = sampleJot({
    id: "abc12345",
    anchor: "abc12345",
    status: "processing",
  });
  harness.repo.getJot = async (id: string) => (id === jot.id ? jot : undefined);
  const queued: [string, string][] = [];
  harness.repo.queueEdit = async (id: string, text: string) =>
    void queued.push([id, text]);
  const run = await harness.tap("menu:jdy:abc12345");
  assert.equal(
    run.rendered,
    "repo.getJot > repo.queueEdit > ack() > tg.editMessageText",
  );
  assert.deepEqual(queued, [["abc12345", "delete"]]);
  assert.equal(
    edit(run)?.text,
    `⏳ still processing ${EM} I'll remove it once it's done.`,
  );
  assert.deepEqual(callbacks(edit(run)), ["menu:jots", "menu:close"]);
});

test("retry and delete on a squashed follower act on its leader", async () => {
  const harness = await botHarness();
  const leader = sampleJot({ id: "leader01", anchor: "leader01" });
  const follower = sampleJot({ id: "follow01", anchor: "leader01" });
  const byId: Record<string, Jot> = { leader01: leader, follow01: follower };
  harness.repo.getJot = async (id: string) => byId[id];
  const reset: string[] = [];
  harness.repo.resetForRetry = async (id: string) => {
    reset.push(id);
    return true;
  };
  const queued: string[][] = [];
  harness.queue.add = (ids: string[]) => void queued.push(ids);
  const retry = await harness.tap("menu:jr:follow01");
  assert.deepEqual(answers(retry), ["retrying"]);
  assert.deepEqual(reset, ["leader01"]);
  assert.deepEqual(queued, [["leader01"]]);

  const marked: string[] = [];
  harness.repo.markDeleted = async (id: string) => void marked.push(id);
  harness.repo.groupFollowers = async (id: string) =>
    id === "leader01" ? [follower] : [];
  await harness.tap("menu:jdy:follow01");
  assert.deepEqual(marked, ["leader01", "follow01"]);
});

test("the menu habit review opens for the calendar day before, on the evening after a clock change", async () => {
  const savedZone = process.env.TZ;
  process.env.TZ = "Europe/Stockholm";
  mock.timers.enable({
    apis: ["Date"],
    now: new Date(2026, 9, 25, 23, 30).getTime(),
  });
  try {
    const harness = await botHarness();
    harness.obsidian.readDailyNote = {
      path: "p.md",
      content: "## Habits\n- [ ] Practiced music\n",
    };
    const run = await harness.tap("menu:habits");
    assert.deepEqual(run.texts("sendMessage"), [
      "🌱 Time to review habits for 2026-10-24 — 1 to go.",
    ]);
  } finally {
    mock.timers.reset();
    delete process.env.TZ;
    if (savedZone !== undefined) process.env.TZ = savedZone;
  }
});
