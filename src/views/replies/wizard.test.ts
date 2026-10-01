import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WIZARD_ENRICH_MODEL_REF,
  WIZARD_ENTRYSIZE_REF,
  WIZARD_RATING_TIME_REF,
  WIZARD_VOICEFIX_MODEL_REF,
} from "../../core.ts";
import {
  botHarness,
  EM,
  type Harness,
  type Run,
} from "../../test/bot-harness.ts";
import { parseSettingsRef } from "./wizard.ts";

const TIME = `when? ${WIZARD_RATING_TIME_REF}`;
const SIZE = `how long? ${WIZARD_ENTRYSIZE_REF}`;
const ENRICH = `which model? ${WIZARD_ENRICH_MODEL_REF}`;
const VOICE_FIX = `which model? ${WIZARD_VOICEFIX_MODEL_REF}`;

const answer = (h: Harness, prompt: string, body: string) =>
  h.say(body, { message_id: 7, text: prompt });

const sent = (run: Run) => run.calls.find((c) => c.method === "sendMessage");
const buttons = (run: Run): string[] =>
  (sent(run)?.payload.reply_markup?.inline_keyboard ?? [])
    .flat()
    .map((b: { callback_data: string }) => b.callback_data);

test("the settings prompts are claimed by their marker; the link wizard's are not", () => {
  assert.equal(parseSettingsRef(TIME), "rt");
  assert.equal(parseSettingsRef(SIZE), "es");
  assert.equal(parseSettingsRef(ENRICH), "em");
  assert.equal(parseSettingsRef(VOICE_FIX), "vfm");
  assert.equal(parseSettingsRef("add words (lw:sw)"), null);
  assert.equal(parseSettingsRef("just a message"), null);
});

test("a typed time is stored, re-arms the nightly job, and is confirmed with a menu button", async () => {
  const h = await botHarness();
  const run = await answer(h, TIME, "23:30");
  assert.equal(
    run.rendered,
    "repo.setSetting > scheduler.rearm > tg.sendMessage",
  );
  assert.equal(h.settings.get("ratingTime"), "23:30");
  assert.equal(sent(run)?.payload.text, "🕛 nightly rating at 23:30");
  assert.deepEqual(buttons(run), ["menu:root", "menu:close"]);
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
    const h = await botHarness();
    await answer(h, TIME, body!);
    assert.equal(h.settings.get("ratingTime"), stored, body);
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
    const h = await botHarness();
    const run = await answer(h, TIME, body);
    assert.deepEqual(
      run.texts("sendMessage"),
      ["That isn't a time. Use HH:MM in 24-hour time, like 23:30 or 00:00."],
      JSON.stringify(body.slice(0, 20)),
    );
    assert.equal(h.settings.has("ratingTime"), false);
    assert.ok(!run.events.includes("scheduler.rearm"));
  }
});

test("a typed entry size is validated, and 'off' stops splitting", async () => {
  const h = await botHarness();
  const on = await answer(h, SIZE, "500");
  assert.equal(h.settings.get("entryMaxChars"), "500");
  assert.equal(sent(on)?.payload.text, "✂️ entries split above 500 characters");
  assert.deepEqual(buttons(on), ["menu:esz", "menu:close"]);

  const off = await answer(h, SIZE, "off");
  assert.equal(h.settings.get("entryMaxChars"), "0");
  assert.equal(
    sent(off)?.payload.text,
    `✂️ splitting off ${EM} entries stay on one line`,
  );

  for (const bad of ["39", "4001", "lots", "", " "]) {
    const run = await answer(h, SIZE, bad);
    assert.deepEqual(
      run.texts("sendMessage"),
      ['Give me a whole number between 40 and 4000, or "off".'],
      bad,
    );
  }
  assert.equal(h.settings.get("entryMaxChars"), "0");
});

test("a typed model id is trimmed and stored, and only the enrichment model reaches the enricher", async () => {
  const h = await botHarness();
  const models: string[] = [];
  h.enricher.setModel = (m: string) => void models.push(m);

  const em = await answer(h, ENRICH, " claude-sonnet-5-20260101 ");
  assert.equal(h.settings.get("enrichModel"), "claude-sonnet-5-20260101");
  assert.deepEqual(models, ["claude-sonnet-5-20260101"]);
  assert.equal(
    sent(em)?.payload.text,
    "🧠 enrichment model: claude-sonnet-5-20260101",
  );
  assert.deepEqual(buttons(em), ["menu:em", "menu:close"]);

  const vf = await answer(h, VOICE_FIX, "claude-haiku-4-5");
  assert.equal(h.settings.get("voiceFixModel"), "claude-haiku-4-5");
  assert.deepEqual(models, ["claude-sonnet-5-20260101"]);
  assert.equal(sent(vf)?.payload.text, "🧠 voice fix model: claude-haiku-4-5");
  assert.deepEqual(buttons(vf), ["menu:vfm", "menu:close"]);

  const empty = await answer(h, ENRICH, "  ");
  assert.deepEqual(empty.texts("sendMessage"), [
    "Send a model ID (e.g. claude-sonnet-5).",
  ]);
  assert.equal(h.settings.get("enrichModel"), "claude-sonnet-5-20260101");
});
