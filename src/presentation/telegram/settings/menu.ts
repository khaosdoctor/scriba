import { type Composer, type Context, InlineKeyboard } from "grammy";
import { SETTINGS, type SwitchKey } from "../../../domain/setting/entity.ts";
import { formatJotDetail, jotPreview, STATUS_ICON } from "../../../libs/jot.ts";
import { logger } from "../../../libs/log.ts";
import { paginate } from "../../../libs/page.ts";
import { fitTelegram } from "../../../libs/text.ts";
import { plainDate } from "../../../libs/time.ts";
import type { JotService } from "../../../services/jots.ts";
import type {
  ModelKey,
  RootState,
  SettingsPrompt,
  SettingsService,
} from "../../../services/settings.ts";
import { Responder } from "../chat.ts";
import type { ViewDeps } from "../index.ts";
import { backTo, pagedScreen, withClose } from "../keyboard.ts";
import { namespace, type Tap } from "../namespace.ts";
import {
  ROOT_TEXT as REPROCESS_TEXT,
  rootKeyboard as reprocessKeyboard,
} from "../reprocess/tap.ts";
import { openTaskMode } from "../tasks/mode.ts";
import { linkRulesTap } from "./links.ts";

const log = logger("menu");
const reprocessLog = logger("reprocess");

export const MENU_TEXT = "🗂 scriba control menu";
const CLOSE = "menu:close";

const MODEL_PRESETS = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"];
const ENTRY_SIZES = [140, 280, 560, 1000, 0];

/** Each model setting by its picker action: key, screen title, toast label, the action
 *  of a preset pick and the action of the typed-id prompt. */
const MODELS: Record<"em" | "vfm", [ModelKey, string, string, string, string]> =
  {
    em: ["enrichModel", "🧠 Enrichment model", "enrichment", "ems", "emc"],
    vfm: ["voiceFixModel", "🎤 Voice fix model", "voice fix", "vfs", "vfc"],
  };

const onOff = (on: boolean) => (on ? "on" : "off");
const shortModel = (m: string) =>
  m.replace("claude-", "").replace("-4-5", " 4.5").replace("-5", " 5");

export function rootKeyboard(s: RootState): InlineKeyboard {
  return new InlineKeyboard()
    .text("📊 Rate today", "menu:rate")
    .text("🌱 Review habits", "menu:habits")
    .row()
    .text("🗒 Recent jots", "menu:jots")
    .row()
    .text("🗂 Tasks", "menu:tasks")
    .text("📝 Task mode", "menu:taskmode")
    .row()
    .text("🔁 Reprocess", "menu:reprocess")
    .row()
    .text("📈 Stats", "menu:stats")
    .text("🩺 Status", "menu:status")
    .row()
    .text("⚠️ Failed queue", "menu:failed")
    .row()
    .text(
      `✂️ Entry size: ${s.entrySize ? `${s.entrySize} chars` : "off"}`,
      "menu:esz",
    )
    .row()
    .text(`🔧 Voice fix: ${onOff(s.voiceFix)}`, "menu:vfix")
    .row()
    .text(`🌙 Nightly rating: ${onOff(s.nightlyRating)}`, "menu:rtsw")
    .text(`💬 Follow-up: ${onOff(s.nightlyFollowup)}`, "menu:fusw")
    .row()
    .text(`🕛 Rating time: ${s.ratingTime}`, "menu:rtt")
    .row()
    .text(`🧠 Enrich: ${shortModel(s.enrichModel ?? "?")}`, "menu:em")
    .text(`🎤 VF model: ${shortModel(s.voiceFixModel ?? "?")}`, "menu:vfm")
    .row()
    .text("🔗 Link rules", "menu:links")
    .text("🛠 Maintenance", "menu:maint")
    .row()
    .text("✖ Close", CLOSE);
}

const maintenanceKeyboard = () =>
  withClose(
    new InlineKeyboard()
      .text("⚡ Flush", "menu:flush")
      .text("🧹 Sweep", "menu:sweep")
      .row()
      .text("🔧 Unstick", "menu:unstick")
      .text("🔄 Retry all", "menu:retryall")
      .row()
      .text("‹ Back", "menu:root"),
    CLOSE,
  );

/** One-tap presets with the current one ticked, a typed-value prompt and Back. */
function picker(
  options: [label: string, data: string, current: boolean][],
  custom: [label: string, data: string],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const [label, data, current] of options)
    kb.text(`${current ? "✅ " : ""}${label}`, data).row();
  kb.text(...custom).row();
  kb.text("‹ Back", "menu:root");
  return withClose(kb, CLOSE);
}

async function modelPicker(
  ctx: Tap,
  settings: SettingsService,
  which: "em" | "vfm",
): Promise<void> {
  const [key, title, , pick, custom] = MODELS[which];
  const current = await settings.get(key);
  log.info(
    { which: key === "enrichModel" ? "enrich" : "voiceFix", current },
    "menu: model picker",
  );
  await ctx.editMessageText(`${title}\n\nCurrent: ${current ?? "not set"}`, {
    reply_markup: picker(
      MODEL_PRESETS.map((p) => [
        shortModel(p),
        `menu:${pick}:${p}`,
        p === current,
      ]),
      ["✍️ Type a model", `menu:${custom}`],
    ),
  });
}

async function entrySizeScreen(
  ctx: Tap,
  settings: SettingsService,
): Promise<void> {
  const current = await settings.get("entryMaxChars");
  log.info({ current }, "menu: entry size");
  await ctx.editMessageText(
    [
      "✂️ Entry size",
      "",
      current
        ? `Entries longer than ${current} characters are split into several journal lines.`
        : "Splitting is off — every jot stays on one line, however long.",
      "",
      "Splits land on topic boundaries where there are any, and on sentence ends otherwise. A sentence is never cut in half.",
    ].join("\n"),
    {
      reply_markup: picker(
        ENTRY_SIZES.map((n) => [
          n ? `${n} chars` : "Don't split",
          `menu:ess:${n}`,
          n === current,
        ]),
        ["✍️ Type a size", "menu:esc"],
      ),
    },
  );
}

/** The jots browser: recent jots as tappable rows, so finding one no longer means
 *  scrolling chat history. */
async function jotsList(ctx: Tap, jots: JotService): Promise<unknown> {
  const recent = await jots.recent(10);
  if (!recent.length)
    return ctx.editMessageText("No jots yet.", {
      reply_markup: backTo("menu:root", CLOSE),
    });
  const screen = pagedScreen({
    view: paginate(recent, 0, recent.length),
    title: () => "🗒 Recent jots:",
    row: (kb, j) =>
      kb.text(
        `${STATUS_ICON[j.status]} ${j.time} ${jotPreview(j)}`,
        `menu:jot:${j.id}`,
      ),
    back: { text: "‹ Back", data: "menu:root" },
  });
  return ctx.editMessageText(screen.text, {
    reply_markup: withClose(screen.kb, CLOSE),
  });
}

async function jotDetail(
  ctx: Tap,
  jots: JotService,
  id?: string,
): Promise<unknown> {
  const jot = id ? await jots.get(id) : undefined;
  if (!jot)
    return ctx.editMessageText(`No jot ${id ?? ""}.`, {
      reply_markup: backTo("menu:jots", CLOSE),
    });
  const kb = new InlineKeyboard()
    .text("🔄 Retry", `menu:jr:${jot.id}`)
    .text("✏️ Edit", `menu:je:${jot.id}`)
    .row()
    .text("🗑 Delete", `menu:jd:${jot.id}`)
    .row()
    .text("‹ Back", "menu:jots");
  return ctx.editMessageText(formatJotDetail(jot), {
    reply_markup: withClose(kb, CLOSE),
  });
}

/** `menu:<action>[:<arg>]`: the control panel's screens. Every tap restarts the menu's
 *  idle countdown. Toggles and model picks answer after the write; an entry-size pick and
 *  a tap that only draws a screen answer first. The link wizard (`menu:l*`) gets every
 *  action this view does not name. */
export function menuView(deps: ViewDeps): Composer<Context> {
  const {
    settings,
    admin,
    menus,
    rating,
    habits,
    tasks,
    jotController,
    edits,
  } = deps;
  const links = linkRulesTap(deps);
  return namespace("menu", async (ctx, rest) => {
    const [action, arg] = rest;
    const tapped = ctx.callbackQuery.message;
    if (tapped) menus.touch(tapped.chat.id, tapped.message_id);
    const responder = new Responder(ctx);
    const redraw = async () =>
      ctx.editMessageText(MENU_TEXT, {
        reply_markup: rootKeyboard(await settings.root()),
      });
    const toggle = async (key: SwitchKey) => {
      const next = await settings.toggle(key);
      // The setting is already saved, so neither a stale callback query nor a menu that
      // has gone away may undo that or stop the other half.
      await responder
        .ack(SETTINGS[key].label(next))
        .catch((err: unknown) => log.warn({ err }, "menu: toggle ack failed"));
      await redraw().catch((err: unknown) =>
        log.warn({ err }, "menu: toggle redraw failed"),
      );
    };
    const ask = async (kind: SettingsPrompt) => {
      await responder.ack("Answer the prompt below ↓");
      if (kind === "rt") log.info("menu: prompting for the rating time");
      if (kind === "es") log.info("menu: prompting for a custom entry size");
      if (kind === "em" || kind === "vfm")
        log.info(
          { which: kind === "em" ? "enrich" : "voiceFix" },
          "menu: prompting for a custom model",
        );
      return settings.ask(kind);
    };
    const pickModel = async (which: "em" | "vfm") => {
      if (!arg?.trim()) return responder.ack("expired");
      const [key, , label] = MODELS[which];
      await settings.setModel(key, arg);
      await responder.ack(`${label}: ${shortModel(arg)}`);
      return modelPicker(ctx, settings, which);
    };
    // Answered before the command runs (a flush or a retry pass can be slow): the edited
    // message carries the result.
    const maintenance = async (
      cmd: string,
      cmdArg: string,
      run: () => Promise<string>,
    ) => {
      log.info({ cmd, arg: cmdArg }, "menu: maintenance action");
      await responder.ack();
      const out = fitTelegram(await run());
      return ctx.editMessageText(out || "done", {
        reply_markup: maintenanceKeyboard(),
      });
    };
    switch (action) {
      case "root":
        await responder.ack();
        return redraw();
      case "rate":
        await responder.ack("Opening rating prompt below ↓");
        return rating.prompt(plainDate());
      case "habits":
        await responder.ack("Opening habits review below ↓");
        return habits.prompt(plainDate(Date.now() - 86_400_000));
      case "tasks":
        await responder.ack("Opening tasks below ↓");
        return tasks.promptRoot();
      case "taskmode":
        await responder.ack();
        return openTaskMode(ctx, tasks);
      case "reprocess":
        await responder.ack("Opening reprocess menu below ↓");
        reprocessLog.info("reprocess menu opened (via /menu)");
        await ctx.api.sendMessage(deps.ownerId, REPROCESS_TEXT, {
          reply_markup: reprocessKeyboard(),
        });
        return;
      case "stats": {
        await responder.ack();
        if (!arg) {
          const kb = new InlineKeyboard()
            .text("Today", "menu:stats:today")
            .text("Week", "menu:stats:week")
            .text("All", "menu:stats:all")
            .row()
            .text("‹ Back", "menu:root");
          return ctx.editMessageText("📈 Stats range:", {
            reply_markup: withClose(kb, CLOSE),
          });
        }
        return ctx.editMessageText(fitTelegram(await admin.stats(arg)), {
          reply_markup: backTo("menu:stats", CLOSE),
        });
      }
      case "status":
        await responder.ack();
        return ctx.editMessageText(fitTelegram(await admin.status()), {
          reply_markup: backTo("menu:root", CLOSE),
        });
      case "failed": {
        await responder.ack();
        const { text, ids } = await admin.failed();
        const kb = new InlineKeyboard();
        for (const id of ids) kb.text(`🔄 ${id}`, `rt:${id}`).row();
        kb.text("‹ Back", "menu:root");
        return ctx.editMessageText(text, {
          reply_markup: withClose(kb, CLOSE),
        });
      }
      case "vfix":
        return toggle("fixVoiceTranscript");
      case "rtsw":
        return toggle("nightlyRating");
      case "fusw":
        return toggle("nightlyFollowup");
      case "rtt":
        return ask("rt");
      case "esc":
        return ask("es");
      case "emc":
        return ask("em");
      case "vfc":
        return ask("vfm");
      case "em":
      case "vfm":
        await responder.ack();
        return modelPicker(ctx, settings, action);
      case "ems":
        return pickModel("em");
      case "vfs":
        return pickModel("vfm");
      case "esz":
        await responder.ack();
        return entrySizeScreen(ctx, settings);
      case "ess": {
        const n = arg === undefined ? Number.NaN : Number(arg);
        if (!Number.isInteger(n) || n < 0) {
          log.warn({ arg }, "menu: bad entry size");
          return responder.ack("expired");
        }
        await responder.ack(n ? `${n} chars` : "splitting off");
        await settings.setEntrySize(n);
        return entrySizeScreen(ctx, settings);
      }
      case "maint":
        await responder.ack();
        return ctx.editMessageText("🛠 Maintenance", {
          reply_markup: maintenanceKeyboard(),
        });
      case "retryall": {
        log.info("menu: retry-all confirm");
        await responder.ack();
        const kb = new InlineKeyboard()
          .text("✅ Yes, retry all", "menu:retryally")
          .row()
          .text("‹ Cancel", "menu:maint");
        return ctx.editMessageText("Requeue every failed jot?", {
          reply_markup: withClose(kb, CLOSE),
        });
      }
      case "flush":
        return maintenance("flush", "", () => admin.flush());
      case "sweep":
        return maintenance("sweep", "", () => admin.retryPass());
      case "unstick":
        return maintenance("unstick", "", () => admin.unstick());
      case "retryally":
        return maintenance("retry", "all", () => admin.retry("all"));
      case "close":
        log.info("menu closed");
        await responder.ack();
        return responder.closeMessage("🗂 Menu closed.", () => {
          if (tapped) menus.closed(tapped.chat.id, tapped.message_id);
        });
      case "jots":
        await responder.ack();
        return jotsList(ctx, jotController);
      case "jot":
        await responder.ack();
        return jotDetail(ctx, jotController, arg);
      case "jr": {
        if (!arg || !(await jotController.get(arg)))
          return responder.ack("gone");
        log.info({ jotId: arg }, "menu: manual retry requested");
        await jotController.retry(arg);
        await responder.ack("retrying");
        return ctx.editMessageText(`🔄 retrying ${arg}…`, {
          reply_markup: backTo("menu:jots", CLOSE),
        });
      }
      case "jd": {
        await responder.ack();
        if (!arg) return;
        const kb = new InlineKeyboard()
          .text("🗑 Yes, delete", `menu:jdy:${arg}`)
          .text("Cancel", `menu:jot:${arg}`);
        return ctx.editMessageText(
          `Delete jot ${arg}? This removes its line from the journal.`,
          { reply_markup: withClose(kb, CLOSE) },
        );
      }
      case "jdy": {
        const jot = arg ? await jotController.get(arg) : undefined;
        if (!jot) return responder.ack("gone");
        // Answer before the note-lock read/write below, which can be slow enough to blow
        // past Telegram's callback-query window: the edited message carries the result.
        await responder.ack();
        log.info({ jotId: arg }, "menu: delete jot");
        return ctx.editMessageText(await edits.deleteJot(jot), {
          reply_markup: backTo("menu:jots", CLOSE),
        });
      }
      case "je":
        if (!arg || !(await jotController.get(arg)))
          return responder.ack("gone");
        await responder.ack();
        log.info({ jotId: arg }, "menu: edit jot — prompting for a reply");
        return jotController.askEdit(arg);
      default:
        return links(ctx, rest);
    }
  });
}
