import type { Context, Filter } from "grammy";
import type { Message } from "grammy/types";
import {
  type AnswerOutcome,
  TASK_ADD_REF,
  type TaskField,
  type TaskRef,
  type TaskService,
} from "../../../services/tasks.ts";
import { Responder } from "../chat.ts";
import { TASKADD_EMPTY } from "./add.ts";

/** Which prompt a reply answers: the marker rides in the prompt's own text. */
export function parseTaskRef(prompt: string): TaskRef | null {
  if (prompt.includes(TASK_ADD_REF)) return { field: "add" };
  const m = prompt.match(/\(tk:(d|s|u):([0-9a-f]{6,16})\)/);
  return m ? { field: m[1] as TaskField, id: m[2]! } : null;
}

const REFUSALS: Record<Exclude<AnswerOutcome, "ok">, string> = {
  settled: "That task is already settled.",
  noText: "Send the task text and I'll use it.",
  noTask: "Send the task and I'll read it.",
  nothing: TASKADD_EMPTY,
  badDate:
    'I couldn\'t read that as a date. Try "next friday", "in two weeks", or 2026-09-15.',
  needsDue: "A task needs a deadline — give me a date for this one.",
};

export function taskReply(tasks: TaskService) {
  return async (
    ctx: Filter<Context, "message:text">,
    ref: TaskRef,
    prompt: Message,
  ) => {
    const outcome = await tasks.answer(
      ref,
      ctx.message.text.trim(),
      prompt.message_id,
    );
    if (outcome !== "ok") await new Responder(ctx).reply(REFUSALS[outcome]);
  };
}
