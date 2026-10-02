import type { LinkRule } from "../domain/link-rule/entity.ts";
import type {
  SettingKey,
  SettingValue,
  SwitchKey,
} from "../domain/setting/entity.ts";
import { noteSuggestions } from "../libs/links.ts";
import { logger } from "../libs/log.ts";
import { paginate } from "../libs/page.ts";
import type { Scheduler } from "../libs/scheduler.ts";
import {
  WIZARD_ENRICH_MODEL_REF,
  WIZARD_ENTRYSIZE_REF,
  WIZARD_NEWNOTE_REF,
  WIZARD_NOTE_REF,
  WIZARD_RATING_TIME_REF,
  WIZARD_REGISTER_REF,
  WIZARD_RENAME_REF,
  WIZARD_STOPWORD_REF,
  WIZARD_VOICEFIX_MODEL_REF,
} from "../libs/wizard.ts";
import type { Repository } from "../repositories/index.ts";
import type { Enricher } from "../services/enrich.ts";
import type { Notifier } from "../services/notifier.ts";
import type { VaultService } from "../services/vault.ts";

const log = logger("menu");

export interface SettingsDeps {
  repo: Pick<
    Repository,
    | "getSetting"
    | "setSetting"
    | "toggleSetting"
    | "ratingTime"
    | "stopwordList"
    | "addStopword"
    | "delStopword"
    | "rejectionList"
    | "unreject"
    | "registeredLinks"
    | "addRegisteredLink"
    | "delRegisteredLink"
  >;
  links: Pick<VaultService, "list" | "stats">;
  enricher: Pick<Enricher, "setModel">;
  scheduler: Pick<Scheduler, "rearm">;
  notifier: Pick<Notifier, "send">;
  /** The configured nightly rating time, shown until one is stored. */
  ratingTime: string;
}

export type ModelKey = "enrichModel" | "voiceFixModel";

/** The settings the menu asks for as free text, by the marker kind in their prompt. */
export type SettingsPrompt = "es" | "rt" | "em" | "vfm";

/** The link-rule replies the wizard asks for, by the marker kind in their prompt. */
export type LinkPrompt = "sw" | "rg" | "rgn" | "rgm" | "rgw";

const PROMPTS: Record<SettingsPrompt, string> = {
  es: `✂️ Reply to this message with how many characters one journal entry may be: 40–4000, or "off" to stop splitting. ${WIZARD_ENTRYSIZE_REF}`,
  rt: `🕛 Reply to this message with the time for the nightly rating, as HH:MM in 24-hour time, like 23:30. A time before 12:00 rates the day that just ended, a later one rates today. ${WIZARD_RATING_TIME_REF}`,
  em: `🧠 Reply with the model ID for enrichment (e.g. claude-sonnet-5): ${WIZARD_ENRICH_MODEL_REF}`,
  vfm: `🧠 Reply with the model ID for voice fix (e.g. claude-sonnet-5): ${WIZARD_VOICEFIX_MODEL_REF}`,
};

// Note-search page size. Smaller than the rule lists' page: note titles are long, and a
// wall of them is exactly the "hard to find things" problem the picker exists to solve.
const PICK_PAGE = 6;

/** The runtime settings the /menu control panel shows and changes, and the link rules
 *  that steer the enricher's wikilinks. */
export class SettingsController {
  // The one place the wizard keeps state between messages: picking the note side means
  // searching a vault of thousands, which cannot ride in 64 bytes of callback data.
  // In memory and single-flow: one user, and a restart just drops a half-finished add.
  private pending?: {
    words: string[]; // surfaces still waiting for a note
    i: number; // which one we're on
    query: string; // current search text (seeded with the word itself)
    page: number;
    retarget?: LinkRule; // pair being replaced, if editing
  };

  constructor(private d: SettingsDeps) {}

  /** What the root menu shows, read in the order its buttons appear. */
  async root() {
    const { repo, ratingTime } = this.d;
    return {
      entrySize: await repo.getSetting("entryMaxChars"),
      voiceFix: await repo.getSetting("fixVoiceTranscript"),
      enrichModel: await repo.getSetting("enrichModel"),
      voiceFixModel: await repo.getSetting("voiceFixModel"),
      nightlyRating: await repo.getSetting("nightlyRating"),
      nightlyFollowup: await repo.getSetting("nightlyFollowup"),
      ratingTime: await repo.ratingTime(ratingTime),
    };
  }

  get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    return this.d.repo.getSetting(key);
  }

  async toggle(key: SwitchKey): Promise<boolean> {
    const next = await this.d.repo.toggleSetting(key);
    log.info({ key, next }, "menu: switch toggled");
    return next;
  }

  /** The enricher reads its model once per boot, so a change is handed to it as well. */
  async setModel(key: ModelKey, model: string): Promise<void> {
    await this.d.repo.setSetting(key, model);
    if (key === "enrichModel") this.d.enricher.setModel(model);
    log.info({ key, model }, "menu: model changed");
  }

  async setEntrySize(size: number): Promise<void> {
    await this.d.repo.setSetting("entryMaxChars", String(size));
    log.info({ size }, "menu: entry size changed");
  }

  /** The scheduler owns the nightly timer, so it re-reads the time right away. */
  async setRatingTime(time: string): Promise<void> {
    await this.d.repo.setSetting("ratingTime", time);
    await this.d.scheduler.rearm("rating");
    log.info({ time }, "menu: rating time changed");
  }

  /** Ask for a value no keyboard can offer; the reply routes back by the prompt's marker. */
  async ask(kind: SettingsPrompt): Promise<void> {
    await this.d.notifier.send(PROMPTS[kind], { forceReply: true });
  }

  // --- link rules ---

  /** Step 1 of the wizard: every rule list and the index health. */
  async linkRules() {
    const { repo, links } = this.d;
    const [stopwords, rejections, pairs] = await Promise.all([
      repo.stopwordList(),
      repo.rejectionList(),
      repo.registeredLinks(),
    ]);
    const index = links.stats();
    log.info(
      {
        stopwords: stopwords.length,
        rejections: rejections.length,
        forced: pairs.length,
      },
      "link wizard: step 1",
    );
    return { stopwords, rejections, pairs, index };
  }

  stopwords(): Promise<string[]> {
    return this.d.repo.stopwordList();
  }

  rejections(): Promise<LinkRule[]> {
    return this.d.repo.rejectionList();
  }

  pairs(): Promise<LinkRule[]> {
    return this.d.repo.registeredLinks();
  }

  async addStopwords(words: string[]): Promise<void> {
    for (const w of words) await this.d.repo.addStopword(w);
    log.info({ words }, "link wizard: never-link words added");
  }

  async removeStopword(word: string): Promise<void> {
    const n = await this.d.repo.delStopword(word);
    log.info({ word, removed: n }, "link wizard: never-link word removed");
  }

  /** Undo one rejection; true while the word still has rejected notes. */
  async unreject(surface: string, note: string): Promise<boolean> {
    const n = await this.d.repo.unreject(surface, note);
    log.info({ surface, note, removed: n }, "link wizard: rejection undone");
    return (await this.d.repo.rejectionList()).some(
      (r) => r.surface === surface,
    );
  }

  async removePair(r: LinkRule): Promise<void> {
    const n = await this.d.repo.delRegisteredLink(r.surface, r.note);
    log.info(
      { surface: r.surface, note: r.note, removed: n },
      "link wizard: always-link pair removed",
    );
  }

  async renamePair(r: LinkRule, word: string): Promise<void> {
    await this.d.repo.delRegisteredLink(r.surface, r.note);
    await this.d.repo.addRegisteredLink(word, r.note);
    log.info({ from: r.surface, to: word }, "link wizard: pair renamed");
  }

  /** Free text for a link rule; the reply routes back by the prompt's marker. `gi` is the
   *  pair being renamed. */
  async askLink(kind: LinkPrompt, gi?: number): Promise<void> {
    log.info({ kind, gi }, "link wizard: prompting");
    const word = this.currentWord();
    const prompts: Record<LinkPrompt, string> = {
      sw: `➕ Reply to this message with the word(s) that should never be linked. One per line, or comma-separated. ${WIZARD_STOPWORD_REF}`,
      rg: `➕ Reply to this message with the word(s) that should always link. One per line, or comma-separated — spaces are fine, and I'll ask for each one's note next. ${WIZARD_REGISTER_REF}`,
      rgn: `🔎 Search the vault for the note${word ? ` "${word}" should link to` : ""}. Reply to this message with any part of its title. ${WIZARD_NOTE_REF}`,
      rgm: `✍️ Reply to this message with the exact title of the note${word ? ` "${word}" should link to` : ""} — it doesn't have to exist yet. ${WIZARD_NEWNOTE_REF}`,
      rgw: `✏️ Reply to this message with the new word for this pair. ${`(${WIZARD_RENAME_REF}:${gi})`}`,
    };
    await this.d.notifier.send(prompts[kind], { forceReply: true });
  }

  // --- the pair flow: typed words, each getting the note picker in turn ---

  queueWords(words: string[]): void {
    log.info({ words }, "link wizard: queued words needing a note");
    this.pending = { words, i: 0, query: words[0] ?? "", page: 0 };
  }

  /** "Change note" on an existing pair: the picker for its word, remembering what to replace. */
  retarget(r: LinkRule): void {
    log.info({ surface: r.surface, note: r.note }, "link wizard: retargeting");
    this.pending = {
      words: [r.surface],
      i: 0,
      query: r.surface,
      page: 0,
      retarget: { ...r },
    };
  }

  /** The word the picker is on, when a flow is open. */
  currentWord(): string | undefined {
    return this.pending?.words[this.pending.i];
  }

  /** A new search for the current word; false when no flow is open. */
  search(query: string): boolean {
    if (!this.pending) return false;
    this.pending.query = query;
    log.info({ query }, "link wizard: note search");
    return true;
  }

  /** The picker's rows for `page`, remembered so a tap resolves against the same page,
   *  with the word they are for and its place in the queue. "done" ends a flow whose
   *  words are all placed. */
  picker(page: number) {
    const p = this.pending;
    if (!p) return "expired" as const;
    const word = p.words[p.i];
    if (word === undefined) {
      this.finish();
      return "done" as const;
    }
    const hits = noteSuggestions(p.query, this.d.links.list());
    const view = paginate(hits, page, PICK_PAGE);
    p.page = view.page;
    return {
      word,
      query: p.query,
      total: hits.length,
      view,
      nth: p.i + 1,
      of: p.words.length,
    };
  }

  /** The note at row `j` of the remembered page, with the word it is for. */
  pick(j: number): { word: string; note: string } | undefined {
    const p = this.pending;
    const word = p?.words[p.i];
    if (!p || word === undefined) {
      log.warn("link wizard: pick with no pending flow");
      return undefined;
    }
    const note = noteSuggestions(p.query, this.d.links.list())[
      p.page * PICK_PAGE + j
    ];
    if (note === undefined) {
      log.warn({ j, page: p.page }, "link wizard: suggestion out of range");
      return undefined;
    }
    return { word, note };
  }

  /** Write one pair, retiring the pair being replaced when this is a retarget. */
  async savePair(word: string, note: string): Promise<void> {
    const old = this.pending?.retarget;
    if (old) await this.d.repo.delRegisteredLink(old.surface, old.note);
    await this.d.repo.addRegisteredLink(word, note);
    log.info(
      { surface: word, note, replaced: old?.note },
      "link wizard: pair saved",
    );
  }

  /** Move the queue on: the next word, or undefined once the flow is over. */
  advance(): string | undefined {
    const p = this.pending;
    if (!p) return undefined;
    p.i += 1;
    const next = p.words[p.i];
    if (next === undefined) {
      this.finish();
      return undefined;
    }
    p.query = next;
    return next;
  }

  skip(): string | undefined {
    log.info({ word: this.currentWord() }, "link wizard: word skipped");
    return this.advance();
  }

  cancel(): void {
    log.info("link wizard: pair flow cancelled");
    this.pending = undefined;
  }

  private finish(): void {
    log.info(
      { words: this.pending?.words.length ?? 0 },
      "link wizard: pair flow finished",
    );
    this.pending = undefined;
  }
}

export type RootState = Awaited<ReturnType<SettingsController["root"]>>;
