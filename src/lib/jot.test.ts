import assert from "node:assert/strict";
import { test } from "node:test";
import type { Jot } from "../db.ts";
import {
  assetEmbed,
  combineEnrichSource,
  donePreview,
  editedJotText,
  embedOffer,
  enrichableSource,
  isEditableJot,
  isRecoverable,
  makeJotId,
  parseLiteralEdit,
  reprocessTargets,
  setEmbeds,
  withinSquashWindow,
} from "./jot.ts";

test("withinSquashWindow: rolling gap folds jots within the window, splits past it", () => {
  assert.equal(withinSquashWindow(1000, 12000, 15000), true); // 11s apart ≤ 15s
  assert.equal(withinSquashWindow(1000, 16001, 15000), false); // 15.001s apart > 15s
  assert.equal(withinSquashWindow(1000, 16000, 15000), true); // exactly 15s
  assert.equal(withinSquashWindow(1000, 2000, 0), false); // window 0 disables
});

test("combineEnrichSource joins parts, dropping blanks", () => {
  assert.equal(
    combineEnrichSource(["first", "  ", "second", ""]),
    "first\nsecond",
  );
  assert.equal(combineEnrichSource([]), "");
  assert.equal(combineEnrichSource([" solo "]), "solo");
});

test("ids are fixed 8-char hex", () => {
  const id = makeJotId();
  assert.match(id, /^[0-9a-f]{8}$/);
});

test("editedJotText strips a re-typed TIL marker only for TIL jots", () => {
  assert.equal(
    editedJotText("til", "TIL: sqlite has WAL mode"),
    "sqlite has WAL mode",
  );
  assert.equal(
    editedJotText("til", "sqlite has WAL mode"),
    "sqlite has WAL mode",
  );
  assert.equal(editedJotText("til", "TIL"), "TIL");
  assert.equal(editedJotText("journal", "TIL: foo"), "TIL: foo");
});

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

test("isRecoverable flags transient infra errors, not terminal ones", () => {
  assert.equal(
    isRecoverable(new Error("connect ETIMEDOUT 10.0.0.1:443")),
    true,
  );
  assert.equal(
    isRecoverable(new Error("Request failed with status 503")),
    true,
  );
  assert.equal(isRecoverable(new Error("429 Too Many Requests")), true);
  assert.equal(isRecoverable(new Error("invalid path")), false);
});

test("isEditableJot is true only for done/abandoned (a line exists to edit)", () => {
  assert.equal(isEditableJot("done"), true);
  assert.equal(isEditableJot("abandoned"), true);
  assert.equal(isEditableJot("pending"), false);
  assert.equal(isEditableJot("processing"), false);
  assert.equal(isEditableJot("failed"), false);
  assert.equal(isEditableJot("deleted"), false);
});

const mediaJot = (over: Partial<Jot>): Jot => ({
  id: "deadbeef",
  kind: "image",
  note_path: "notes/x.md",
  anchor: "deadbeef",
  time: "10:00:00",
  raw_text: null,
  transcript: null,
  proposed_text: null,
  section: "journal",
  asset_path: null,
  file_id: null,
  status: "done",
  attempts: 0,
  error: null,
  received_at: 0,
  updated_at: 0,
  ...over,
});

test("an image's caption is enrichable entry text; video's is not", () => {
  // What you type alongside a photo is the jot itself, so it goes through enrichment.
  assert.equal(
    enrichableSource(mediaJot({ kind: "image", raw_text: "at the park" })),
    "at the park",
  );
  assert.equal(enrichableSource(mediaJot({ kind: "image" })), "");
  // Video stays attach-only: its caption is the embed's display text, not entry text.
  assert.equal(
    enrichableSource(mediaJot({ kind: "video", raw_text: "clip of the dog" })),
    "",
  );
  assert.equal(
    enrichableSource(mediaJot({ kind: "audio", transcript: "spoken" })),
    "spoken",
  );
  assert.equal(
    enrichableSource(mediaJot({ kind: "audio" }), "(failed)"),
    "(failed)",
  );
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

test("assetEmbed gives an image no alias and a video its caption", () => {
  // Telegram exposes no alt-text field, and the caption is already the entry text, so
  // an image embeds bare rather than repeating itself inside the link.
  assert.equal(
    assetEmbed(
      mediaJot({
        kind: "image",
        raw_text: "at the park",
        asset_path: "a/b.jpg",
      }),
    ),
    "![[a/b.jpg]]",
  );
  assert.equal(
    assetEmbed(
      mediaJot({ kind: "video", raw_text: "the dog", asset_path: "a/b.mp4" }),
    ),
    "![[a/b.mp4|the dog]]",
  );
  assert.equal(
    assetEmbed(mediaJot({ kind: "video", asset_path: "a/b.mp4" })),
    "![[a/b.mp4]]",
  );
  assert.equal(assetEmbed(mediaJot({ kind: "text", raw_text: "hi" })), "");
});

test("reprocessTargets dedupes to leader ids, preserving first-seen order", () => {
  assert.deepEqual(
    reprocessTargets([
      { anchor: "leader1" },
      { anchor: "leader1" }, // follower sharing leader1's anchor
      { anchor: "leader2" },
    ]),
    ["leader1", "leader2"],
  );
});

test("isRecoverable covers the OpenAI-shaped SDKs' network errors", () => {
  assert.equal(isRecoverable(new Error("Connection error.")), true);
  assert.equal(isRecoverable(new Error("Request timed out.")), true);
  assert.equal(
    isRecoverable(new Error("timeout after 15s (claude-haiku-4-5)")),
    true,
  );
});
