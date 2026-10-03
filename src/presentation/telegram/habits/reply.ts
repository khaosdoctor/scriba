import type { HabitRef } from "../../../libs/habits.ts";
import type { FillOutcome, HabitService } from "../../../services/habits.ts";
import { Responder } from "../chat.ts";
import type { TextReply } from "../namespace.ts";

const REFUSALS: Record<Exclude<FillOutcome, "saved">, string> = {
  notNumber: "That's not a number. Reply with a number only.",
  gone: "Couldn't find that habit to update.",
};

export function habitReply(habits: HabitService) {
  return async (ctx: TextReply, { date, index, digest }: HabitRef) => {
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
