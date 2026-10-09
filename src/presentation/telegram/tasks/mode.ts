import type { Context } from "grammy";
import type { TaskService } from "../../../services/tasks.ts";
import type { CommandView } from "../commands.ts";

const INTRO = [
  "📝 Task mode is on.",
  "",
  "Every message you send now becomes one task instead of a journal entry. Say when it's due in your own words — “review the RFC by next friday”, “buy cat sand next week”, “book the flights starting monday due in two weeks”.",
  "",
  "I'll show you what I understood before anything is written, and you can change the description, either date or the type from the buttons. Personal unless you say it's for work.",
  "",
  "/tasks lists what's open. Send /done when you're finished.",
].join("\n");

const REFUSALS = {
  already: "📝 Task mode is already on. /done closes it.",
  busy: "🧭 Command mode is open. Send /done to close it first, then /task.",
};

export async function openTaskMode(
  ctx: Context,
  tasks: TaskService,
): Promise<void> {
  const outcome = tasks.start();
  await ctx.reply(outcome === "opened" ? INTRO : REFUSALS[outcome]);
}

export async function taskMessage(
  ctx: Context,
  tasks: TaskService,
  text: string,
): Promise<void> {
  if (await tasks.handle(text)) return;
  await ctx.reply(
    "I couldn't find anything to do in that — send the task itself, like “buy cat sand next week”.",
  );
}

export const taskCommand: CommandView = {
  command: "task",
  description: "Turn every message into a task (/done to close)",
  example:
    '/task, then "water the plants by friday" → a task card to confirm before it\'s written',
  run(ctx, { tasks }) {
    return openTaskMode(ctx, tasks);
  },
};
