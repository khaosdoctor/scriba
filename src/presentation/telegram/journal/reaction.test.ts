import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness, JOT_ID, sampleJot } from "../../../test/bot-harness.ts";

test("a 🤝 reaction on a squashed follower pulls it back out; any other emoji is ignored", async () => {
  const harness = await botHarness();
  harness.repo.jotForMessage = "bbbbbbbb";
  harness.repo.getJot = sampleJot({
    id: "bbbbbbbb",
    anchor: JOT_ID,
    status: "pending",
  });
  harness.repo.unsquash = true;
  const other = await harness.reaction(["👍"]);
  assert.equal(other.rendered, "");
  const optOut = await harness.reaction(["🤝"]);
  assert.equal(
    optOut.rendered,
    "repo.jotForMessage > repo.getJot > repo.unsquash > obsidian.ensureDailyNote > obsidian.appendJournalLine > tg.setMessageReaction",
  );
  assert.equal(
    optOut.calls.find((call) => call.method === "setMessageReaction")?.payload
      .message_id,
    77,
  );
});
