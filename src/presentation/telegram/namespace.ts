import { Composer, type Context, type Filter } from "grammy";
import { Responder } from "./chat.ts";

export type Tap = Filter<Context, "callback_query:data">;
export type TextReply = Filter<Context, "message:text">;

export function namespace(
  ns: string,
  handle: (ctx: Tap, rest: string[], responder: Responder) => Promise<unknown>,
): Composer<Context> {
  const view = new Composer<Context>();
  view.on("callback_query:data", async (ctx, next) => {
    const [head, ...rest] = ctx.callbackQuery.data.split(":");
    if (head !== ns) return next();
    await handle(ctx, rest, new Responder(ctx));
  });
  return view;
}
