import type { Context, Filter } from "grammy";
import type { FillOutcome, HabitService } from "../../../services/habits.ts";
import { Responder } from "../chat.ts";

const REFUSALS: Record<Exclude<FillOutcome, "saved">, string> = {
  notNumber: "That's not a number. Reply with a number only.",
  gone: "Couldn't find that habit to update.",
};

export function habitReply(habits: HabitService) {
  return async (
    ctx: Filter<Context, "message:text">,
    { date, index, digest }: { date: string; index: number; digest: string },
  ) => {
    const responder = new Responder(ctx);
    const outcome = await habits.fill(
      date,
      index,
      digest,
      ctx.message.text.trim(),
    );
    if (outcome !== "saved") return responder.reply(REFUSALS[outcome]);
    await responder.remove().catch(() => {});
    await habits.ask(date, index + 1);
  };
}
