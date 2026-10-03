import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness, sampleDraft } from "../../../test/bot-harness.ts";
import { parseTaskRef } from "./reply.ts";

const DRAFT = sampleDraft({ due: null });
const DUE_PROMPT =
  "🏁 Reply to this message with the due date. (tk:u:d1d1d1d1)";
const ADD_PROMPT = "📝 Reply to this message with the task. (tk:add)";

const answer = async (text: string, draft: object | null = DRAFT) => {
  const harness = await botHarness();
  harness.repo.getTaskDraft = draft;
  return harness.say(text, { message_id: 7, text: DUE_PROMPT });
};

test("a prompt is recognized by its marker, and an ordinary message is not", () => {
  assert.deepEqual(parseTaskRef(DUE_PROMPT), { field: "u", id: "d1d1d1d1" });
  assert.deepEqual(parseTaskRef("(tk:d:0123456789abcdef)"), {
    field: "d",
    id: "0123456789abcdef",
  });
  assert.deepEqual(parseTaskRef(ADD_PROMPT), { field: "add" });
  assert.equal(parseTaskRef("(tk:u:xyz)"), null);
  assert.equal(parseTaskRef("just a message"), null);
});

test("a date that can be read is saved, the question leaves the chat and the card is redrawn", async () => {
  const run = await answer("2026-09-15");
  assert.equal(
    run.rendered,
    "repo.getTaskDraft > repo.updateTaskDraft > tg.deleteMessage > tg.editMessageText",
  );
  assert.equal(
    run.calls.find((call) => call.method === "deleteMessage")?.payload
      .message_id,
    7,
  );
  assert.match(run.texts("editMessageText")[0] ?? "", /Due: 2026-09-15/);
});

test("a date that cannot be read is refused and the question stays on screen", async () => {
  const run = await answer("banana");
  assert.deepEqual(run.texts("sendMessage"), [
    'I couldn\'t read that as a date. Try "next friday", "in two weeks", or 2026-09-15.',
  ]);
  assert.equal(run.rendered, "repo.getTaskDraft > tg.sendMessage");
});

test("the deadline cannot be cleared", async () => {
  const run = await answer("none");
  assert.deepEqual(run.texts("sendMessage"), [
    "A task needs a deadline — give me a date for this one.",
  ]);
});

test("an answer for a card that is already settled gets a plain reply", async () => {
  assert.deepEqual(
    (await answer("2026-09-15", { ...DRAFT, status: "created" })).texts(
      "sendMessage",
    ),
    ["That task is already settled."],
  );
  assert.deepEqual((await answer("2026-09-15", null)).texts("sendMessage"), [
    "That task is already settled.",
  ]);
});

test("the reply to a bare /taskadd is read as the task and its question leaves the chat", async () => {
  const harness = await botHarness();
  harness.enricher.extractTask = () => ({
    description: "Renew the passport",
    due: "next friday",
    type: "personal",
  });
  const run = await harness.say("renew the passport next friday", {
    message_id: 7,
    text: ADD_PROMPT,
  });
  assert.equal(
    run.rendered,
    "tg.deleteMessage > enricher.extractTask > repo.insertTaskDraft > tg.sendMessage > repo.updateTaskDraft",
  );
  assert.match(run.texts("sendMessage")[0] ?? "", /Renew the passport/);
});

test("a blank reply to a bare /taskadd asks again, and one with no task in it says how to phrase it", async () => {
  const harness = await botHarness();
  assert.deepEqual(
    (await harness.say(" ", { message_id: 7, text: ADD_PROMPT })).texts(
      "sendMessage",
    ),
    ["Send the task and I'll read it."],
  );
  harness.enricher.extractTask = () => ({ description: " ", type: "personal" });
  assert.match(
    (await harness.say("???", { message_id: 7, text: ADD_PROMPT })).texts(
      "sendMessage",
    )[0] ?? "",
    /try “\/taskadd buy cat sand next week”/,
  );
});
