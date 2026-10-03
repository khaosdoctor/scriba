import assert from "node:assert/strict";
import { test } from "node:test";
import { InlineKeyboard } from "grammy";
import { paginate } from "../../libs/page.ts";
import {
  backTo,
  navRow,
  pagedScreen,
  pageSuffix,
  withClose,
} from "./keyboard.ts";

const rows = (kb: InlineKeyboard) =>
  kb.inline_keyboard
    .filter((row) => row.length > 0)
    .map((row) =>
      row.map((button) =>
        "callback_data" in button ? button.callback_data : button.text,
      ),
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

test("navRow adds Prev and Next only where a page exists, and nothing for one page", () => {
  const cb = (page: number) => `n:${page}`;
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
    title: (view) => `page ${view.page + 1}/${view.pages}`,
    row: (kb, item, index) => kb.text(item, `pick:${index}`),
    nav: (page) => `go:${page}`,
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
    row: (kb, item, index) => kb.text(item, `pick:${index}`),
  });
  assert.deepEqual(rows(screen.kb), [["add"], ["pick:0"]]);
});

test("pagedScreen closes the keyboard when given a close action", () => {
  const screen = pagedScreen({
    view: paginate(["a"], 0, 8),
    title: () => "t",
    row: (kb, item, index) => kb.text(item, `pick:${index}`),
    back: { text: "Back", data: "root" },
    close: "x:close",
  });
  assert.deepEqual(rows(screen.kb), [["pick:0"], ["root"], ["x:close"]]);
});

test("pageSuffix names the page only when there is more than one", () => {
  assert.equal(pageSuffix(paginate(["a"], 0, 8)), "");
  assert.equal(pageSuffix(paginate(["a", "b", "c"], 1, 2)), " (page 2/2)");
});
