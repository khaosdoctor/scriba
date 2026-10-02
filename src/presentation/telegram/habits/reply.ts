import type { Context, Filter } from "grammy";
import type { FillOutcome, HabitController } from "../../../services/habits.ts";
import { Responder } from "../chat.ts";

const REFUSALS: Record<Exclude<FillOutcome, "saved">, string> = {
  notNumber: "That's not a number. Reply with a number only.",
  gone: "Couldn't find that habit to update.",
};

/** A recorded reply leaves the chat: the flow message shows the progress. */
export function habitReply(habits: HabitController) {
  return async (
    ctx: Filter<Context, "message:text">,
    { date, index }: { date: string; index: number },
  ) => {
    const responder = new Responder(ctx);
    const outcome = await habits.fill(date, index, ctx.message.text.trim());
    if (outcome !== "saved") return responder.reply(REFUSALS[outcome]);
    await responder.remove().catch(() => {});
    await habits.ask(date, index + 1);
  };
}
