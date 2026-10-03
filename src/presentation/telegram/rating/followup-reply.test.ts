import assert from "node:assert/strict";
import { test } from "node:test";
import type { Jot } from "../../../domain/jot/entity.ts";
import { botHarness, NOW } from "../../../test/bot-harness.ts";

const chat = { id: 1, type: "private" as const };
const from = { id: 1, is_bot: false, first_name: "me" };

test("a reply's formatting is kept and its surrounding whitespace trimmed", async () => {
  for (const [marker, section] of [
    ["(fu:j:2026-08-15)", "journal"],
    ["(fu:t:2026-08-15)", "til"],
  ] as const) {
    const harness = await botHarness();
    const rows: Jot[] = [];
    harness.repo.insertJot = (row: Jot) => void rows.push(row);
    await harness.run({
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
