import { Composer, type Context } from "grammy";
import type { ViewDeps } from "../index.ts";

/** The owner reacting 🤝 to a squashed follower's own message: the merge opt-out. */
export function reactionView({ jots }: ViewDeps): Composer<Context> {
  const view = new Composer<Context>();
  view.on("message_reaction", (ctx) => jots.handleMergeReaction(ctx));
  return view;
}
