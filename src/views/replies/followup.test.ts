import assert from "node:assert/strict";
import { test } from "node:test";
import { followupRef } from "../../controllers/rating.ts";
import type { Jot } from "../../domain/jot/entity.ts";
import { parseHabitRef } from "../../libs/habits.ts";
import { parseWizardRef } from "../../libs/wizard.ts";
import { botHarness, NOW } from "../../test/bot-harness.ts";
import { parseFollowupRef } from "./followup.ts";

const chat = { id: 1, type: "private" as const };
const from = { id: 1, is_bot: false, first_name: "me" };

test("followupRef round-trips through parseFollowupRef", () => {
  for (const q of ["journal", "til"] as const) {
    const text = `Learned anything today? Reply to this message.\n${followupRef(q, "2026-07-05")}`;
    assert.deepEqual(parseFollowupRef(text), {
      question: q,
      date: "2026-07-05",
    });
  }
  assert.equal(parseFollowupRef("(fu:x:2026-07-05)"), null);
  assert.equal(parseFollowupRef("(hb:2026-07-05:1)"), null);
});

test("a follow-up marker is not read by the other flows' parsers, nor theirs by it", () => {
  const prompt = `question ${followupRef("journal", "2026-07-05")}`;
  assert.equal(parseHabitRef(prompt), null);
  assert.equal(parseWizardRef(prompt), null);
  for (const other of [
    "(hb:2026-07-05:1)",
    "(rt:time)",
    "(lw:sw)",
    "(tk:d:abcdef12)",
  ])
    assert.equal(parseFollowupRef(other), null, other);
});

test("a reply's formatting is kept and its surrounding whitespace trimmed", async () => {
  for (const [marker, section] of [
    ["(fu:j:2026-08-15)", "journal"],
    ["(fu:t:2026-08-15)", "til"],
  ] as const) {
    const h = await botHarness();
    const rows: Jot[] = [];
    h.repo.insertJot = (row: Jot) => void rows.push(row);
    await h.run({
      message: {
        message_id: 200,
        date: NOW / 1000,
        chat,
        from,
        text: "  hello world  ",
        entities: [{ type: "bold", offset: 8, length: 5 }],
        reply_to_message: {
          message_id: 7,
          date: 0,
          chat,
          text: `a question\n${marker}`,
        },
      },
    });
    assert.equal(rows[0]?.raw_text, "hello **world**", marker);
    assert.equal(rows[0]?.section, section, marker);
    assert.equal(rows[0]?.note_path, "notes/daily notes/2026-08-15.md", marker);
  }
});
