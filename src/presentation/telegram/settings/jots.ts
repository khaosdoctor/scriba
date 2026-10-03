import { InlineKeyboard } from "grammy";
import { formatJotDetail, jotPreview, STATUS_ICON } from "../../../libs/jot.ts";
import { logger } from "../../../libs/log.ts";
import { paginate } from "../../../libs/page.ts";
import type { JotService } from "../../../services/jots.ts";
import type { Responder } from "../chat.ts";
import type { ViewDeps } from "../index.ts";
import { STILL_PROCESSING } from "../journal/edit-reply.ts";
import { backTo, pagedScreen, withClose } from "../keyboard.ts";
import type { Tap } from "../namespace.ts";
import { MENU_CLOSE, menu } from "./menu-data.ts";

const log = logger("menu");

export type JotAction = "jots" | "jot" | "jr" | "jd" | "jdy" | "je";

export type JotsDeps = Pick<ViewDeps, "jots" | "edits">;

type JotHandler = (
  ctx: Tap,
  arg: string | undefined,
  responder: Responder,
) => Promise<unknown>;

export function jotsTap({ jots, edits }: JotsDeps) {
  const handlers: Record<JotAction, JotHandler> = {
    jots: async (ctx, _arg, responder) => {
      await responder.ack();
      return jotsList(ctx, jots);
    },
    jot: async (ctx, arg, responder) => {
      await responder.ack();
      return jotDetail(ctx, jots, arg);
    },
    jr: async (ctx, arg, responder) => {
      const jot = await jots.liveJot(arg);
      if (typeof jot === "string") return responder.ack("gone");
      log.info({ jotId: arg }, "menu: manual retry requested");
      if ((await jots.retry(jot)) === "in-flight")
        return responder.ack("still processing");
      await responder.ack("retrying");
      return ctx.editMessageText(`🔄 retrying ${arg}…`, {
        reply_markup: backTo(menu("jots"), MENU_CLOSE),
      });
    },
    jd: async (ctx, arg, responder) => {
      await responder.ack();
      if (!arg) return;
      const kb = new InlineKeyboard()
        .text("🗑 Yes, delete", menu("jdy", arg))
        .text("Cancel", menu("jot", arg));
      return ctx.editMessageText(
        `Delete jot ${arg}? This removes its line from the journal.`,
        { reply_markup: withClose(kb, MENU_CLOSE) },
      );
    },
    jdy: async (ctx, arg, responder) => {
      const jot = await jots.liveJot(arg);
      if (typeof jot === "string") return responder.ack("gone");
      log.info({ jotId: arg }, "menu: delete jot");
      const outcome = await edits.discard(jot);
      // Answer before the note-lock read/write below, which can be slow enough to blow
      // past Telegram's callback-query window: the edited message carries the result.
      await responder.ack();
      return ctx.editMessageText(
        outcome === "removal-queued"
          ? STILL_PROCESSING["removal-queued"]
          : await outcome.now(),
        { reply_markup: backTo(menu("jots"), MENU_CLOSE) },
      );
    },
    je: async (_ctx, arg, responder) => {
      if (!arg || !(await jots.get(arg))) return responder.ack("gone");
      await responder.ack();
      log.info({ jotId: arg }, "menu: edit jot — prompting for a reply");
      return jots.askEdit(arg);
    },
  };
  return (
    ctx: Tap,
    action: JotAction,
    arg: string | undefined,
    responder: Responder,
  ): Promise<unknown> => handlers[action](ctx, arg, responder);
}

async function jotsList(ctx: Tap, jots: JotService): Promise<unknown> {
  const recent = await jots.recent(10);
  if (!recent.length)
    return ctx.editMessageText("No jots yet.", {
      reply_markup: backTo(menu("root"), MENU_CLOSE),
    });
  const screen = pagedScreen({
    view: paginate(recent, 0, recent.length),
    title: () => "🗒 Recent jots:",
    row: (kb, jot) =>
      kb.text(
        `${STATUS_ICON[jot.status]} ${jot.time} ${jotPreview(jot)}`,
        menu("jot", jot.id),
      ),
    back: { text: "‹ Back", data: menu("root") },
    close: MENU_CLOSE,
  });
  return ctx.editMessageText(screen.text, { reply_markup: screen.kb });
}

async function jotDetail(
  ctx: Tap,
  jots: JotService,
  id?: string,
): Promise<unknown> {
  const jot = id ? await jots.get(id) : undefined;
  if (!jot)
    return ctx.editMessageText(`No jot ${id ?? ""}.`, {
      reply_markup: backTo(menu("jots"), MENU_CLOSE),
    });
  const kb = new InlineKeyboard()
    .text("🔄 Retry", menu("jr", jot.id))
    .text("✏️ Edit", menu("je", jot.id))
    .row()
    .text("🗑 Delete", menu("jd", jot.id))
    .row()
    .text("‹ Back", menu("jots"));
  return ctx.editMessageText(formatJotDetail(jot), {
    reply_markup: withClose(kb, MENU_CLOSE),
  });
}
