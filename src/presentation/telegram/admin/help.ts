import { logger } from "../../../libs/log.ts";
import { escapeHtml, TELEGRAM_LIMIT } from "../../../libs/text.ts";
import type { CommandView } from "../commands.ts";

const log = logger("help");

function entry(view: CommandView): string {
  const head = `<b>/${view.command}</b>: ${escapeHtml(view.description)}`;
  return view.example
    ? `${head}\n<i>e.g.</i> ${escapeHtml(view.example)}`
    : head;
}

/** Every command, everyday ones first and admin ones after, each with its example. Packed
 *  into as many messages as Telegram's limit needs, breaking only between commands so no
 *  entry is ever cut. */
export function helpPages(all: CommandView[]): string[] {
  const blocks = [
    "<b>📓 Everyday</b>",
    ...all.filter((view) => !view.admin).map(entry),
    "<b>🛠 Admin</b>",
    ...all.filter((view) => view.admin).map(entry),
  ];
  const pages: string[] = [];
  let page = "";
  for (const block of blocks) {
    const joined = page ? `${page}\n\n${block}` : block;
    if (page && joined.length > TELEGRAM_LIMIT) {
      pages.push(page);
      page = block;
      continue;
    }
    page = joined;
  }
  pages.push(page);
  return pages;
}

export function help(all: CommandView[]): CommandView {
  return {
    command: "help",
    description: "List every command with an example",
    example: "/help → this list",
    async run(ctx) {
      const pages = helpPages(all);
      log.info({ commands: all.length, pages: pages.length }, "/help command");
      for (const page of pages) await ctx.reply(page, { parse_mode: "HTML" });
    },
  };
}
