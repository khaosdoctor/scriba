import { Composer, type Context } from "grammy";
import { logger } from "../../../libs/log.ts";
import type { TaskView } from "../../../libs/tasks.ts";
import type { CommandView } from "../commands.ts";
import { showTaskList } from "./tap.ts";

const log = logger("tasks-flow");

/** What `/tasks <arg>` accepts, mapped onto the list screens. */
const VIEW_ALIASES: Record<string, TaskView> = {
  day: "day",
  all: "open",
  open: "open",
  overdue: "overdue",
  late: "overdue",
  today: "today",
  week: "week",
  two: "two",
  fortnight: "two",
  done: "done",
};

/** `/tasks` lists what is open ahead, `/tasks week` one of the other screens. */
export const tasksCommand: CommandView = {
  command: "tasks",
  description: "List your tasks — open, today, this week, done",
  view({ tasks }) {
    const view = new Composer<Context>();
    view.command("tasks", async (ctx) => {
      const arg = ctx.match.trim().toLowerCase();
      if (!arg) return showTaskList(ctx, tasks, "future", 0, "send");
      const screen = VIEW_ALIASES[arg];
      if (!screen) {
        log.warn({ arg }, "/tasks: unknown view");
        await ctx.reply(
          `Usage: /tasks [${Object.keys(VIEW_ALIASES).join(" | ")}]`,
        );
        return;
      }
      return showTaskList(ctx, tasks, screen, 0, "send");
    });
    return view;
  },
};
