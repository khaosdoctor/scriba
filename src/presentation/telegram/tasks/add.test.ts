import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness } from "../../../test/bot-harness.ts";

test("/taskadd reads the line through the enricher and shows the card", async () => {
  const h = await botHarness();
  h.enricher.extractTask = () => ({
    description: "Renew the passport",
    due: "next friday",
    type: "personal",
  });
  const run = await h.say("/taskadd renew the passport by next friday");
  assert.equal(
    run.rendered,
    "enricher.extractTask > repo.insertTaskDraft > tg.sendMessage > repo.updateTaskDraft",
  );
  assert.match(run.texts("sendMessage")[0] ?? "", /Renew the passport/);
});

test("/taskadd with a line that holds no task says how to phrase one", async () => {
  const h = await botHarness();
  h.enricher.extractTask = () => ({ description: " ", type: "personal" });
  const run = await h.say("/taskadd ???");
  assert.deepEqual(run.texts("sendMessage"), [
    "I couldn't find anything to do in that — try “/taskadd buy cat sand next week”.",
  ]);
});
