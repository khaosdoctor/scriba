import type { LinkRuleRepository } from "../data/repositories/link-rules.ts";
import type { SettingsRepository } from "../data/repositories/settings.ts";
import type { VaultRepository } from "../data/repositories/vault.ts";
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
import type { Enricher } from "./enrich.ts";
import type { Notifier } from "./notifier.ts";

const log = logger("menu");

export interface SettingsDeps {
  repo: SettingsRepository;
  linkRules: LinkRuleRepository;
  links: Pick<VaultRepository, "list" | "stats">;
  enricher: Pick<Enricher, "setModel">;
  scheduler: Pick<Scheduler, "rearm">;
  notifier: Pick<Notifier, "send">;
  ratingTime: string;
}

export type ModelKey = "enrichModel" | "voiceFixModel";

export type SettingsPrompt = "es" | "rt" | "em" | "vfm";

export type LinkPrompt = "sw" | "rg" | "rgn" | "rgm" | "rgw";

const PROMPTS: Record<SettingsPrompt, string> = {
  es: `✂️ Reply to this message with how many characters one journal entry may be: 40–4000, or "off" to stop splitting. ${WIZARD_ENTRYSIZE_REF}`,
  rt: `🕛 Reply to this message with the time for the nightly rating, as HH:MM in 24-hour time, like 23:30. A time before 12:00 rates the day that just ended, a later one rates today. ${WIZARD_RATING_TIME_REF}`,
  em: `🧠 Reply with the model ID for enrichment (e.g. claude-sonnet-5): ${WIZARD_ENRICH_MODEL_REF}`,
  vfm: `🧠 Reply with the model ID for voice fix (e.g. claude-sonnet-5): ${WIZARD_VOICEFIX_MODEL_REF}`,
};

const PICK_PAGE = 6;

export class SettingsService {
  // The one place the wizard keeps state between messages: picking the note side means
  // searching a vault of thousands, which cannot ride in 64 bytes of callback data.
  // In memory and single-flow: one user, and a restart just drops a half-finished add.
  private pending?: {
    words: string[]; // surfaces still waiting for a note
    position: number; // which one we're on
    query: string; // current search text (seeded with the word itself)
    page: number;
    retarget?: LinkRule; // pair being replaced, if editing
  };

  constructor(private deps: SettingsDeps) {}

  async root() {
    const { repo, ratingTime } = this.deps;
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
    return this.deps.repo.getSetting(key);
  }

  async toggle(key: SwitchKey): Promise<boolean> {
    const next = await this.deps.repo.toggleSetting(key);
    const state = next ? "on" : "off";
    if (key === "fixVoiceTranscript")
      log.info({ next: state }, "menu: voice fix toggled");
    if (key !== "fixVoiceTranscript")
      log.info({ key, next: state }, "menu: switch toggled");
    return next;
  }

  /** The enricher reads its model once per boot, so a change is handed to it as well. */
  async setModel(
    key: ModelKey,
    model: string,
    message = "menu: model changed",
  ): Promise<void> {
    await this.deps.repo.setSetting(key, model);
    if (key === "enrichModel") this.deps.enricher.setModel(model);
    log.info(
      { which: key === "enrichModel" ? "enrich" : "voiceFix", model },
      message,
    );
  }

  async setEntrySize(size: number): Promise<void> {
    await this.deps.repo.setSetting("entryMaxChars", String(size));
    log.info({ size }, "menu: entry size changed");
  }

  /** The scheduler owns the nightly timer, so it re-reads the time right away. */
  async setRatingTime(time: string): Promise<void> {
    await this.deps.repo.setSetting("ratingTime", time);
    await this.deps.scheduler.rearm("rating");
    log.info({ time }, "menu: rating time changed");
  }

  async ask(kind: SettingsPrompt): Promise<void> {
    await this.deps.notifier.send(PROMPTS[kind], { forceReply: true });
  }

  async linkRules() {
    const { linkRules, links } = this.deps;
    const [stopwords, rejections, pairs] = await Promise.all([
      linkRules.stopwordList(),
      linkRules.rejectionList(),
      linkRules.registeredLinks(),
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
    return this.deps.linkRules.stopwordList();
  }

  rejections(): Promise<LinkRule[]> {
    return this.deps.linkRules.rejectionList();
  }

  pairs(): Promise<LinkRule[]> {
    return this.deps.linkRules.registeredLinks();
  }

  async addStopwords(words: string[]): Promise<void> {
    for (const word of words) await this.deps.linkRules.addStopword(word);
    log.info({ words }, "link wizard: never-link words added");
  }

  async removeStopword(word: string): Promise<void> {
    const removed = await this.deps.linkRules.delStopword(word);
    log.info({ word, removed }, "link wizard: never-link word removed");
  }

  async unreject(surface: string, note: string): Promise<boolean> {
    const removed = await this.deps.linkRules.unreject(surface, note);
    log.info({ surface, note, removed }, "link wizard: rejection undone");
    return (await this.deps.linkRules.rejectionList()).some(
      (rule) => rule.surface === surface,
    );
  }

  async removePair(pair: LinkRule): Promise<void> {
    const removed = await this.deps.linkRules.delRegisteredLink(
      pair.surface,
      pair.note,
    );
    log.info(
      { surface: pair.surface, note: pair.note, removed },
      "link wizard: always-link pair removed",
    );
  }

  async renamePair(pair: LinkRule, word: string): Promise<void> {
    await this.deps.linkRules.delRegisteredLink(pair.surface, pair.note);
    await this.deps.linkRules.addRegisteredLink(word, pair.note);
    log.info({ from: pair.surface, to: word }, "link wizard: pair renamed");
  }

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
    await this.deps.notifier.send(prompts[kind], { forceReply: true });
  }

  queueWords(words: string[]): void {
    log.info({ words }, "link wizard: queued words needing a note");
    this.pending = { words, position: 0, query: words[0] ?? "", page: 0 };
  }

  retarget(pair: LinkRule): void {
    log.info(
      { surface: pair.surface, note: pair.note },
      "link wizard: retargeting",
    );
    this.pending = {
      words: [pair.surface],
      position: 0,
      query: pair.surface,
      page: 0,
      retarget: { ...pair },
    };
  }

  currentWord(): string | undefined {
    return this.pending?.words[this.pending.position];
  }

  search(query: string): boolean {
    if (!this.pending) return false;
    this.pending.query = query;
    log.info({ query }, "link wizard: note search");
    return true;
  }

  picker(page: number) {
    const pending = this.pending;
    if (!pending) return "expired" as const;
    const word = pending.words[pending.position];
    if (word === undefined) {
      this.finish();
      return "done" as const;
    }
    const hits = noteSuggestions(pending.query, this.deps.links.list());
    const view = paginate(hits, page, PICK_PAGE);
    pending.page = view.page;
    return {
      word,
      query: pending.query,
      total: hits.length,
      view,
      nth: pending.position + 1,
      of: pending.words.length,
    };
  }

  pick(choice: number): { word: string; note: string } | undefined {
    const pending = this.pending;
    const word = pending?.words[pending.position];
    if (!pending || word === undefined) {
      log.warn("link wizard: pick with no pending flow");
      return undefined;
    }
    const note = noteSuggestions(pending.query, this.deps.links.list())[
      pending.page * PICK_PAGE + choice
    ];
    if (note === undefined) {
      log.warn(
        { j: choice, page: pending.page },
        "link wizard: suggestion out of range",
      );
      return undefined;
    }
    return { word, note };
  }

  async savePair(word: string, note: string): Promise<void> {
    const old = this.pending?.retarget;
    if (old) await this.deps.linkRules.delRegisteredLink(old.surface, old.note);
    await this.deps.linkRules.addRegisteredLink(word, note);
    log.info(
      { surface: word, note, replaced: old?.note },
      "link wizard: pair saved",
    );
  }

  advance(): string | undefined {
    const pending = this.pending;
    if (!pending) return undefined;
    pending.position += 1;
    const next = pending.words[pending.position];
    if (next === undefined) {
      this.finish();
      return undefined;
    }
    pending.query = next;
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

export type RootState = Awaited<ReturnType<SettingsService["root"]>>;
