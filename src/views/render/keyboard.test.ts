import assert from "node:assert/strict";
import { test } from "node:test";
import { InlineKeyboard } from "grammy";
import {
  backTo,
  navRow,
  pagedScreen,
  paginate,
  withClose,
} from "./keyboard.ts";

const rows = (kb: InlineKeyboard) =>
  kb.inline_keyboard
    .filter((r) => r.length > 0)
    .map((r) =>
      r.map((b) => ("callback_data" in b ? b.callback_data : b.text)),
    );

test("withClose appends Close after the last real row and drops empty rows", () => {
  const kb = new InlineKeyboard().text("a", "a").row().row();
  const closed = withClose(kb, "x:close");
  assert.equal(closed.inline_keyboard.length, 2);
  assert.deepEqual(rows(closed), [["a"], ["x:close"]]);
});

test("backTo is a Back button over Close", () => {
  assert.deepEqual(rows(backTo("x:root", "x:close")), [
    ["x:root"],
    ["x:close"],
  ]);
});

test("paginate clamps a page past either end to the nearest real page", () => {
  const items = [1, 2, 3, 4, 5];
  assert.deepEqual(paginate(items, 99, 2), {
    items: [5],
    page: 2,
    pages: 3,
    offset: 4,
  });
  assert.equal(paginate(items, -4, 2).page, 0);
});

test("paginate of an empty list is one empty page", () => {
  assert.deepEqual(paginate([], 3, 8), {
    items: [],
    page: 0,
    pages: 1,
    offset: 0,
  });
});

test("navRow adds Prev and Next only where a page exists, and nothing for one page", () => {
  const cb = (p: number) => `n:${p}`;
  assert.deepEqual(rows(navRow(new InlineKeyboard(), 0, 1, cb)), []);
  assert.deepEqual(rows(navRow(new InlineKeyboard(), 0, 3, cb)), [["n:1"]]);
  assert.deepEqual(rows(navRow(new InlineKeyboard(), 1, 3, cb)), [
    ["n:0", "n:2"],
  ]);
  assert.deepEqual(rows(navRow(new InlineKeyboard(), 2, 3, cb)), [["n:1"]]);
});

test("pagedScreen builds item rows with global indices, then nav, extra rows and Back", () => {
  const screen = pagedScreen({
    view: paginate(["a", "b", "c"], 1, 2),
    title: (v) => `page ${v.page + 1}/${v.pages}`,
    row: (kb, item, i) => kb.text(item, `pick:${i}`),
    nav: (p) => `go:${p}`,
    extraRows: (kb) => kb.text("more", "more"),
    back: { text: "Back", data: "root" },
  });
  assert.equal(screen.text, "page 2/2");
  assert.deepEqual(rows(screen.kb), [["pick:2"], ["go:0"], ["more", "root"]]);
});

test("pagedScreen appends to a keyboard the caller started", () => {
  const screen = pagedScreen({
    kb: new InlineKeyboard().text("Add", "add").row(),
    view: paginate(["a"], 0, 8),
    title: () => "t",
    row: (kb, item, i) => kb.text(item, `pick:${i}`),
  });
  assert.deepEqual(rows(screen.kb), [["add"], ["pick:0"]]);
});
