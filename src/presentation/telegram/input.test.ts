import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "grammy/types";
import { editInput, entitiesToMarkdown, intakeInput } from "./input.ts";

const message = (extra: object): Message =>
  ({
    message_id: 77,
    date: 1_700_000_000,
    chat: { id: 1, type: "private", first_name: "me" },
    ...extra,
  }) as Message;

const bold = { type: "bold", offset: 0, length: 3 } as const;

test("intake input per message kind: text and captions as markdown, voice and video notes with no text", () => {
  const cases: [string, object, object | undefined][] = [
    [
      "text",
      { text: "hey there", entities: [bold] },
      { kind: "text", rawText: "**hey** there" },
    ],
    [
      "voice",
      { voice: { file_id: "v1", file_unique_id: "u", duration: 2 } },
      { kind: "audio", rawText: null, fileId: "v1" },
    ],
    [
      "audio",
      { audio: { file_id: "a1", file_unique_id: "u", duration: 2 } },
      { kind: "audio", rawText: null, fileId: "a1" },
    ],
    [
      "photo with a caption",
      {
        photo: [
          { file_id: "small", file_unique_id: "u", width: 1, height: 1 },
          { file_id: "big", file_unique_id: "u", width: 2, height: 2 },
        ],
        caption: "cat nap",
        caption_entities: [bold],
      },
      { kind: "image", rawText: "**cat** nap", fileId: "big" },
    ],
    [
      "captionless photo",
      { photo: [{ file_id: "p1", file_unique_id: "u", width: 1, height: 1 }] },
      { kind: "image", rawText: "", fileId: "p1" },
    ],
    [
      "video with a caption",
      {
        video: { file_id: "vd", file_unique_id: "u", width: 1, height: 1 },
        caption: "clip",
      },
      { kind: "video", rawText: "clip", fileId: "vd" },
    ],
    [
      "captionless video",
      { video: { file_id: "vd", file_unique_id: "u", width: 1, height: 1 } },
      { kind: "video", rawText: "", fileId: "vd" },
    ],
    [
      "video note",
      { video_note: { file_id: "vn", file_unique_id: "u", length: 1 } },
      { kind: "video", rawText: null, fileId: "vn" },
    ],
    ["sticker", { sticker: { file_id: "s", file_unique_id: "u" } }, undefined],
  ];
  for (const [name, extra, expected] of cases) {
    const input = intakeInput(message(extra));
    assert.deepEqual(
      input,
      expected && { messageId: 77, sentAt: 1_700_000_000_000, ...expected },
      name,
    );
  }
});

test("edit input takes the new text or caption as markdown, and a removed caption as empty", () => {
  assert.deepEqual(editInput(message({ text: "new text", entities: [bold] })), {
    messageId: 77,
    text: "**new** text",
  });
  assert.deepEqual(
    editInput(
      message({
        photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }],
        caption: "new caption",
        caption_entities: [bold],
      }),
    ),
    { messageId: 77, text: "**new** caption" },
  );
  assert.deepEqual(
    editInput(
      message({
        photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }],
      }),
    ),
    { messageId: 77, text: "" },
  );
});

test("entitiesToMarkdown returns text unchanged when entities is undefined", () => {
  assert.equal(entitiesToMarkdown("hello world", undefined), "hello world");
});
test("entitiesToMarkdown returns text unchanged when entities is empty", () => {
  assert.equal(entitiesToMarkdown("hello world", []), "hello world");
});
test("entitiesToMarkdown wraps bold in **", () => {
  assert.equal(
    entitiesToMarkdown("hello world", [{ type: "bold", offset: 6, length: 5 }]),
    "hello **world**",
  );
});
test("entitiesToMarkdown wraps italic in _", () => {
  assert.equal(
    entitiesToMarkdown("hello world", [
      { type: "italic", offset: 6, length: 5 },
    ]),
    "hello _world_",
  );
});
test("entitiesToMarkdown wraps code in backticks", () => {
  assert.equal(
    entitiesToMarkdown("I added things to internal", [
      { type: "code", offset: 18, length: 8 },
    ]),
    "I added things to `internal`",
  );
});
test("entitiesToMarkdown wraps strike in ~~", () => {
  assert.equal(
    entitiesToMarkdown("hello world", [
      { type: "strikethrough", offset: 6, length: 5 },
    ]),
    "hello ~~world~~",
  );
});
test("entitiesToMarkdown wraps spoiler in ||", () => {
  assert.equal(
    entitiesToMarkdown("hello world", [
      { type: "spoiler", offset: 6, length: 5 },
    ]),
    "hello ||world||",
  );
});
test("entitiesToMarkdown wraps underline in __", () => {
  assert.equal(
    entitiesToMarkdown("hello world", [
      { type: "underline", offset: 6, length: 5 },
    ]),
    "hello __world__",
  );
});
test("entitiesToMarkdown wraps text_link in Markdown link", () => {
  assert.equal(
    entitiesToMarkdown("hello example", [
      { type: "text_link", offset: 6, length: 7, url: "https://example.com" },
    ]),
    "hello [example](https://example.com)",
  );
});
test("entitiesToMarkdown wraps pre with language", () => {
  assert.equal(
    entitiesToMarkdown("hello world", [
      { type: "pre", offset: 6, length: 5, language: "ts" },
    ]),
    "hello ```ts\nworld\n```",
  );
});
test("entitiesToMarkdown wraps pre without language", () => {
  assert.equal(
    entitiesToMarkdown("hello world", [{ type: "pre", offset: 6, length: 5 }]),
    "hello ```\nworld\n```",
  );
});
test("entitiesToMarkdown handles multiple entities sorted by offset", () => {
  const text = "abcboldandcode";
  assert.equal(
    entitiesToMarkdown(text, [
      { type: "code", offset: 10, length: 4 },
      { type: "bold", offset: 3, length: 4 },
    ]),
    "abc**bold**and`code`",
  );
});
test("entitiesToMarkdown skips nested entities instead of duplicating text", () => {
  // bold spanning the whole string with a link nested inside it: keep the
  // outer formatting, drop the inner one, never re-emit the covered text.
  assert.equal(
    entitiesToMarkdown("hello world", [
      { type: "bold", offset: 0, length: 11 },
      { type: "text_link", offset: 0, length: 5, url: "https://x.com" },
    ]),
    "**hello world**",
  );
});
test("entitiesToMarkdown preserves text before the first entity and after the last", () => {
  assert.equal(
    entitiesToMarkdown("before code after", [
      { type: "code", offset: 7, length: 4 },
    ]),
    "before `code` after",
  );
});
