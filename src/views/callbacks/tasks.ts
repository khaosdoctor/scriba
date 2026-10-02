import type { Composer, Context } from "grammy";
import { SETTINGS } from "../../domain/setting/entity.ts";
import type { TaskType } from "../../domain/task/entity.ts";
import { logger } from "../../libs/log.ts";
import {
  isTaskType,
  type TaskView,
  TYPE_LABEL,
  VIEW_LABEL,
} from "../../libs/tasks.ts";
import { TASKS_NS, type TaskController } from "../../services/tasks.ts";
import { Responder } from "../chat.ts";
import { namespace } from "./namespace.ts";

const log = logger("tasks-flow");

const asView = (view?: string): TaskView =>
  view && view in VIEW_LABEL ? (view as TaskView) : "open";

/** A list screen as a fresh message, or in place of the one that was tapped. */
export async function showTaskList(
  ctx: Context,
  tasks: TaskController,
  view: TaskView,
  page: number,
  mode: "edit" | "send",
): Promise<void> {
  const screen = await tasks.list(view, page).catch((err: unknown) => {
    log.error({ err, view }, "tasks: could not read the task notes");
    const why = err instanceof Error ? err.message : String(err);
    return {
      text: `⚠️ Couldn't read your task notes: ${why}`,
      keyboard: undefined,
    };
  });
  const extra = screen.keyboard && {
    parse_mode: "HTML" as const,
    reply_markup: screen.keyboard,
  };
  if (mode === "send") {
    await ctx.reply(screen.text, extra);
    return;
  }
  await ctx
    .editMessageText(screen.text, extra)
    .catch((err: unknown) =>
      log.warn({ err, view }, "tasks: list edit failed"),
    );
}

async function showMenu(ctx: Context, tasks: TaskController): Promise<void> {
  const { text, keyboard } = await tasks.menu();
  await ctx.editMessageText(text, { reply_markup: keyboard });
}

/** `tk:<action>[:<args>]`: the card buttons, the lists and the task menu. A card tap is
 *  answered once its draft is known to be live, and Create answers after claiming the draft
 *  and before the note write, which can outlive Telegram's callback window. */
export function tasksView(tasks: TaskController): Composer<Context> {
  return namespace(TASKS_NS, async (ctx, [action, ...args]) => {
    const responder = new Responder(ctx);
    const live = async () => {
      const row = await tasks.live(args[0]);
      if (typeof row !== "string") return row;
      await responder.ack(row);
      return undefined;
    };
    switch (action) {
      case "d":
      case "s":
      case "u": {
        const row = await live();
        if (!row) return;
        await responder.ack("Answer the prompt below ↓");
        return tasks.ask(row, action, true);
      }
      case "t": {
        const row = await live();
        if (!row) return;
        const type: TaskType = row.type === "work" ? "personal" : "work";
        await responder.ack(TYPE_LABEL[type]);
        return tasks.setType(row, type);
      }
      case "ok": {
        const row = await live();
        if (!row) return;
        const outcome = await tasks.claim(row);
        if (outcome === "noDue") {
          await responder.ack("it needs a due date first");
          return tasks.ask(row, "u", true);
        }
        if (outcome === "lost") return responder.ack("already created");
        await responder.ack("creating…");
        return tasks.create(row);
      }
      case "x": {
        const row = await live();
        if (!row) return;
        await responder.ack(row.source === "jot" ? "not a task" : "dropped");
        return tasks.drop(row);
      }
      case "m":
        await responder.ack();
        return showMenu(ctx, tasks);
      case "v":
        await responder.ack();
        return showTaskList(
          ctx,
          tasks,
          asView(args[0]),
          Number(args[1]) || 0,
          "edit",
        );
      case "k":
      case "r": {
        const [type, index, fingerprint, view, page] = args;
        if (
          !isTaskType(type) ||
          !Number.isInteger(Number(index)) ||
          !fingerprint
        ) {
          log.warn({ args }, "tasks: malformed tick callback");
          return responder.ack("expired");
        }
        const done = action === "k";
        await responder.ack(done ? "ticking…" : "reopening…");
        await tasks.tick(type, Number(index), fingerprint, done);
        return showTaskList(
          ctx,
          tasks,
          asView(view),
          Number(page) || 0,
          "edit",
        );
      }
      case "det":
      case "til": {
        const key = action === "det" ? "taskDetection" : "tilDetection";
        await responder.ack(SETTINGS[key].label(await tasks.toggle(key)));
        return showMenu(ctx, tasks);
      }
      case "close":
        await responder.ack();
        return responder.closeMessage("🗂 Closed.").catch(() => {});
      default:
        log.warn({ action }, "tasks: unknown callback action");
        return responder.ack();
    }
  });
}
