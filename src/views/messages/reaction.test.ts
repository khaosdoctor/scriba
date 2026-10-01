import assert from "node:assert/strict";
import { test } from "node:test";
import { botHarness, JOT_ID, sampleJot } from "../../test/bot-harness.ts";

test("a 🤝 reaction on a squashed follower pulls it back out; any other emoji is ignored", async () => {
  const h = await botHarness();
  h.repo.jotForMessage = "bbbbbbbb";
  h.repo.getJot = sampleJot({
    id: "bbbbbbbb",
    anchor: JOT_ID,
    status: "pending",
  });
  h.repo.unsquash = true;
  const other = await h.reaction(["👍"]);
  assert.equal(other.rendered, "");
  const optOut = await h.reaction(["🤝"]);
  assert.equal(
    optOut.rendered,
    "repo.jotForMessage > repo.getJot > repo.unsquash > obsidian.ensureDailyNote > obsidian.appendJournalLine > tg.setMessageReaction",
  );
  assert.equal(
    optOut.calls.find((c) => c.method === "setMessageReaction")?.payload
      .message_id,
    77,
  );
});
