import type { TaskView } from "../../../domain/task/entity.ts";
import { logger } from "../../../libs/log.ts";
import type { CommandView } from "../commands.ts";
import { showTaskList } from "./tap.ts";

const log = logger("tasks-flow");

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

export const tasksCommand: CommandView = {
  command: "tasks",
  description: "List your tasks — open, today, this week, done",
  example: "/tasks week → tasks due this week; tap one to tick it off",
  async run(ctx, { tasks }) {
    const arg = ctx.match.trim().toLowerCase();
    const screen = VIEW_ALIASES[arg];
    log.info({ arg: arg || "(menu)", view: screen }, "/tasks command");
    if (!arg) return showTaskList(ctx, tasks, "future", 0, "send");
    if (!screen) {
      log.warn({ arg }, "/tasks: unknown view");
      await ctx.reply(
        `Usage: /tasks [${Object.keys(VIEW_ALIASES).join(" | ")}]`,
      );
      return;
    }
    return showTaskList(ctx, tasks, screen, 0, "send");
  },
};
