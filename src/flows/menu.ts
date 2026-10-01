import { type Bot, InlineKeyboard } from "grammy";
import { config } from "../config.ts";
import {
  cleanNoteTitle,
  distinctSurfaces,
  fitTelegram,
  formatJotDetail,
  jotPreview,
  noteSuggestions,
  parseRuleWords,
  parseWizardRef,
  previewList,
  STATUS_ICON,
  WIZARD_NEWNOTE_REF,
  WIZARD_NOTE_REF,
  WIZARD_REGISTER_REF,
  WIZARD_RENAME_REF,
  WIZARD_STOPWORD_REF,
} from "../core.ts";
import type { Jot, Repository } from "../db.ts";
import { paginate } from "../lib/page.ts";
import { logger } from "../log.ts";
import type { FlushQueue } from "../runtime/queue.ts";
import type { VaultService } from "../services/vault.ts";
import type { MenuLifetime } from "../views/menu-lifetime.ts";
import { backTo, pagedScreen, withClose } from "../views/render/keyboard.ts";

const log = logger("menu");

/** Every menu screen carries the same way out, so a half-finished flow never needs scrolling back. */
const CLOSE = "menu:close";

/** What the menu acts on. Transitional: it goes with the menu's own controller. */
export interface MenuDeps {
  repo: Repository;
  queue: FlushQueue;
  links: VaultService;
}

/** The link-rules wizard and the jots browser of the /menu control panel. The settings
 *  screens are a view of their own; `menu:` taps they do not name are routed here. */
export class MenuController {
  // Rejected-links menu page size (rows per page).
  private static readonly REJECT_PAGE = 8;
  // Never-link words named inline on the step-2 summary. Anything past this is counted,
  // not dropped — the full list is one tap away on "🗑 Remove a word", which pages.
  private static readonly STOPWORD_PREVIEW = 40;
  // Note-search page size. Smaller than REJECT_PAGE: note titles are long, and a wall of
  // them is exactly the "hard to find things" problem the picker exists to solve.
  private static readonly PICK_PAGE = 6;
  // The one place the wizard keeps state between messages: picking the note side means
  // searching a vault of thousands, which cannot ride in 64 bytes of callback data.
  // In memory and single-flow: one user, and a restart just drops a half-finished add.
  private pending?: {
    words: string[]; // surfaces still waiting for a note
    i: number; // which one we're on
    query: string; // current search text (seeded with the word itself)
    page: number;
    retarget?: { surface: string; note: string }; // pair being replaced, if editing
  };

  constructor(
    private bot: Bot,
    private menus: MenuLifetime,
    private getDeps: () => MenuDeps,
    private deleteJot: (jot: Jot) => Promise<string>,
  ) {}

  /** Dispatch a `menu:<action>[:<arg>]` callback the settings view did not take. */
  async handleCallback(ctx: any, rest: string[]): Promise<void> {
    const [action, arg, arg2] = rest;
    switch (action) {
      case "jots":
        return this.menuJots(ctx);
      case "jot":
        return this.menuJotDetail(ctx, arg);
      case "jr":
        return this.menuJotRetry(ctx, arg);
      case "jd":
        return this.menuJotDeleteConfirm(ctx, arg);
      case "jdy":
        return this.menuJotDelete(ctx, arg);
      case "je":
        return this.menuJotEdit(ctx, arg);
      // --- link-rules wizard (see the `lw` block below) ---
      case "links":
        return this.lwHome(ctx);
      case "lsw":
        return this.lwStopwords(ctx);
      case "lswa":
        return this.lwPrompt(ctx, "sw");
      case "lswl":
        await ctx.answerCallbackQuery();
        return this.lwStopwordPage(ctx, Number(arg) || 0);
      case "lswd":
        return this.lwStopwordDelete(ctx, arg);
      case "lrj":
        await ctx.answerCallbackQuery();
        return this.lwRejectedWords(ctx, Number(arg) || 0);
      case "lrjs":
        await ctx.answerCallbackQuery();
        return this.lwRejectedNotes(ctx, Number(arg), Number(arg2) || 0);
      case "lrju":
        return this.lwUnreject(ctx, arg, arg2);
      case "lrg":
        await ctx.answerCallbackQuery();
        return this.lwPairs(ctx, Number(arg) || 0);
      case "lrgv":
        await ctx.answerCallbackQuery();
        return this.lwPairDetail(ctx, Number(arg));
      case "lrga":
        return this.lwPrompt(ctx, "rg");
      case "lrgd":
        return this.lwPairDelete(ctx, arg);
      case "lrgw":
        return this.lwPrompt(ctx, "rgw", Number(arg));
      case "lrgt":
        return this.lwRetarget(ctx, Number(arg));
      case "lrgp":
        return this.lwPick(ctx, Number(arg));
      case "lrgn":
        await ctx.answerCallbackQuery();
        return this.showNotePicker(ctx, "edit", Number(arg) || 0);
      case "lrgq":
        return this.lwPrompt(ctx, "rgn");
      case "lrgm":
        return this.lwPrompt(ctx, "rgm");
      case "lrgs":
        return this.lwSkip(ctx);
      case "lrgc":
        return this.lwCancel(ctx);
      default:
        log.warn({ action }, "unknown menu action");
        await ctx.answerCallbackQuery();
    }
  }

  // --- link-rules wizard ---
  // The three ways to steer the enricher's wikilinks, as one guided flow instead of a
  // pile of typed commands: step 1 picks the rule kind, step 2 the word, step 3 the note
  // (or the removal). Every screen carries a breadcrumb and a step counter.
  //
  // No state is held between taps. Rows index into deterministically ordered lists that
  // are re-derived on every callback, so an index that no longer resolves answers
  // "expired" instead of acting on the wrong row. Adding a rule needs free text, which a
  // keyboard can't collect, so those two leaves send a force-reply prompt and route the
  // answer back by the marker in the prompt text (see parseWizardRef in core.ts).

  /** Step 1 — which kind of link rule to change, with live counts and index health. */
  private async lwHome(ctx: any): Promise<void> {
    await ctx.answerCallbackQuery();
    const { repo, links } = this.getDeps();
    const [stops, rejects, forced] = await Promise.all([
      repo.stopwordList(),
      repo.rejectionList(),
      repo.registeredLinks(),
    ]);
    const idx = links.stats();
    log.info(
      {
        stopwords: stops.length,
        rejections: rejects.length,
        forced: forced.length,
      },
      "link wizard: step 1",
    );
    const kb = new InlineKeyboard()
      .text(`🔗 Always link · ${forced.length}`, "menu:lrg")
      .row()
      .text(`🔇 Never link · ${stops.length}`, "menu:lsw")
      .row()
      .text(`🚫 Rejected pairs · ${rejects.length}`, "menu:lrj:0")
      .row()
      .text("‹ Back", "menu:root");
    await ctx.editMessageText(
      [
        "🔗 Link rules — step 1 of 3",
        "",
        "Which rule do you want to change?",
        "",
        `🔗 ${forced.length} word→note pair(s) always linked.`,
        `🔇 ${stops.length} word(s) never become a wikilink.`,
        `🚫 ${rejects.length} word→note pair(s) rejected.`,
        idx.enabled
          ? `📇 vault index: ${idx.aliases} alias(es) across ${idx.files} note(s).`
          : "📇 vault index disabled — nothing is being linked.",
      ].join("\n"),
      { reply_markup: withClose(kb, CLOSE) },
    );
  }

  /** Step 2 (never-link) — add a word, or go on to pick one to drop. */
  private async lwStopwords(ctx: any): Promise<void> {
    await ctx.answerCallbackQuery();
    const stops = await this.getDeps().repo.stopwordList();
    const preview = MenuController.STOPWORD_PREVIEW;
    const hidden = Math.max(0, stops.length - preview);
    log.info(
      { stopwords: stops.length, hidden },
      "link wizard: never-link step",
    );
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
    if (stops.length) lines.push(previewList(stops, preview));
    if (hidden)
      lines.push("", 'Tap "🗑 Remove a word" to page through all of them.');
    await ctx.editMessageText(fitTelegram(lines.join("\n")), {
      reply_markup: withClose(kb, CLOSE),
    });
  }

  /** Step 3 (never-link) — one page of words, tap to allow linking again. */
  private async lwStopwordPage(ctx: any, page = 0): Promise<void> {
    const PAGE = MenuController.REJECT_PAGE;
    const stops = await this.getDeps().repo.stopwordList();
    if (!stops.length)
      return ctx.editMessageText("🔇 No never-link words left.", {
        reply_markup: backTo("menu:lsw", CLOSE),
      });
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

  /** Drop the never-link word at global index `arg`, then re-render its page. */
  private async lwStopwordDelete(ctx: any, arg?: string): Promise<void> {
    const { repo } = this.getDeps();
    const stops = await repo.stopwordList();
    const gi = arg === undefined ? -1 : Number(arg);
    const word = stops[gi];
    if (word === undefined) {
      log.warn({ arg }, "link wizard: stopword index out of range");
      return void ctx.answerCallbackQuery({ text: "expired" });
    }
    // Answer before the write, so a slow DB round-trip can't outlive Telegram's
    // callback-query window — the re-rendered page carries the result.
    await ctx.answerCallbackQuery();
    const n = await repo.delStopword(word);
    log.info({ word, removed: n }, "link wizard: never-link word removed");
    return this.lwStopwordPage(
      ctx,
      Math.floor(gi / MenuController.REJECT_PAGE),
    );
  }

  /** Step 2 (rejections) — one page of rejected words. */
  private async lwRejectedWords(ctx: any, page = 0): Promise<void> {
    const PAGE = MenuController.REJECT_PAGE;
    const list = await this.getDeps().repo.rejectionList();
    if (!list.length)
      return ctx.editMessageText("🚫 No rejected links.", {
        reply_markup: backTo("menu:links", CLOSE),
      });
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

  /** Step 3 (rejections) — the notes rejected for surface `si`, tap one to allow it.
   *  Paged like every other row list: one surface can carry more rejected notes than fit
   *  in a single keyboard, and a word rejected everywhere is exactly the one you come
   *  here to fix. */
  private async lwRejectedNotes(ctx: any, si: number, page = 0): Promise<void> {
    const PAGE = MenuController.REJECT_PAGE;
    const list = await this.getDeps().repo.rejectionList();
    const surface = distinctSurfaces(list)[si];
    if (surface === undefined) {
      log.warn({ si }, "link wizard: surface index out of range");
      return this.lwRejectedWords(ctx, 0);
    }
    const notes = list.filter((r) => r.surface === surface).map((r) => r.note);
    // Row indices stay global so lwUnreject resolves them against the whole note list.
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
      back: {
        text: "‹ Back",
        data: `menu:lrj:${Math.floor(si / MenuController.REJECT_PAGE)}`,
      },
    });
    await ctx.editMessageText(screen.text, {
      reply_markup: withClose(screen.kb, CLOSE),
    });
  }

  /** Undo the surface→note rejection at (`a`, `b`), then re-render where it came from. */
  private async lwUnreject(ctx: any, a?: string, b?: string): Promise<void> {
    const { repo } = this.getDeps();
    const list = await repo.rejectionList();
    const si = Number(a);
    const surface = distinctSurfaces(list)[si];
    const note =
      surface === undefined
        ? undefined
        : list.filter((r) => r.surface === surface).map((r) => r.note)[
            Number(b)
          ];
    if (surface === undefined || note === undefined) {
      log.warn({ a, b }, "link wizard: rejection index out of range");
      return void ctx.answerCallbackQuery({ text: "expired" });
    }
    await ctx.answerCallbackQuery();
    const n = await repo.unreject(surface, note);
    log.info({ surface, note, removed: n }, "link wizard: rejection undone");
    // The surface disappears from step 2 once its last note is freed, so fall back
    // there rather than re-rendering an empty note list.
    const left = (await repo.rejectionList()).some(
      (r) => r.surface === surface,
    );
    return left
      ? this.lwRejectedNotes(
          ctx,
          si,
          Math.floor(Number(b) / MenuController.REJECT_PAGE),
        )
      : this.lwRejectedWords(ctx, Math.floor(si / MenuController.REJECT_PAGE));
  }

  /** Step 2 (always-link) — one page of pairs. Tap a pair to edit or drop it. */
  private async lwPairs(ctx: any, page = 0): Promise<void> {
    const PAGE = MenuController.REJECT_PAGE;
    const forced = await this.getDeps().repo.registeredLinks();
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

  /** Step 3 (always-link) — what you can do to one pair: retarget, rename, or drop. */
  private async lwPairDetail(ctx: any, gi: number): Promise<void> {
    const forced = await this.getDeps().repo.registeredLinks();
    const r = forced[gi];
    if (!r) {
      log.warn({ gi }, "link wizard: pair index out of range");
      return this.lwPairs(ctx, 0);
    }
    const kb = new InlineKeyboard()
      .text("🔁 Change note", `menu:lrgt:${gi}`)
      .row()
      .text("✏️ Rename word", `menu:lrgw:${gi}`)
      .row()
      .text("🗑 Delete pair", `menu:lrgd:${gi}`)
      .row()
      .text(
        "‹ Back",
        `menu:lrg:${Math.floor(gi / MenuController.REJECT_PAGE)}`,
      );
    await ctx.editMessageText(
      [
        `🔗 Link rules › 🔗 Always link › ${r.surface} — step 3 of 3`,
        "",
        `"${r.surface}" always links to [[${r.note}]].`,
      ].join("\n"),
      { reply_markup: withClose(kb, CLOSE) },
    );
  }

  /** Drop the pair at global index `arg`, then re-render its page. */
  private async lwPairDelete(ctx: any, arg?: string): Promise<void> {
    const { repo } = this.getDeps();
    const forced = await repo.registeredLinks();
    const gi = arg === undefined ? -1 : Number(arg);
    const r = forced[gi];
    if (!r) {
      log.warn({ arg }, "link wizard: pair index out of range");
      return void ctx.answerCallbackQuery({ text: "expired" });
    }
    // Answer before the write, so a slow DB round-trip can't outlive Telegram's
    // callback-query window — the re-rendered page carries the result.
    await ctx.answerCallbackQuery({ text: `dropped ${r.surface}` });
    const n = await repo.delRegisteredLink(r.surface, r.note);
    log.info(
      { surface: r.surface, note: r.note, removed: n },
      "link wizard: always-link pair removed",
    );
    return this.lwPairs(ctx, Math.floor(gi / MenuController.REJECT_PAGE));
  }

  /** "Change note" on an existing pair: reuse the picker, remembering what to replace. */
  private async lwRetarget(ctx: any, gi: number): Promise<void> {
    const forced = await this.getDeps().repo.registeredLinks();
    const r = forced[gi];
    if (!r) {
      log.warn({ gi }, "link wizard: retarget index out of range");
      return void ctx.answerCallbackQuery({ text: "expired" });
    }
    await ctx.answerCallbackQuery();
    log.info({ surface: r.surface, note: r.note }, "link wizard: retargeting");
    this.pending = {
      words: [r.surface],
      i: 0,
      query: r.surface,
      page: 0,
      retarget: { ...r },
    };
    return this.showNotePicker(ctx, "edit", 0);
  }

  /** Force-reply prompts — the three places a rule needs free text no keyboard can give.
   *  The answer routes back through handleWizardReply by the marker in the prompt. */
  private async lwPrompt(
    ctx: any,
    kind: "sw" | "rg" | "rgn" | "rgm" | "rgw",
    gi?: number,
  ): Promise<void> {
    await ctx.answerCallbackQuery({ text: "Answer the prompt below ↓" });
    log.info({ kind, gi }, "link wizard: prompting");
    const word = this.pending?.words[this.pending.i];
    const prompts: Record<typeof kind, string> = {
      sw: `➕ Reply to this message with the word(s) that should never be linked. One per line, or comma-separated. ${WIZARD_STOPWORD_REF}`,
      rg: `➕ Reply to this message with the word(s) that should always link. One per line, or comma-separated — spaces are fine, and I'll ask for each one's note next. ${WIZARD_REGISTER_REF}`,
      rgn: `🔎 Search the vault for the note${word ? ` "${word}" should link to` : ""}. Reply to this message with any part of its title. ${WIZARD_NOTE_REF}`,
      rgm: `✍️ Reply to this message with the exact title of the note${word ? ` "${word}" should link to` : ""} — it doesn't have to exist yet. ${WIZARD_NEWNOTE_REF}`,
      rgw: `✏️ Reply to this message with the new word for this pair. ${`(${WIZARD_RENAME_REF}:${gi})`}`,
    };
    const text = prompts[kind];
    // Opened by a tap, so the compose box can be pointed at the prompt safely.
    await this.bot.api.sendMessage(config.telegram.allowedUserId, text, {
      reply_markup: { force_reply: true },
    });
  }

  /** The note picker: search results from the vault index as tappable rows. `mode` is
   *  "edit" from a button tap and "send" after a force-reply (which arrives as a new
   *  message, so there's nothing in place to edit). */
  private async showNotePicker(
    ctx: any,
    mode: "edit" | "send",
    page = 0,
  ): Promise<void> {
    const p = this.pending;
    if (!p) return void ctx.reply("That link flow expired — reopen /menu.");
    const word = p.words[p.i];
    if (word === undefined) return this.finishPending(ctx, mode);

    const hits = noteSuggestions(p.query, this.getDeps().links.list());
    const view = paginate(hits, page, MenuController.PICK_PAGE);
    p.page = view.page;
    const queue =
      p.words.length > 1 ? ` (word ${p.i + 1} of ${p.words.length})` : "";
    const { text, kb } = pagedScreen({
      view,
      title: (v) =>
        [
          `🔗 "${word}" → which note?${queue}`,
          "",
          hits.length
            ? `${hits.length} match(es) for "${p.query}"${v.pages > 1 ? `, page ${v.page + 1}/${v.pages}` : ""}. Tap one, or search again.`
            : `Nothing in the vault matches "${p.query}". Search again with another part of the title.`,
        ].join("\n"),
      // lwPick resolves the tap against p.page, so the callback carries the index within the page.
      row: (kb, note, i) =>
        kb.text(`📝 ${note}`.slice(0, 60), `menu:lrgp:${i - view.offset}`),
      nav: (n) => `menu:lrgn:${n}`,
      extraRows: (kb) => {
        kb.text("🔎 Search by another name", "menu:lrgq").row();
        kb.text("✍️ Type a note that doesn't exist yet", "menu:lrgm").row();
        if (p.words.length > 1) kb.text("⏭ Skip this word", "menu:lrgs");
        kb.text("✖ Cancel", "menu:lrgc");
      },
    });

    if (mode === "edit")
      return ctx.editMessageText(text, { reply_markup: withClose(kb, CLOSE) });
    return this.sendMenu(text, kb);
  }

  /** A confirmation that closes a wizard branch. It is still part of the menu, so it gets
   *  the same Close button and the same countdown. */
  private async replyMenu(
    ctx: any,
    text: string,
    kb: InlineKeyboard,
  ): Promise<void> {
    const sent = await ctx.reply(text, { reply_markup: withClose(kb, CLOSE) });
    this.menus.touch(sent.chat.id, sent.message_id);
  }

  /** Send a menu screen of our own (not an edit of a tapped one) and start its countdown. */
  private async sendMenu(text: string, kb: InlineKeyboard): Promise<void> {
    const sent = await this.bot.api.sendMessage(
      config.telegram.allowedUserId,
      text,
      { reply_markup: withClose(kb, CLOSE) },
    );
    this.menus.touch(sent.chat.id, sent.message_id);
  }

  /** A tapped suggestion: save the pair (replacing the old note when retargeting) and
   *  move to the next queued word. */
  private async lwPick(ctx: any, j: number): Promise<void> {
    const p = this.pending;
    const word = p?.words[p.i];
    if (!p || word === undefined) {
      log.warn("link wizard: pick with no pending flow");
      return void ctx.answerCallbackQuery({ text: "expired" });
    }
    const PAGE = MenuController.PICK_PAGE;
    const hits = noteSuggestions(p.query, this.getDeps().links.list());
    const note = hits[p.page * PAGE + j];
    if (note === undefined) {
      log.warn({ j, page: p.page }, "link wizard: suggestion out of range");
      return void ctx.answerCallbackQuery({ text: "expired" });
    }
    await ctx.answerCallbackQuery({ text: `${word} → ${note}` });
    return this.savePair(ctx, word, note);
  }

  /** Write one pair, retiring the pair being replaced when this is a retarget. `mode` is
   *  how the next screen gets drawn — "send" when we got here from a force-reply. */
  private async savePair(
    ctx: any,
    word: string,
    note: string,
    mode: "edit" | "send" = "edit",
  ): Promise<void> {
    const { repo } = this.getDeps();
    const old = this.pending?.retarget;
    if (old) await repo.delRegisteredLink(old.surface, old.note);
    await repo.addRegisteredLink(word, note);
    log.info(
      { surface: word, note, replaced: old?.note },
      "link wizard: pair saved",
    );
    return this.advance(ctx, mode);
  }

  /** Move the queue on: next word gets its own picker, an empty queue ends the flow. */
  private async advance(
    ctx: any,
    mode: "edit" | "send" = "edit",
  ): Promise<void> {
    const p = this.pending;
    if (!p) return this.lwPairs(ctx, 0);
    p.i += 1;
    const next = p.words[p.i];
    if (next === undefined) return this.finishPending(ctx, mode);
    p.query = next;
    return this.showNotePicker(ctx, mode, 0);
  }

  private async finishPending(ctx: any, mode: "edit" | "send"): Promise<void> {
    const done = this.pending?.words.length ?? 0;
    this.pending = undefined;
    log.info({ words: done }, "link wizard: pair flow finished");
    if (mode === "edit") return this.lwPairs(ctx, 0);
    // Arrived from a reply, so there's no menu message here to edit — send a fresh one.
    await this.sendMenu(
      "🔗 Always-link rules updated.",
      new InlineKeyboard().text("🔗 Link rules", "menu:links"),
    );
  }

  private async lwSkip(ctx: any): Promise<void> {
    await ctx.answerCallbackQuery({ text: "skipped" });
    log.info(
      { word: this.pending?.words[this.pending.i] },
      "link wizard: word skipped",
    );
    return this.advance(ctx);
  }

  private async lwCancel(ctx: any): Promise<void> {
    await ctx.answerCallbackQuery({ text: "cancelled" });
    log.info("link wizard: pair flow cancelled");
    this.pending = undefined;
    return this.lwPairs(ctx, 0);
  }

  /** True when `text` is one of the wizard's own force-reply prompts. */
  isWizardPrompt(text: string): boolean {
    return parseWizardRef(text) !== null;
  }

  /** Route a link-rule reply to the prompt that asked for it. The settings prompts are
   *  claimed by their own reply view before a reply gets here. */
  async handleWizardReply(ctx: any, prompt: string): Promise<void> {
    const { repo } = this.getDeps();
    const p = parseWizardRef(prompt);
    if (!p) return;
    const body = ctx.message?.text ?? "";

    switch (p.kind) {
      case "sw": {
        const words = parseRuleWords(body);
        if (!words.length) {
          log.warn({ body }, "link wizard: empty never-link reply");
          return void ctx.reply("Nothing to add — send a word.");
        }
        for (const w of words) await repo.addStopword(w);
        log.info({ words }, "link wizard: never-link words added");
        return this.replyMenu(
          ctx,
          `🔇 never linking: ${words.join(", ")}`,
          new InlineKeyboard().text("🔗 Link rules", "menu:links"),
        );
      }
      case "rg": {
        const words = parseRuleWords(body);
        if (!words.length) {
          log.warn({ body }, "link wizard: empty always-link reply");
          return void ctx.reply("Nothing to add — send a word.");
        }
        log.info({ words }, "link wizard: queued words needing a note");
        this.pending = { words, i: 0, query: words[0] ?? "", page: 0 };
        return this.showNotePicker(ctx, "send", 0);
      }
      case "rgn": {
        if (!this.pending) {
          log.warn("link wizard: search reply with no pending flow");
          return void ctx.reply("That link flow expired — reopen /menu.");
        }
        this.pending.query = cleanNoteTitle(body);
        log.info({ query: this.pending.query }, "link wizard: note search");
        return this.showNotePicker(ctx, "send", 0);
      }
      case "rgm": {
        const p2 = this.pending;
        const word = p2?.words[p2.i];
        if (!p2 || word === undefined) {
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
        return this.savePair(ctx, word, note, "send");
      }
      case "rgw": {
        const forced = await repo.registeredLinks();
        const r = forced[p.index];
        if (!r) {
          log.warn({ index: p.index }, "link wizard: rename target is gone");
          return void ctx.reply("That pair is gone — reopen /menu.");
        }
        const [word] = parseRuleWords(body, 1);
        if (!word) {
          log.warn({ body }, "link wizard: empty rename reply");
          return void ctx.reply("Nothing to rename to — send a word.");
        }
        await repo.delRegisteredLink(r.surface, r.note);
        await repo.addRegisteredLink(word, r.note);
        log.info({ from: r.surface, to: word }, "link wizard: pair renamed");
        return this.replyMenu(
          ctx,
          `✏️ "${word}" always links to [[${r.note}]]`,
          new InlineKeyboard().text("🔗 Link rules", "menu:links"),
        );
      }
      case "es":
      case "em":
      case "vfm":
      case "rt":
        return;
      default:
        return void (p satisfies never);
    }
  }

  /** The jots browser: recent jots as tappable rows, so finding one no longer means
   *  scrolling chat history. */
  private async menuJots(ctx: any): Promise<void> {
    await ctx.answerCallbackQuery();
    const jots = await this.getDeps().repo.recentJots(10);
    if (!jots.length)
      return ctx.editMessageText("No jots yet.", {
        reply_markup: backTo("menu:root", CLOSE),
      });
    const screen = pagedScreen({
      view: paginate(jots, 0, jots.length),
      title: () => "🗒 Recent jots:",
      row: (kb, j) =>
        kb.text(
          `${STATUS_ICON[j.status]} ${j.time} ${jotPreview(j)}`,
          `menu:jot:${j.id}`,
        ),
      back: { text: "‹ Back", data: "menu:root" },
    });
    await ctx.editMessageText(screen.text, {
      reply_markup: withClose(screen.kb, CLOSE),
    });
  }

  private async menuJotDetail(ctx: any, id?: string): Promise<void> {
    await ctx.answerCallbackQuery();
    const jot = id ? await this.getDeps().repo.getJot(id) : undefined;
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
    await ctx.editMessageText(formatJotDetail(jot), {
      reply_markup: withClose(kb, CLOSE),
    });
  }

  private async menuJotRetry(ctx: any, id?: string): Promise<void> {
    const deps = this.getDeps();
    if (!id || !(await deps.repo.getJot(id)))
      return void ctx.answerCallbackQuery({ text: "gone" });
    log.info({ jotId: id }, "menu: manual retry requested");
    await deps.repo.resetForRetry(id);
    deps.queue.add([id]);
    await ctx.answerCallbackQuery({ text: "retrying" });
    await ctx.editMessageText(`🔄 retrying ${id}…`, {
      reply_markup: backTo("menu:jots", CLOSE),
    });
  }

  private async menuJotDeleteConfirm(ctx: any, id?: string): Promise<void> {
    await ctx.answerCallbackQuery();
    if (!id) return;
    const kb = new InlineKeyboard()
      .text("🗑 Yes, delete", `menu:jdy:${id}`)
      .text("Cancel", `menu:jot:${id}`);
    await ctx.editMessageText(
      `Delete jot ${id}? This removes its line from the journal.`,
      { reply_markup: withClose(kb, CLOSE) },
    );
  }

  private async menuJotDelete(ctx: any, id?: string): Promise<void> {
    const deps = this.getDeps();
    const jot = id ? await deps.repo.getJot(id) : undefined;
    if (!jot) return void ctx.answerCallbackQuery({ text: "gone" });
    // Answer before the note-lock read/write below, which can be slow enough to blow
    // past Telegram's callback-query window — the edited message carries the result.
    await ctx.answerCallbackQuery();
    log.info({ jotId: id }, "menu: delete jot");
    const msg = await this.deleteJot(jot);
    await ctx.editMessageText(msg, {
      reply_markup: backTo("menu:jots", CLOSE),
    });
  }

  /** Edit from the menu: send a force-reply prompt mapped to the jot, so the reply routes
   *  through the normal reply-edit path (ScribaBot.handleEdit) with no new edit logic. */
  private async menuJotEdit(ctx: any, id?: string): Promise<void> {
    const deps = this.getDeps();
    if (!id || !(await deps.repo.getJot(id)))
      return void ctx.answerCallbackQuery({ text: "gone" });
    await ctx.answerCallbackQuery();
    log.info({ jotId: id }, "menu: edit jot — prompting for a reply");
    const sent = await this.bot.api.sendMessage(
      config.telegram.allowedUserId,
      `✏️ Reply to this message with your edit for ${id} (or "delete" to remove it).`,
      { reply_markup: { force_reply: true } },
    );
    await deps.repo.mapMessage(sent.message_id, id);
  }
}
