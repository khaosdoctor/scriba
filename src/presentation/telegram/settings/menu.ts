import { type Composer, type Context, InlineKeyboard } from "grammy";
import { SETTINGS, type SwitchKey } from "../../../domain/setting/entity.ts";
import { RETRY_NS } from "../../../libs/jot.ts";
import { logger } from "../../../libs/log.ts";
import { fitTelegram } from "../../../libs/text.ts";
import { plainDate, previousDate } from "../../../libs/time.ts";
import type {
  RootState,
  SettingsPrompt,
  SettingsService,
} from "../../../services/settings.ts";
import type { ViewDeps } from "../index.ts";
import { backTo, withClose } from "../keyboard.ts";
import { namespace, type Tap } from "../namespace.ts";
import {
  ROOT_TEXT as REPROCESS_TEXT,
  rootKeyboard as reprocessKeyboard,
} from "../reprocess/tap.ts";
import { openTaskMode } from "../tasks/mode.ts";
import { jotsTap } from "./jots.ts";
import { linkRulesTap } from "./links.ts";
import { MENU_CLOSE, MENU_NS, MODELS, menu } from "./menu-data.ts";

const log = logger("menu");
const reprocessLog = logger("reprocess");

export const MENU_TEXT = "🗂 scriba control menu";

const MODEL_PRESETS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5",
];
const ENTRY_SIZES = [140, 280, 560, 1000, 0];

const onOff = (on: boolean) => (on ? "on" : "off");
// "claude-haiku-5-5" → "haiku 5.5", "claude-sonnet-5" → "sonnet 5". Version parts are
// one or two digits, so a dated snapshot keeps its date: "claude-sonnet-5-20260101" →
// "sonnet 5-20260101", not "sonnet 5.20260101".
const shortModel = (model: string) =>
  model
    .replace("claude-", "")
    .replace(/-(\d{1,2})-(\d{1,2})(?!\d)/, " $1.$2")
    .replace(/-(\d{1,2})(?![\d.])/, " $1");

export function rootKeyboard(state: RootState): InlineKeyboard {
  return new InlineKeyboard()
    .text("📊 Rate today", menu("rate"))
    .text("🌱 Review habits", menu("habits"))
    .row()
    .text("🗒 Recent jots", menu("jots"))
    .row()
    .text("🗂 Tasks", menu("tasks"))
    .text("📝 Task mode", menu("taskmode"))
    .row()
    .text("🔁 Reprocess", menu("reprocess"))
    .row()
    .text("📈 Stats", menu("stats"))
    .text("🩺 Status", menu("status"))
    .row()
    .text("⚠️ Failed queue", menu("failed"))
    .row()
    .text(
      `✂️ Entry size: ${state.entrySize ? `${state.entrySize} chars` : "off"}`,
      menu("esz"),
    )
    .row()
    .text(`🔧 Voice fix: ${onOff(state.voiceFix)}`, menu("vfix"))
    .row()
    .text(`🌙 Nightly rating: ${onOff(state.nightlyRating)}`, menu("rtsw"))
    .text(`💬 Follow-up: ${onOff(state.nightlyFollowup)}`, menu("fusw"))
    .row()
    .text(`🕛 Rating time: ${state.ratingTime}`, menu("rtt"))
    .row()
    .text(`🧠 Enrich: ${shortModel(state.enrichModel ?? "?")}`, menu("em"))
    .text(`🎤 VF model: ${shortModel(state.voiceFixModel ?? "?")}`, menu("vfm"))
    .row()
    .text("🔗 Link rules", menu("links"))
    .text("🛠 Maintenance", menu("maint"))
    .row()
    .text("✖ Close", MENU_CLOSE);
}

const maintenanceKeyboard = () =>
  withClose(
    new InlineKeyboard()
      .text("⚡ Flush", menu("flush"))
      .text("🧹 Sweep", menu("sweep"))
      .row()
      .text("🔧 Unstick", menu("unstick"))
      .text("🔄 Retry all", menu("retryall"))
      .row()
      .text("‹ Back", menu("root")),
    MENU_CLOSE,
  );

function picker(
  options: [label: string, data: string, current: boolean][],
  custom: [label: string, data: string],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const [label, data, current] of options)
    kb.text(`${current ? "✅ " : ""}${label}`, data).row();
  kb.text(...custom).row();
  kb.text("‹ Back", menu("root"));
  return withClose(kb, MENU_CLOSE);
}

async function modelPicker(
  ctx: Tap,
  settings: SettingsService,
  which: "em" | "vfm",
): Promise<void> {
  const { key, title, logName, pick, custom } = MODELS[which];
  const current = await settings.get(key);
  log.info({ which: logName, current }, "menu: model picker");
  await ctx.editMessageText(`${title}\n\nCurrent: ${current ?? "not set"}`, {
    reply_markup: picker(
      MODEL_PRESETS.map((preset) => [
        shortModel(preset),
        menu(pick, preset),
        preset === current,
      ]),
      ["✍️ Type a model", menu(custom)],
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
        ENTRY_SIZES.map((size) => [
          size ? `${size} chars` : "Don't split",
          menu("ess", size),
          size === current,
        ]),
        ["✍️ Type a size", menu("esc")],
      ),
    },
  );
}

export function menuView(deps: ViewDeps): Composer<Context> {
  const { settings, admin, menus, rating, habits, tasks } = deps;
  const links = linkRulesTap(deps);
  const jotBrowser = jotsTap(deps);
  return namespace(MENU_NS, async (ctx, rest, responder) => {
    const [action, arg] = rest;
    const tapped = ctx.callbackQuery.message;
    if (tapped) menus.touch(tapped.chat.id, tapped.message_id);
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
          { which: MODELS[kind].logName },
          "menu: prompting for a custom model",
        );
      return settings.ask(kind);
    };
    const pickModel = async (which: "em" | "vfm") => {
      if (!arg?.trim()) return responder.ack("expired");
      const { key, label } = MODELS[which];
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
        return habits.prompt(previousDate());
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
            .text("Today", menu("stats", "today"))
            .text("Week", menu("stats", "week"))
            .text("All", menu("stats", "all"))
            .row()
            .text("‹ Back", menu("root"));
          return ctx.editMessageText("📈 Stats range:", {
            reply_markup: withClose(kb, MENU_CLOSE),
          });
        }
        return ctx.editMessageText(fitTelegram(await admin.stats(arg)), {
          reply_markup: backTo(menu("stats"), MENU_CLOSE),
        });
      }
      case "status":
        await responder.ack();
        return ctx.editMessageText(fitTelegram(await admin.status()), {
          reply_markup: backTo(menu("root"), MENU_CLOSE),
        });
      case "failed": {
        await responder.ack();
        const { text, ids } = await admin.failed();
        const kb = new InlineKeyboard();
        for (const id of ids) kb.text(`🔄 ${id}`, `${RETRY_NS}:${id}`).row();
        kb.text("‹ Back", menu("root"));
        return ctx.editMessageText(text, {
          reply_markup: withClose(kb, MENU_CLOSE),
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
        const size = arg === undefined ? Number.NaN : Number(arg);
        if (!Number.isInteger(size) || size < 0) {
          log.warn({ arg }, "menu: bad entry size");
          return responder.ack("expired");
        }
        await responder.ack(size ? `${size} chars` : "splitting off");
        await settings.setEntrySize(size);
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
          .text("✅ Yes, retry all", menu("retryally"))
          .row()
          .text("‹ Cancel", menu("maint"));
        return ctx.editMessageText("Requeue every failed jot?", {
          reply_markup: withClose(kb, MENU_CLOSE),
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
      case "jot":
      case "jr":
      case "jd":
      case "jdy":
      case "je":
        return jotBrowser(ctx, action, arg, responder);
      default:
        return links(ctx, rest, responder);
    }
  });
}
