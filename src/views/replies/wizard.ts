import { type Context, type Filter, InlineKeyboard } from "grammy";
import type {
  ModelKey,
  SettingsController,
  SettingsPrompt,
} from "../../controllers/settings.ts";
import { parseEntrySize, parseWizardRef } from "../../core.ts";
import { logger } from "../../lib/log.ts";
import { parseClockTime } from "../../models/settings.ts";
import { Responder } from "../chat.ts";
import type { ViewDeps } from "../index.ts";
import { withClose } from "../render/keyboard.ts";

const log = logger("menu");

/** One typed-value prompt: `apply` stores what the body means and answers with the
 *  confirmation text, or null for an unusable body, which is logged under `warn` and
 *  answered with `invalid`. The confirmation carries `button`. */
interface Reply {
  warn: string;
  invalid: string;
  button: [label: string, data: string];
  apply(settings: SettingsController, body: string): Promise<string | null>;
}

const model = (
  key: ModelKey,
  label: string,
  button: Reply["button"],
): Reply => ({
  warn: "menu: empty model reply",
  invalid: "Send a model ID (e.g. claude-sonnet-5).",
  button,
  async apply(settings, body) {
    const id = body.trim();
    if (!id) return null;
    await settings.setModel(key, id);
    return `🧠 ${label} model: ${id}`;
  },
});

const REPLIES: Record<SettingsPrompt, Reply> = {
  es: {
    warn: "menu: unusable entry size reply",
    invalid: 'Give me a whole number between 40 and 4000, or "off".',
    button: ["✂️ Entry size", "menu:esz"],
    async apply(settings, body) {
      const size = parseEntrySize(body);
      if (size === null) return null;
      await settings.setEntrySize(size);
      return size
        ? `✂️ entries split above ${size} characters`
        : "✂️ splitting off — entries stay on one line";
    },
  },
  rt: {
    warn: "menu: unusable rating time reply",
    invalid:
      "That isn't a time. Use HH:MM in 24-hour time, like 23:30 or 00:00.",
    button: ["🗂 Menu", "menu:root"],
    async apply(settings, body) {
      const time = parseClockTime(body);
      if (!time) return null;
      await settings.setRatingTime(time);
      return `🕛 nightly rating at ${time}`;
    },
  },
  em: model("enrichModel", "enrichment", ["🧠 Enrich model", "menu:em"]),
  vfm: model("voiceFixModel", "voice fix", ["🎤 VF model", "menu:vfm"]),
};

/** The settings prompt a quoted message is, if it is one. The link wizard's prompts
 *  belong to the menu flow. */
export function parseSettingsRef(prompt: string): SettingsPrompt | null {
  const kind = parseWizardRef(prompt)?.kind;
  return kind !== undefined && kind in REPLIES
    ? (kind as SettingsPrompt)
    : null;
}

/** A confirmation is still part of the menu: it gets the same Close button and the same
 *  idle countdown. */
export function wizardReply({ settings, menus }: ViewDeps) {
  return async (ctx: Filter<Context, "message:text">, kind: SettingsPrompt) => {
    const reply = REPLIES[kind];
    const body = ctx.message.text;
    const responder = new Responder(ctx);
    const done = await reply.apply(settings, body);
    if (done === null) {
      log.warn({ body }, reply.warn);
      await responder.reply(reply.invalid);
      return;
    }
    const kb = new InlineKeyboard().text(...reply.button);
    const id = await responder.reply(done, {
      keyboard: withClose(kb, "menu:close"),
    });
    menus.touch(ctx.chat.id, id);
  };
}
