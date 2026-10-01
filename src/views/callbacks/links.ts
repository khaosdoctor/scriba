import { type Context, InlineKeyboard } from "grammy";
import type {
  LinkPrompt,
  SettingsController,
} from "../../controllers/settings.ts";
import { previewList } from "../../core.ts";
import { distinctSurfaces } from "../../lib/links.ts";
import { logger } from "../../lib/log.ts";
import { paginate } from "../../lib/page.ts";
import { fitTelegram } from "../../lib/text.ts";
import type { ViewDeps } from "../index.ts";
import { backTo, pagedScreen, withClose } from "../render/keyboard.ts";
import type { Tap } from "./namespace.ts";

const log = logger("menu");

const CLOSE = "menu:close";
// Rows per page of the never-link, rejected and always-link lists.
const PAGE = 8;
// Never-link words named inline on the step-2 summary. Anything past this is counted,
// not dropped: the full list is one tap away on "🗑 Remove a word", which pages.
const STOPWORD_PREVIEW = 40;

export type LinkDeps = Pick<ViewDeps, "settings" | "menus" | "ownerId">;

/** "edit" redraws the tapped menu; "send" posts a fresh one, which a reply needs because
 *  it arrives as a new message with nothing in place to edit. */
type Mode = "edit" | "send";

/** `menu:l*`: the link-rules wizard. Step 1 picks the rule kind, step 2 the word, step 3
 *  the note (or the removal). Rows index into lists re-derived on every tap, so an index
 *  that no longer resolves answers "expired" instead of acting on the wrong row. Free
 *  text comes back through a force-reply prompt (replies/wizard.ts). Any other `menu:`
 *  action ends here and is answered empty. */
export function linkRulesTap(deps: LinkDeps) {
  const { settings } = deps;
  const prompt = async (ctx: Tap, kind: LinkPrompt, gi?: number) => {
    await ctx.answerCallbackQuery({ text: "Answer the prompt below ↓" });
    return settings.askLink(kind, gi);
  };
  return async (ctx: Tap, [action, arg, arg2]: string[]): Promise<void> => {
    switch (action) {
      case "links":
        await ctx.answerCallbackQuery();
        return home(ctx, settings);
      case "lsw":
        await ctx.answerCallbackQuery();
        return stopwordsStep(ctx, settings);
      case "lswa":
        return prompt(ctx, "sw");
      case "lswl":
        await ctx.answerCallbackQuery();
        return stopwordPage(ctx, settings, Number(arg) || 0);
      case "lswd": {
        const gi = arg === undefined ? -1 : Number(arg);
        const word = (await settings.stopwords())[gi];
        if (word === undefined) {
          log.warn({ arg }, "link wizard: stopword index out of range");
          return void ctx.answerCallbackQuery({ text: "expired" });
        }
        // Answer before the write, so a slow DB round-trip can't outlive Telegram's
        // callback-query window: the re-rendered page carries the result.
        await ctx.answerCallbackQuery();
        await settings.removeStopword(word);
        return stopwordPage(ctx, settings, Math.floor(gi / PAGE));
      }
      case "lrj":
        await ctx.answerCallbackQuery();
        return rejectedWords(ctx, settings, Number(arg) || 0);
      case "lrjs":
        await ctx.answerCallbackQuery();
        return rejectedNotes(ctx, settings, Number(arg), Number(arg2) || 0);
      case "lrju": {
        const list = await settings.rejections();
        const si = Number(arg);
        const surface = distinctSurfaces(list)[si];
        const note =
          surface === undefined
            ? undefined
            : list.filter((r) => r.surface === surface).map((r) => r.note)[
                Number(arg2)
              ];
        if (surface === undefined || note === undefined) {
          log.warn(
            { a: arg, b: arg2 },
            "link wizard: rejection index out of range",
          );
          return void ctx.answerCallbackQuery({ text: "expired" });
        }
        await ctx.answerCallbackQuery();
        // The surface disappears from step 2 once its last note is freed, so fall back
        // there rather than re-rendering an empty note list.
        const left = await settings.unreject(surface, note);
        return left
          ? rejectedNotes(ctx, settings, si, Math.floor(Number(arg2) / PAGE))
          : rejectedWords(ctx, settings, Math.floor(si / PAGE));
      }
      case "lrg":
        await ctx.answerCallbackQuery();
        return pairsPage(ctx, settings, Number(arg) || 0);
      case "lrgv":
        await ctx.answerCallbackQuery();
        return pairDetail(ctx, settings, Number(arg));
      case "lrga":
        return prompt(ctx, "rg");
      case "lrgd": {
        const gi = arg === undefined ? -1 : Number(arg);
        const r = (await settings.pairs())[gi];
        if (!r) {
          log.warn({ arg }, "link wizard: pair index out of range");
          return void ctx.answerCallbackQuery({ text: "expired" });
        }
        // Answer before the write, so a slow DB round-trip can't outlive Telegram's
        // callback-query window: the re-rendered page carries the result.
        await ctx.answerCallbackQuery({ text: `dropped ${r.surface}` });
        await settings.removePair(r);
        return pairsPage(ctx, settings, Math.floor(gi / PAGE));
      }
      case "lrgw":
        return prompt(ctx, "rgw", Number(arg));
      case "lrgt": {
        const gi = Number(arg);
        const r = (await settings.pairs())[gi];
        if (!r) {
          log.warn({ gi }, "link wizard: retarget index out of range");
          return void ctx.answerCallbackQuery({ text: "expired" });
        }
        await ctx.answerCallbackQuery();
        settings.retarget(r);
        return notePicker(ctx, deps, "edit", 0);
      }
      case "lrgp": {
        const picked = settings.pick(Number(arg));
        if (!picked) return void ctx.answerCallbackQuery({ text: "expired" });
        await ctx.answerCallbackQuery({
          text: `${picked.word} → ${picked.note}`,
        });
        await settings.savePair(picked.word, picked.note);
        return advance(ctx, deps, "edit");
      }
      case "lrgn":
        await ctx.answerCallbackQuery();
        return notePicker(ctx, deps, "edit", Number(arg) || 0);
      case "lrgq":
        return prompt(ctx, "rgn");
      case "lrgm":
        return prompt(ctx, "rgm");
      case "lrgs":
        await ctx.answerCallbackQuery({ text: "skipped" });
        return settings.skip() === undefined
          ? finished(ctx, deps, "edit")
          : notePicker(ctx, deps, "edit", 0);
      case "lrgc":
        await ctx.answerCallbackQuery({ text: "cancelled" });
        settings.cancel();
        return pairsPage(ctx, settings, 0);
      default:
        log.warn({ action }, "unknown menu action");
        await ctx.answerCallbackQuery();
    }
  };
}

/** Step 1: which kind of link rule to change, with live counts and index health. */
async function home(ctx: Tap, settings: SettingsController): Promise<void> {
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

/** Step 2 (never-link): add a word, or go on to pick one to drop. */
async function stopwordsStep(
  ctx: Tap,
  settings: SettingsController,
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
  // A summary, not the list: previewList names the leftovers instead of cutting them
  // off, and "🗑 Remove a word" pages through every word.
  if (stops.length) lines.push(previewList(stops, STOPWORD_PREVIEW));
  if (hidden)
    lines.push("", 'Tap "🗑 Remove a word" to page through all of them.');
  await ctx.editMessageText(fitTelegram(lines.join("\n")), {
    reply_markup: withClose(kb, CLOSE),
  });
}

/** Step 3 (never-link): one page of words, tap to allow linking again. */
async function stopwordPage(
  ctx: Tap,
  settings: SettingsController,
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
    title: (v) =>
      [
        "🔗 Link rules › 🔇 Never link › 🗑 Remove — step 3 of 3",
        "",
        `Tap a word to let it be linked again.${v.pages > 1 ? ` (page ${v.page + 1}/${v.pages})` : ""}`,
      ].join("\n"),
    row: (kb, w, i) => kb.text(`🗑 ${w}`.slice(0, 60), `menu:lswd:${i}`),
    nav: (p) => `menu:lswl:${p}`,
    back: { text: "‹ Back", data: "menu:lsw" },
  });
  await ctx.editMessageText(screen.text, {
    reply_markup: withClose(screen.kb, CLOSE),
  });
}

/** Step 2 (rejections): one page of rejected words. */
async function rejectedWords(
  ctx: Tap,
  settings: SettingsController,
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
    title: (v) =>
      [
        "🔗 Link rules › 🚫 Rejected pairs — step 2 of 3",
        "",
        `Pick the word whose rejection you want to undo.${v.pages > 1 ? ` (page ${v.page + 1}/${v.pages})` : ""}`,
      ].join("\n"),
    row: (kb, s, i) => {
      const n = list.filter((r) => r.surface === s).length;
      kb.text(`🚫 ${s} · ${n} note(s)`.slice(0, 60), `menu:lrjs:${i}`);
    },
    nav: (p) => `menu:lrj:${p}`,
    back: { text: "‹ Back", data: "menu:links" },
  });
  await ctx.editMessageText(screen.text, {
    reply_markup: withClose(screen.kb, CLOSE),
  });
}

/** Step 3 (rejections): the notes rejected for surface `si`, tap one to allow it. Paged
 *  like every other row list: one surface can carry more rejected notes than fit in a
 *  single keyboard, and a word rejected everywhere is exactly the one you come here to
 *  fix. */
async function rejectedNotes(
  ctx: Tap,
  settings: SettingsController,
  si: number,
  page: number,
): Promise<void> {
  const list = await settings.rejections();
  const surface = distinctSurfaces(list)[si];
  if (surface === undefined) {
    log.warn({ si }, "link wizard: surface index out of range");
    return rejectedWords(ctx, settings, 0);
  }
  const notes = list.filter((r) => r.surface === surface).map((r) => r.note);
  // Row indices stay global so the undo resolves them against the whole note list.
  const screen = pagedScreen({
    view: paginate(notes, page, PAGE),
    title: (v) =>
      [
        `🔗 Link rules › 🚫 ${surface} — step 3 of 3`,
        "",
        `${notes.length} note(s) rejected. Tap one to let "${surface}" link to it again.${v.pages > 1 ? ` (page ${v.page + 1}/${v.pages})` : ""}`,
      ].join("\n"),
    row: (kb, n, i) => kb.text(`↩️ ${n}`.slice(0, 60), `menu:lrju:${si}:${i}`),
    nav: (p) => `menu:lrjs:${si}:${p}`,
    back: { text: "‹ Back", data: `menu:lrj:${Math.floor(si / PAGE)}` },
  });
  await ctx.editMessageText(screen.text, {
    reply_markup: withClose(screen.kb, CLOSE),
  });
}

/** Step 2 (always-link): one page of pairs. Tap a pair to edit or drop it. */
async function pairsPage(
  ctx: Context,
  settings: SettingsController,
  page: number,
): Promise<void> {
  const forced = await settings.pairs();
  log.info({ forced: forced.length, page }, "link wizard: always-link step");
  const screen = pagedScreen({
    kb: new InlineKeyboard().text("➕ Add word(s)", "menu:lrga").row(),
    view: paginate(forced, page, PAGE),
    title: (v) =>
      [
        "🔗 Link rules › 🔗 Always link — step 2 of 3",
        "",
        forced.length
          ? `${forced.length} pair(s) linked with no judgment call. Tap one to change it.${v.pages > 1 ? ` (page ${v.page + 1}/${v.pages})` : ""}`
          : "No always-link pairs yet.",
      ].join("\n"),
    row: (kb, r, i) =>
      kb.text(`${r.surface} → ${r.note}`.slice(0, 60), `menu:lrgv:${i}`),
    nav: (p) => `menu:lrg:${p}`,
    back: { text: "‹ Back", data: "menu:links" },
  });
  await ctx.editMessageText(screen.text, {
    reply_markup: withClose(screen.kb, CLOSE),
  });
}

/** Step 3 (always-link): what you can do to one pair, retarget, rename, or drop. */
async function pairDetail(
  ctx: Tap,
  settings: SettingsController,
  gi: number,
): Promise<void> {
  const r = (await settings.pairs())[gi];
  if (!r) {
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
      `🔗 Link rules › 🔗 Always link › ${r.surface} — step 3 of 3`,
      "",
      `"${r.surface}" always links to [[${r.note}]].`,
    ].join("\n"),
    { reply_markup: withClose(kb, CLOSE) },
  );
}

/** The note picker: search results from the vault index as tappable rows. */
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
    title: (v) =>
      [
        `🔗 "${word}" → which note?${queue}`,
        "",
        total
          ? `${total} match(es) for "${query}"${v.pages > 1 ? `, page ${v.page + 1}/${v.pages}` : ""}. Tap one, or search again.`
          : `Nothing in the vault matches "${query}". Search again with another part of the title.`,
      ].join("\n"),
    // A pick resolves against the remembered page, so the callback carries the index
    // within the page.
    row: (kb, note, i) =>
      kb.text(`📝 ${note}`.slice(0, 60), `menu:lrgp:${i - view.offset}`),
    nav: (n) => `menu:lrgn:${n}`,
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

/** After a pair is saved: the next queued word gets its own picker, an empty queue ends
 *  the flow. */
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

/** Send a menu screen of our own (not an edit of a tapped one) and start its countdown. */
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

/** A confirmation that closes a wizard branch. It is still part of the menu, so it gets
 *  the same Close button and the same countdown. */
export async function replyMenu(
  ctx: Context,
  deps: LinkDeps,
  text: string,
  kb: InlineKeyboard,
): Promise<void> {
  const sent = await ctx.reply(text, { reply_markup: withClose(kb, CLOSE) });
  deps.menus.touch(sent.chat.id, sent.message_id);
}
