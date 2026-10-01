import { type Context, type Filter, InlineKeyboard } from "grammy";
import type {
  ModelKey,
  SettingsController,
  SettingsPrompt,
} from "../../controllers/settings.ts";
import { cleanNoteTitle, parseRuleWords } from "../../lib/links.ts";
import { logger } from "../../lib/log.ts";
import { parseEntrySize } from "../../lib/text.ts";
import { parseWizardRef, type WizardPrompt } from "../../lib/wizard.ts";
import { parseClockTime } from "../../models/settings.ts";
import {
  advance,
  type LinkDeps,
  notePicker,
  replyMenu,
} from "../callbacks/links.ts";
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

/** The settings prompt a quoted message is, if it is one. */
export function parseSettingsRef(prompt: string): SettingsPrompt | null {
  const kind = parseWizardRef(prompt)?.kind;
  return kind !== undefined && kind in REPLIES
    ? (kind as SettingsPrompt)
    : null;
}

export type LinkRef = Exclude<WizardPrompt, { kind: SettingsPrompt }>;

/** The link-wizard prompt a quoted message is, if it is one. */
export function parseLinkRef(prompt: string): LinkRef | null {
  const p = parseWizardRef(prompt);
  return p !== null && !(p.kind in REPLIES) ? (p as LinkRef) : null;
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

const LINK_RULES = () =>
  new InlineKeyboard().text("🔗 Link rules", "menu:links");

/** Free text for a link rule: never-link words, always-link words (then a note picker per
 *  word), a note search, a note title typed by hand, or a pair's new word. */
export function linkReply(deps: LinkDeps) {
  const { settings } = deps;
  return async (ctx: Filter<Context, "message:text">, p: LinkRef) => {
    const body = ctx.message.text;
    switch (p.kind) {
      case "sw": {
        const words = parseRuleWords(body);
        if (!words.length) {
          log.warn({ body }, "link wizard: empty never-link reply");
          return void ctx.reply("Nothing to add — send a word.");
        }
        await settings.addStopwords(words);
        return replyMenu(
          ctx,
          deps,
          `🔇 never linking: ${words.join(", ")}`,
          LINK_RULES(),
        );
      }
      case "rg": {
        const words = parseRuleWords(body);
        if (!words.length) {
          log.warn({ body }, "link wizard: empty always-link reply");
          return void ctx.reply("Nothing to add — send a word.");
        }
        settings.queueWords(words);
        return notePicker(ctx, deps, "send", 0);
      }
      case "rgn": {
        if (!settings.search(cleanNoteTitle(body))) {
          log.warn("link wizard: search reply with no pending flow");
          return void ctx.reply("That link flow expired — reopen /menu.");
        }
        return notePicker(ctx, deps, "send", 0);
      }
      case "rgm": {
        const word = settings.currentWord();
        if (word === undefined) {
          log.warn("link wizard: manual note reply with no pending flow");
          return void ctx.reply("That link flow expired — reopen /menu.");
        }
        const note = cleanNoteTitle(body);
        if (!note) {
          log.warn({ body }, "link wizard: empty manual note reply");
          return void ctx.reply("Nothing to link to — send a note title.");
        }
        log.info({ surface: word, note }, "link wizard: manual note title");
        await ctx.reply(`🔗 "${word}" → [[${note}]]`);
        await settings.savePair(word, note);
        return advance(ctx, deps, "send");
      }
      case "rgw": {
        const r = (await settings.pairs())[p.index];
        if (!r) {
          log.warn({ index: p.index }, "link wizard: rename target is gone");
          return void ctx.reply("That pair is gone — reopen /menu.");
        }
        const [word] = parseRuleWords(body, 1);
        if (!word) {
          log.warn({ body }, "link wizard: empty rename reply");
          return void ctx.reply("Nothing to rename to — send a word.");
        }
        await settings.renamePair(r, word);
        return replyMenu(
          ctx,
          deps,
          `✏️ "${word}" always links to [[${r.note}]]`,
          LINK_RULES(),
        );
      }
      default:
        return void (p satisfies never);
    }
  };
}
