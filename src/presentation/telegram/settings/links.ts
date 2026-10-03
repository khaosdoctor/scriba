import { type Context, InlineKeyboard } from "grammy";
import { notesFor } from "../../../domain/link-rule/entity.ts";
import { distinctSurfaces } from "../../../libs/links.ts";
import { logger } from "../../../libs/log.ts";
import { paginate } from "../../../libs/page.ts";
import { fitTelegram, previewList } from "../../../libs/text.ts";
import type {
  LinkPrompt,
  SettingsService,
} from "../../../services/settings.ts";
import type { Responder } from "../chat.ts";
import type { ViewDeps } from "../index.ts";
import { backTo, pagedScreen, withClose } from "../keyboard.ts";
import type { Tap } from "../namespace.ts";

const log = logger("menu");

const CLOSE = "menu:close";
const PAGE = 8;
const STOPWORD_PREVIEW = 40;

export type LinkDeps = Pick<ViewDeps, "settings" | "menus" | "ownerId">;

type Mode = "edit" | "send";

export function linkRulesTap(deps: LinkDeps) {
  const { settings } = deps;
  const prompt = async (
    responder: Responder,
    kind: LinkPrompt,
    gi?: number,
  ) => {
    await responder.ack("Answer the prompt below ↓");
    return settings.askLink(kind, gi);
  };
  return async (
    ctx: Tap,
    [action, arg, arg2]: string[],
    responder: Responder,
  ): Promise<void> => {
    switch (action) {
      case "links":
        await responder.ack();
        return home(ctx, settings);
      case "lsw":
        await responder.ack();
        return stopwordsStep(ctx, settings);
      case "lswa":
        return prompt(responder, "sw");
      case "lswl":
        await responder.ack();
        return stopwordPage(ctx, settings, Number(arg) || 0);
      case "lswd": {
        const gi = arg === undefined ? -1 : Number(arg);
        const word = (await settings.stopwords())[gi];
        if (word === undefined) {
          log.warn({ arg }, "link wizard: stopword index out of range");
          return void responder.ack("expired");
        }
        // Answer before the write, so a slow DB round-trip can't outlive Telegram's
        // callback-query window: the re-rendered page carries the result.
        await responder.ack();
        await settings.removeStopword(word);
        return stopwordPage(ctx, settings, Math.floor(gi / PAGE));
      }
      case "lrj":
        await responder.ack();
        return rejectedWords(ctx, settings, Number(arg) || 0);
      case "lrjs":
        await responder.ack();
        return rejectedNotes(ctx, settings, Number(arg), Number(arg2) || 0);
      case "lrju": {
        const list = await settings.rejections();
        const si = Number(arg);
        const surface = distinctSurfaces(list)[si];
        const note =
          surface === undefined
            ? undefined
            : notesFor(list, surface)[Number(arg2)];
        if (surface === undefined || note === undefined) {
          log.warn(
            { a: arg, b: arg2 },
            "link wizard: rejection index out of range",
          );
          return void responder.ack("expired");
        }
        await responder.ack();
        // The surface disappears from step 2 once its last note is freed, so fall back
        // there rather than re-rendering an empty note list.
        const left = await settings.unreject(surface, note);
        return left
          ? rejectedNotes(ctx, settings, si, Math.floor(Number(arg2) / PAGE))
          : rejectedWords(ctx, settings, Math.floor(si / PAGE));
      }
      case "lrg":
        await responder.ack();
        return pairsPage(ctx, settings, Number(arg) || 0);
      case "lrgv":
        await responder.ack();
        return pairDetail(ctx, settings, Number(arg));
      case "lrga":
        return prompt(responder, "rg");
      case "lrgd": {
        const gi = arg === undefined ? -1 : Number(arg);
        const pair = (await settings.pairs())[gi];
        if (!pair) {
          log.warn({ arg }, "link wizard: pair index out of range");
          return void responder.ack("expired");
        }
        // Answer before the write, so a slow DB round-trip can't outlive Telegram's
        // callback-query window: the re-rendered page carries the result.
        await responder.ack(`dropped ${pair.surface}`);
        await settings.removePair(pair);
        return pairsPage(ctx, settings, Math.floor(gi / PAGE));
      }
      case "lrgw":
        return prompt(responder, "rgw", Number(arg));
      case "lrgt": {
        const gi = Number(arg);
        const pair = (await settings.pairs())[gi];
        if (!pair) {
          log.warn({ gi }, "link wizard: retarget index out of range");
          return void responder.ack("expired");
        }
        await responder.ack();
        settings.retarget(pair);
        return notePicker(ctx, deps, "edit", 0);
      }
      case "lrgp": {
        const picked = settings.pick(Number(arg));
        if (!picked) return void responder.ack("expired");
        await responder.ack(`${picked.word} → ${picked.note}`);
        await settings.savePair(picked.word, picked.note);
        return advance(ctx, deps, "edit");
      }
      case "lrgn":
        await responder.ack();
        return notePicker(ctx, deps, "edit", Number(arg) || 0);
      case "lrgq":
        return prompt(responder, "rgn");
      case "lrgm":
        return prompt(responder, "rgm");
      case "lrgs":
        await responder.ack("skipped");
        return settings.skip() === undefined
          ? finished(ctx, deps, "edit")
          : notePicker(ctx, deps, "edit", 0);
      case "lrgc":
        await responder.ack("cancelled");
        settings.cancel();
        return pairsPage(ctx, settings, 0);
      default:
        log.warn({ action }, "unknown menu action");
        await responder.ack();
    }
  };
}

async function home(ctx: Tap, settings: SettingsService): Promise<void> {
  const { stopwords, rejections, pairs, index } = await settings.linkRules();
  const kb = new InlineKeyboard()
    .text(`🔗 Always link · ${pairs.length}`, "menu:lrg")
    .row()
    .text(`🔇 Never link · ${stopwords.length}`, "menu:lsw")
    .row()
    .text(`🚫 Rejected pairs · ${rejections.length}`, "menu:lrj:0")
    .row()
    .text("‹ Back", "menu:root");
  await ctx.editMessageText(
    [
      "🔗 Link rules — step 1 of 3",
      "",
      "Which rule do you want to change?",
      "",
      `🔗 ${pairs.length} word→note pair(s) always linked.`,
      `🔇 ${stopwords.length} word(s) never become a wikilink.`,
      `🚫 ${rejections.length} word→note pair(s) rejected.`,
      index.enabled
        ? `📇 vault index: ${index.aliases} alias(es) across ${index.files} note(s).`
        : "📇 vault index disabled — nothing is being linked.",
    ].join("\n"),
    { reply_markup: withClose(kb, CLOSE) },
  );
}

async function stopwordsStep(
  ctx: Tap,
  settings: SettingsService,
): Promise<void> {
  const stops = await settings.stopwords();
  const hidden = Math.max(0, stops.length - STOPWORD_PREVIEW);
  log.info({ stopwords: stops.length, hidden }, "link wizard: never-link step");
  const kb = new InlineKeyboard().text("➕ Add a word", "menu:lswa").row();
  if (stops.length) kb.text("🗑 Remove a word", "menu:lswl:0").row();
  kb.text("‹ Back", "menu:links");
  const lines = [
    "🔗 Link rules › 🔇 Never link — step 2 of 3",
    "",
    stops.length
      ? `${stops.length} word(s) are skipped as link candidates:`
      : "No never-link words yet.",
  ];
  if (stops.length) lines.push(previewList(stops, STOPWORD_PREVIEW));
  if (hidden)
    lines.push("", 'Tap "🗑 Remove a word" to page through all of them.');
  await ctx.editMessageText(fitTelegram(lines.join("\n")), {
    reply_markup: withClose(kb, CLOSE),
  });
}

async function stopwordPage(
  ctx: Tap,
  settings: SettingsService,
  page: number,
): Promise<void> {
  const stops = await settings.stopwords();
  if (!stops.length) {
    await ctx.editMessageText("🔇 No never-link words left.", {
      reply_markup: backTo("menu:lsw", CLOSE),
    });
    return;
  }
  const screen = pagedScreen({
    view: paginate(stops, page, PAGE),
    title: (view) =>
      [
        "🔗 Link rules › 🔇 Never link › 🗑 Remove — step 3 of 3",
        "",
        `Tap a word to let it be linked again.${view.pages > 1 ? ` (page ${view.page + 1}/${view.pages})` : ""}`,
      ].join("\n"),
    row: (kb, word, idx) =>
      kb.text(`🗑 ${word}`.slice(0, 60), `menu:lswd:${idx}`),
    nav: (target) => `menu:lswl:${target}`,
    back: { text: "‹ Back", data: "menu:lsw" },
  });
  await ctx.editMessageText(screen.text, {
    reply_markup: withClose(screen.kb, CLOSE),
  });
}

async function rejectedWords(
  ctx: Tap,
  settings: SettingsService,
  page: number,
): Promise<void> {
  const list = await settings.rejections();
  if (!list.length) {
    await ctx.editMessageText("🚫 No rejected links.", {
      reply_markup: backTo("menu:links", CLOSE),
    });
    return;
  }
  const screen = pagedScreen({
    view: paginate(distinctSurfaces(list), page, PAGE),
    title: (view) =>
      [
        "🔗 Link rules › 🚫 Rejected pairs — step 2 of 3",
        "",
        `Pick the word whose rejection you want to undo.${view.pages > 1 ? ` (page ${view.page + 1}/${view.pages})` : ""}`,
      ].join("\n"),
    row: (kb, surface, idx) => {
      const count = notesFor(list, surface).length;
      kb.text(
        `🚫 ${surface} · ${count} note(s)`.slice(0, 60),
        `menu:lrjs:${idx}`,
      );
    },
    nav: (target) => `menu:lrj:${target}`,
    back: { text: "‹ Back", data: "menu:links" },
  });
  await ctx.editMessageText(screen.text, {
    reply_markup: withClose(screen.kb, CLOSE),
  });
}

async function rejectedNotes(
  ctx: Tap,
  settings: SettingsService,
  si: number,
  page: number,
): Promise<void> {
  const list = await settings.rejections();
  const surface = distinctSurfaces(list)[si];
  if (surface === undefined) {
    log.warn({ si }, "link wizard: surface index out of range");
    return rejectedWords(ctx, settings, 0);
  }
  const notes = notesFor(list, surface);
  // Row indices stay global so the undo resolves them against the whole note list.
  const screen = pagedScreen({
    view: paginate(notes, page, PAGE),
    title: (view) =>
      [
        `🔗 Link rules › 🚫 ${surface} — step 3 of 3`,
        "",
        `${notes.length} note(s) rejected. Tap one to let "${surface}" link to it again.${view.pages > 1 ? ` (page ${view.page + 1}/${view.pages})` : ""}`,
      ].join("\n"),
    row: (kb, note, idx) =>
      kb.text(`↩️ ${note}`.slice(0, 60), `menu:lrju:${si}:${idx}`),
    nav: (target) => `menu:lrjs:${si}:${target}`,
    back: { text: "‹ Back", data: `menu:lrj:${Math.floor(si / PAGE)}` },
  });
  await ctx.editMessageText(screen.text, {
    reply_markup: withClose(screen.kb, CLOSE),
  });
}

async function pairsPage(
  ctx: Context,
  settings: SettingsService,
  page: number,
): Promise<void> {
  const forced = await settings.pairs();
  log.info({ forced: forced.length, page }, "link wizard: always-link step");
  const screen = pagedScreen({
    kb: new InlineKeyboard().text("➕ Add word(s)", "menu:lrga").row(),
    view: paginate(forced, page, PAGE),
    title: (view) =>
      [
        "🔗 Link rules › 🔗 Always link — step 2 of 3",
        "",
        forced.length
          ? `${forced.length} pair(s) linked with no judgment call. Tap one to change it.${view.pages > 1 ? ` (page ${view.page + 1}/${view.pages})` : ""}`
          : "No always-link pairs yet.",
      ].join("\n"),
    row: (kb, pair, idx) =>
      kb.text(
        `${pair.surface} → ${pair.note}`.slice(0, 60),
        `menu:lrgv:${idx}`,
      ),
    nav: (target) => `menu:lrg:${target}`,
    back: { text: "‹ Back", data: "menu:links" },
  });
  await ctx.editMessageText(screen.text, {
    reply_markup: withClose(screen.kb, CLOSE),
  });
}

async function pairDetail(
  ctx: Tap,
  settings: SettingsService,
  gi: number,
): Promise<void> {
  const pair = (await settings.pairs())[gi];
  if (!pair) {
    log.warn({ gi }, "link wizard: pair index out of range");
    return pairsPage(ctx, settings, 0);
  }
  const kb = new InlineKeyboard()
    .text("🔁 Change note", `menu:lrgt:${gi}`)
    .row()
    .text("✏️ Rename word", `menu:lrgw:${gi}`)
    .row()
    .text("🗑 Delete pair", `menu:lrgd:${gi}`)
    .row()
    .text("‹ Back", `menu:lrg:${Math.floor(gi / PAGE)}`);
  await ctx.editMessageText(
    [
      `🔗 Link rules › 🔗 Always link › ${pair.surface} — step 3 of 3`,
      "",
      `"${pair.surface}" always links to [[${pair.note}]].`,
    ].join("\n"),
    { reply_markup: withClose(kb, CLOSE) },
  );
}

export async function notePicker(
  ctx: Context,
  deps: LinkDeps,
  mode: Mode,
  page: number,
): Promise<void> {
  const shown = deps.settings.picker(page);
  if (shown === "expired")
    return void ctx.reply("That link flow expired — reopen /menu.");
  if (shown === "done") return finished(ctx, deps, mode);
  const { word, query, total, view, nth, of } = shown;
  const queue = of > 1 ? ` (word ${nth} of ${of})` : "";
  const { text, kb } = pagedScreen({
    view,
    title: (pageView) =>
      [
        `🔗 "${word}" → which note?${queue}`,
        "",
        total
          ? `${total} match(es) for "${query}"${pageView.pages > 1 ? `, page ${pageView.page + 1}/${pageView.pages}` : ""}. Tap one, or search again.`
          : `Nothing in the vault matches "${query}". Search again with another part of the title.`,
      ].join("\n"),
    // A pick resolves against the remembered page, so the callback carries the index
    // within the page.
    row: (kb, note, idx) =>
      kb.text(`📝 ${note}`.slice(0, 60), `menu:lrgp:${idx - view.offset}`),
    nav: (target) => `menu:lrgn:${target}`,
    extraRows: (kb) => {
      kb.text("🔎 Search by another name", "menu:lrgq").row();
      kb.text("✍️ Type a note that doesn't exist yet", "menu:lrgm").row();
      if (of > 1) kb.text("⏭ Skip this word", "menu:lrgs");
      kb.text("✖ Cancel", "menu:lrgc");
    },
  });
  if (mode === "edit") {
    await ctx.editMessageText(text, { reply_markup: withClose(kb, CLOSE) });
    return;
  }
  return sendMenu(ctx, deps, text, kb);
}

export async function advance(
  ctx: Context,
  deps: LinkDeps,
  mode: Mode,
): Promise<void> {
  if (deps.settings.advance() === undefined) return finished(ctx, deps, mode);
  return notePicker(ctx, deps, mode, 0);
}

async function finished(
  ctx: Context,
  deps: LinkDeps,
  mode: Mode,
): Promise<void> {
  if (mode === "edit") return pairsPage(ctx, deps.settings, 0);
  // Arrived from a reply, so there's no menu message here to edit: send a fresh one.
  await sendMenu(
    ctx,
    deps,
    "🔗 Always-link rules updated.",
    new InlineKeyboard().text("🔗 Link rules", "menu:links"),
  );
}

async function sendMenu(
  ctx: Context,
  deps: LinkDeps,
  text: string,
  kb: InlineKeyboard,
): Promise<void> {
  const sent = await ctx.api.sendMessage(deps.ownerId, text, {
    reply_markup: withClose(kb, CLOSE),
  });
  deps.menus.touch(sent.chat.id, sent.message_id);
}

export async function replyMenu(
  ctx: Context,
  deps: LinkDeps,
  text: string,
  kb: InlineKeyboard,
): Promise<void> {
  const sent = await ctx.reply(text, { reply_markup: withClose(kb, CLOSE) });
  deps.menus.touch(sent.chat.id, sent.message_id);
}
