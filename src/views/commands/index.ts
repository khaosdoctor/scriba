import { type CommandContext, Composer, type Context } from "grammy";
import { type Command, commands } from "../../commands/index.ts";
import { fitTelegram } from "../../core.ts";
import type { ViewDeps } from "../index.ts";
import { deleteCommand } from "./delete.ts";
import { done } from "./done.ts";
import { help } from "./help.ts";
import { start } from "./start.ts";

/** One slash command: what Telegram's `/` menu shows for it and the view that answers it. */
export type CommandView = {
  command: string;
  description: string;
  /** Listed by /help. The owner allowlist is the only auth either way. */
  admin?: true;
  view(deps: ViewDeps): Composer<Context>;
};

type Handler = (ctx: CommandContext<Context>) => unknown;

/** A command whose body still lives on a flow, called straight through until that flow
 *  becomes a view of its own. */
function flow(
  command: string,
  description: string,
  handle: (deps: ViewDeps) => Handler,
): CommandView {
  return {
    command,
    description,
    view(deps) {
      const view = new Composer<Context>();
      view.command(command, handle(deps));
      return view;
    },
  };
}

/** An admin command from the registry. Every string it returns passes through fitTelegram,
 *  so an oversized answer becomes a labelled cut instead of a rejected send. */
function admin(cmd: Command): CommandView {
  return {
    command: cmd.name,
    description: cmd.description,
    admin: true,
    view({ admin }) {
      const view = new Composer<Context>();
      view.command(cmd.name, async (ctx) => {
        const out = await cmd.run(ctx, String(ctx.match ?? ""), admin());
        if (typeof out === "string") await ctx.reply(fitTelegram(out));
      });
      return view;
    },
  };
}

/** Every slash command, in the order Telegram's `/` menu and /help list them. */
export const COMMANDS: CommandView[] = [
  start,
  flow(
    "menu",
    "Open the interactive control menu",
    ({ menu }) =>
      (ctx) =>
        menu.open(ctx),
  ),
  flow(
    "rate",
    "Rate a day 1–10 (today, or /rate YYYY-MM-DD)",
    ({ rating }) =>
      (ctx) =>
        rating.slashRate(ctx),
  ),
  flow(
    "habits",
    "Review habits (yesterday, or /habits YYYY-MM-DD)",
    ({ habits }) =>
      (ctx) =>
        habits.slashHabits(ctx),
  ),
  flow(
    "reprocess",
    "Reprocess jots — a day, a date range, or one jot",
    ({ reprocess }) =>
      (ctx) =>
        reprocess.slashReprocess(ctx),
  ),
  flow(
    "command",
    "Open a vault assistant session (/done to close)",
    ({ command }) =>
      (ctx) =>
        command.start(ctx),
  ),
  flow(
    "task",
    "Turn every message into a task (/done to close)",
    ({ tasks }) =>
      (ctx) =>
        tasks.start(ctx),
  ),
  flow(
    "taskadd",
    "Add one task in one message: /taskadd <what and when>",
    ({ tasks }) =>
      (ctx) =>
        tasks.slashTaskAdd(ctx),
  ),
  flow(
    "tasks",
    "List your tasks — open, today, this week, done",
    ({ tasks }) =>
      (ctx) =>
        tasks.slashTasks(ctx),
  ),
  done,
  deleteCommand,
  ...commands.map(admin),
];
COMMANDS.push(help(COMMANDS));
