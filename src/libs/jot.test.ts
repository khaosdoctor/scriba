import assert from "node:assert/strict";
import { test } from "node:test";
import type { Jot } from "../domain/jot/entity.ts";
import {
  doneMessage,
  donePreview,
  editConfirmation,
  editRef,
  embedOffer,
  formatJotDetail,
  gaveUpMessage,
  jotPreview,
  originalQuote,
  parseEditRef,
  parseLiteralEdit,
  retryNotice,
  setEmbeds,
  statusKeyboard,
} from "./jot.ts";
import { TELEGRAM_LIMIT } from "./text.ts";

test("literal edit parser handles sed and natural forms, rejects freeform", () => {
  assert.deepEqual(parseLiteralEdit("s/pot/potentiometer/"), {
    old: "pot",
    new: "potentiometer",
  });
  assert.deepEqual(parseLiteralEdit("replace pot with potentiometer"), {
    old: "pot",
    new: "potentiometer",
  });
  assert.deepEqual(parseLiteralEdit('replace "the cat" with "the dog"'), {
    old: "the cat",
    new: "the dog",
  });
  assert.equal(parseLiteralEdit("make this clearer"), null);
});

test("donePreview shows enriched text in full, labels attach-only", () => {
  assert.equal(donePreview("text", "  went for a run  "), "went for a run");
  assert.equal(donePreview("audio", "x".repeat(250)), "x".repeat(250));
  assert.equal(donePreview("image", ""), "image saved to the note");
  assert.equal(donePreview("video", "  "), "video saved to the note");
  assert.equal(donePreview("text", ""), "saved");
});

test("embedOffer asks to embed, then offers plain once embedded", () => {
  const yt = "https://youtu.be/abc";
  assert.equal(embedOffer("just text"), undefined);
  assert.equal(embedOffer("read https://example.com/post"), undefined);
  assert.equal(embedOffer(`watch ${yt}`), "embed");
  assert.equal(embedOffer(`watch [this](${yt})`), "embed");
  assert.equal(embedOffer(`watch ![](${yt})`), "plain");
  // One still linked is enough to offer embedding the rest.
  assert.equal(embedOffer(`![](${yt}) and ${yt}`), "embed");
});

test("setEmbeds round-trips bare and labelled links", () => {
  const yt = "https://www.youtube.com/watch?v=abc&t=10";
  const line = `saw ${yt}. also [cat](https://e.com/c.png) and https://e.com/page, [[Note]]`;
  const embedded = setEmbeds(line, true);
  assert.equal(
    embedded,
    `saw ![](${yt}). also ![cat](https://e.com/c.png) and https://e.com/page, [[Note]]`,
  );
  assert.equal(setEmbeds(embedded, true), embedded);
  assert.equal(setEmbeds(embedded, false), line);
});

test("the status keyboard carries one button per asked action, and clears them when none is", () => {
  const buttons = (opts?: Parameters<typeof statusKeyboard>[1]) =>
    statusKeyboard("a1b2c3d4", opts).inline_keyboard.flat();
  assert.deepEqual(buttons(), []);
  assert.deepEqual(buttons({ retry: true, discard: true }), [
    { text: "🔄 Retry", callback_data: "rt:a1b2c3d4" },
    { text: "🗑 Delete", callback_data: "dl:a1b2c3d4" },
  ]);
  assert.deepEqual(buttons({ undo: true, embed: "embed" }), [
    { text: "✏️ Edit", callback_data: "ed:a1b2c3d4" },
    { text: "↩️ Undo", callback_data: "un:a1b2c3d4" },
    { text: "🖼 Embed", callback_data: "em:a1b2c3d4:1" },
  ]);
  assert.deepEqual(buttons({ embed: "plain" }), [
    { text: "🔗 Plain link", callback_data: "em:a1b2c3d4:0" },
  ]);
  assert.deepEqual(buttons({ undo: true, original: true }), [
    { text: "✏️ Edit", callback_data: "ed:a1b2c3d4" },
    { text: "↩️ Undo", callback_data: "un:a1b2c3d4" },
    { text: "📝 Use original", callback_data: "vf:a1b2c3d4" },
  ]);
});

test("originalQuote folds the raw transcript away, escaped and capped", () => {
  assert.equal(
    originalQuote("if a < b"),
    "\n🎤 Original transcript:\n<blockquote expandable>if a &lt; b</blockquote>",
  );
  const long = originalQuote("word ".repeat(1000));
  assert.ok(long.length < 1600);
  assert.ok(long.endsWith("…</blockquote>"));
});

test("doneMessage marks which piece a split jot is", () => {
  const one = doneMessage("10:00:00", "text", "hi", "a1b2c3d4");
  assert.ok(!one.includes("part"));
  const piece = doneMessage("10:00:00", "text", "hi", "a1b2c3d4", 0, {
    i: 2,
    of: 3,
  });
  assert.ok(piece.includes("✂️ part 2 of 3"));
});

test("doneMessage blockquotes the time and escapes content", () => {
  assert.equal(
    doneMessage("14:32:00", "text", "ran <5k> today", "a1b2c3d4"),
    "✅ Saved to your journal\n<blockquote>🕒 14:32:00 · ran &lt;5k&gt; today</blockquote>\n🔖 <code>a1b2c3d4</code>",
  );
});

test("doneMessage notes a squash only when more than one jot merged", () => {
  // 0/1 = no merge, no extra line; 2+ appends the squash count.
  assert.ok(!doneMessage("14:32:00", "text", "x", "a1b2c3d4").includes("🧵"));
  assert.ok(
    !doneMessage("14:32:00", "text", "x", "a1b2c3d4", 1).includes("🧵"),
  );
  assert.match(
    doneMessage("14:32:00", "text", "x", "a1b2c3d4", 3),
    /🧵 3 jots squashed into one entry$/,
  );
});

test("editConfirmation blockquotes the time and escapes content", () => {
  assert.equal(
    editConfirmation("14:32:00", "ran <5k> today"),
    "✏️ Updated\n<blockquote>🕒 14:32:00 · ran &lt;5k&gt; today</blockquote>",
  );
});

test("editConfirmation falls back to an ellipsis for a blank result (e.g. a delete)", () => {
  assert.equal(
    editConfirmation("14:32:00", "   "),
    "✏️ Updated\n<blockquote>🕒 14:32:00 · …</blockquote>",
  );
});

test("retryNotice says where in the retry cycle a jot is", () => {
  const out = retryNotice("audio", 2, 10, "fetch failed");
  assert.match(out, /That audio jot didn't go through \(attempt 2 of 10\)/);
  assert.match(out, /8 more tries left/);
  assert.match(out, /<code>fetch failed<\/code>/);
  // The last try before giving up reads as one, not "1 more tries".
  assert.match(retryNotice("text", 9, 10, "boom"), /one more try left/);
});

test("gaveUpMessage names the reason and the burst it covers", () => {
  const out = gaveUpMessage("text", "unrecoverable error", "bad json");
  assert.match(out, /Gave up on a text jot \(unrecoverable error\)/);
  assert.match(out, /Posted it un-enriched/);
  assert.ok(!out.includes("squashed"));
  assert.match(
    gaveUpMessage("audio", "no luck after 10 tries", "boom", 3),
    /🧵 3 jots squashed into one entry/,
  );
});

test("a failure message escapes and caps the error it quotes", () => {
  // An error is arbitrary text: it must not be able to inject markup…
  assert.match(
    retryNotice("text", 1, 10, "<b>nope</b> & co"),
    /&lt;b&gt;nope&lt;\/b&gt; &amp; co/,
  );
  // …nor push the message past Telegram's limit with a whole stack trace.
  const huge = gaveUpMessage("text", "unrecoverable error", "x".repeat(5000));
  assert.ok(huge.length < TELEGRAM_LIMIT);
  assert.match(huge, /x…<\/code>/);
  assert.match(retryNotice("text", 1, 10, "   "), /no error message/);
});

test("formatJotDetail shows full text and includes errors", () => {
  const jot: Jot = {
    id: "deadbeef",
    kind: "audio",
    note_path: "notes/x.md",
    anchor: "deadbeef",
    time: "10:00:00",
    raw_text: null,
    transcript: "x".repeat(400),
    original_transcript: null,
    parent_id: null,
    section: "journal",
    asset_path: null,
    file_id: null,
    status: "failed",
    attempts: 3,
    error: "boom",
    received_at: Date.now(),
    updated_at: Date.now(),
  };
  const out = formatJotDetail(jot);
  assert.match(out, /deadbeef \[audio\] — failed/);
  assert.match(out, /Attempts: 3/);
  assert.match(out, /Error: boom/);
  assert.ok(out.includes(`Text: ${"x".repeat(400)}`)); // transcript shown in full
});

test("jotPreview falls back to (kind) for a captionless attach-only jot", () => {
  const base = {
    id: "aaaaaaaa",
    kind: "image" as const,
    note_path: "x.md",
    anchor: "aaaaaaaa",
    time: "10:00:00",
    raw_text: null,
    transcript: null,
    original_transcript: null,
    parent_id: null,
    section: "journal" as const,
    asset_path: null,
    file_id: null,
    status: "done" as const,
    attempts: 0,
    error: null,
    received_at: 0,
    updated_at: 0,
  };
  assert.equal(jotPreview(base), "(image)");
  assert.equal(
    jotPreview({ ...base, raw_text: "a  sunset\nphoto" }),
    "a sunset photo",
  );
  assert.equal(
    jotPreview({ ...base, kind: "audio", transcript: "hello there" }, 5),
    "hello",
  );
});

test("an edit ref round-trips a jot id and ignores anything else", () => {
  assert.equal(editRef("a1b2c3d4"), "(ed:a1b2c3d4)");
  assert.equal(
    parseEditRef(`✏️ Reply…\nsome text\n${editRef("a1b2c3d4")}`),
    "a1b2c3d4",
  );
  assert.equal(parseEditRef("(ed:nothex!!)"), null);
  assert.equal(parseEditRef("(fu:j:2026-10-10)"), null);
});
