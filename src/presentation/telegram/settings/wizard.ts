import { InlineKeyboard } from "grammy";
import { parseEntrySize } from "../../../domain/setting/entity.ts";
import { cleanNoteTitle, parseRuleWords } from "../../../libs/links.ts";
import { logger } from "../../../libs/log.ts";
import { parseClockTime } from "../../../libs/time.ts";
import { parseWizardRef, type WizardPrompt } from "../../../libs/wizard.ts";
import type {
  SettingsPrompt,
  SettingsService,
} from "../../../services/settings.ts";
import { Responder } from "../chat.ts";
import type { ViewDeps } from "../index.ts";
import type { TextReply } from "../namespace.ts";
import { advance, type LinkDeps, notePicker, replyMenu } from "./links.ts";
import { FLOW_EXPIRED, MODELS, menu, NOTHING_TO_ADD } from "./menu-data.ts";

const log = logger("menu");

interface Reply {
  warn: string;
  invalid: string;
  button: [label: string, data: string];
  apply(settings: SettingsService, body: string): Promise<string | null>;
}

const model = (which: "em" | "vfm"): Reply => {
  const { key, label, button } = MODELS[which];
  return {
    warn: "menu: empty model reply",
    invalid: "Send a model ID (e.g. claude-sonnet-5-5).",
    button,
    async apply(settings, body) {
      const id = body.trim();
      if (!id) return null;
      await settings.setModel(key, id, "menu: model changed via text");
      return `🧠 ${label} model: ${id}`;
    },
  };
};

const REPLIES: Record<SettingsPrompt, Reply> = {
  es: {
    warn: "menu: unusable entry size reply",
    invalid: 'Give me a whole number between 40 and 4000, or "off".',
    button: ["✂️ Entry size", menu("esz")],
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
    button: ["🗂 Menu", menu("root")],
    async apply(settings, body) {
      const time = parseClockTime(body);
      if (!time) return null;
      await settings.setRatingTime(time);
      return `🕛 nightly rating at ${time}`;
    },
  },
  em: model("em"),
  vfm: model("vfm"),
};

export function parseSettingsRef(prompt: string): SettingsPrompt | null {
  const kind = parseWizardRef(prompt)?.kind;
  return kind !== undefined && kind in REPLIES
    ? (kind as SettingsPrompt)
    : null;
}

type LinkRef = Exclude<WizardPrompt, { kind: SettingsPrompt }>;

export function parseLinkRef(prompt: string): LinkRef | null {
  const ref = parseWizardRef(prompt);
  return ref !== null && !(ref.kind in REPLIES) ? (ref as LinkRef) : null;
}

export function wizardReply(deps: ViewDeps) {
  return async (ctx: TextReply, kind: SettingsPrompt) => {
    const reply = REPLIES[kind];
    const body = ctx.message.text;
    const done = await reply.apply(deps.settings, body);
    if (done === null) {
      log.warn({ body }, reply.warn);
      await new Responder(ctx).reply(reply.invalid);
      return;
    }
    await replyMenu(
      ctx,
      deps,
      done,
      new InlineKeyboard().text(...reply.button),
    );
  };
}

const LINK_RULES = () =>
  new InlineKeyboard().text("🔗 Link rules", menu("links"));

export function linkReply(deps: LinkDeps) {
  const { settings } = deps;
  return async (ctx: TextReply, ref: LinkRef) => {
    const body = ctx.message.text;
    switch (ref.kind) {
      case "sw": {
        const words = parseRuleWords(body);
        if (!words.length) {
          log.warn({ body }, "link wizard: empty never-link reply");
          return void ctx.reply(NOTHING_TO_ADD);
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
          return void ctx.reply(NOTHING_TO_ADD);
        }
        settings.queueWords(words);
        return notePicker(ctx, deps, "send", 0);
      }
      case "rgn": {
        if (!settings.search(cleanNoteTitle(body))) {
          log.warn("link wizard: search reply with no pending flow");
          return void ctx.reply(FLOW_EXPIRED);
        }
        return notePicker(ctx, deps, "send", 0);
      }
      case "rgm": {
        const word = settings.currentWord();
        if (word === undefined) {
          log.warn("link wizard: manual note reply with no pending flow");
          return void ctx.reply(FLOW_EXPIRED);
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
        const pair = (await settings.pairs())[ref.index];
        if (!pair) {
          log.warn({ index: ref.index }, "link wizard: rename target is gone");
          return void ctx.reply("That pair is gone — reopen /menu.");
        }
        const [word] = parseRuleWords(body, 1);
        if (!word) {
          log.warn({ body }, "link wizard: empty rename reply");
          return void ctx.reply("Nothing to rename to — send a word.");
        }
        await settings.renamePair(pair, word);
        return replyMenu(
          ctx,
          deps,
          `✏️ "${word}" always links to [[${pair.note}]]`,
          LINK_RULES(),
        );
      }
      default:
        return void (ref satisfies never);
    }
  };
}
