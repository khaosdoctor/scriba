import { InlineKeyboard } from "grammy";
import type { PageView } from "../../libs/page.ts";

/** Empty rows are dropped first: a keyboard built with a trailing .row() would otherwise
 *  render an empty row above the button. */
export function withClose(
  kb: InlineKeyboard,
  closeData: string,
): InlineKeyboard {
  const rows = kb.inline_keyboard.filter((r) => r.length > 0);
  return InlineKeyboard.from(rows).row().text("✖ Close", closeData);
}

export function backTo(target: string, closeData: string): InlineKeyboard {
  return withClose(new InlineKeyboard().text("‹ Back", target), closeData);
}

export function navRow(
  kb: InlineKeyboard,
  page: number,
  pages: number,
  cb: (page: number) => string,
): InlineKeyboard {
  if (pages <= 1) return kb;
  if (page > 0) kb.text("‹ Prev", cb(page - 1));
  if (page < pages - 1) kb.text("Next ›", cb(page + 1));
  return kb.row();
}

/** One list screen: a button row per item, Prev/Next, the caller's own rows, then Back.
 *  `title` builds the whole message text. Close is the caller's `withClose`, since some
 *  screens are sent through a helper that adds it. */
export function pagedScreen<T>(opts: {
  view: PageView<T>;
  title: (view: PageView<T>) => string;
  row: (kb: InlineKeyboard, item: T, index: number) => void;
  nav?: (page: number) => string;
  back?: { text: string; data: string };
  kb?: InlineKeyboard;
  extraRows?: (kb: InlineKeyboard) => void;
}): { text: string; kb: InlineKeyboard } {
  const { view, kb = new InlineKeyboard() } = opts;
  for (const [j, item] of view.items.entries()) {
    opts.row(kb, item, view.offset + j);
    kb.row();
  }
  if (opts.nav) navRow(kb, view.page, view.pages, opts.nav);
  opts.extraRows?.(kb);
  if (opts.back) kb.text(opts.back.text, opts.back.data);
  return { text: opts.title(view), kb };
}
