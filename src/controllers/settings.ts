import {
  WIZARD_ENRICH_MODEL_REF,
  WIZARD_ENTRYSIZE_REF,
  WIZARD_RATING_TIME_REF,
  WIZARD_VOICEFIX_MODEL_REF,
} from "../core.ts";
import type { Repository } from "../db.ts";
import { logger } from "../lib/log.ts";
import type { Scheduler } from "../lib/scheduler.ts";
import type { Notifier } from "../models/ops.ts";
import type {
  SettingKey,
  SettingValue,
  SwitchKey,
} from "../models/settings.ts";
import type { Enricher } from "../services/enrich.ts";

const log = logger("menu");

export interface SettingsDeps {
  repo: Pick<
    Repository,
    "getSetting" | "setSetting" | "toggleSetting" | "ratingTime"
  >;
  enricher: Pick<Enricher, "setModel">;
  scheduler: Pick<Scheduler, "rearm">;
  notifier: Pick<Notifier, "send">;
  /** The configured nightly rating time, shown until one is stored. */
  ratingTime: string;
}

export type ModelKey = "enrichModel" | "voiceFixModel";

/** The settings the menu asks for as free text, by the marker kind in their prompt. */
export type SettingsPrompt = "es" | "rt" | "em" | "vfm";

const PROMPTS: Record<SettingsPrompt, string> = {
  es: `✂️ Reply to this message with how many characters one journal entry may be: 40–4000, or "off" to stop splitting. ${WIZARD_ENTRYSIZE_REF}`,
  rt: `🕛 Reply to this message with the time for the nightly rating, as HH:MM in 24-hour time, like 23:30. A time before 12:00 rates the day that just ended, a later one rates today. ${WIZARD_RATING_TIME_REF}`,
  em: `🧠 Reply with the model ID for enrichment (e.g. claude-sonnet-5): ${WIZARD_ENRICH_MODEL_REF}`,
  vfm: `🧠 Reply with the model ID for voice fix (e.g. claude-sonnet-5): ${WIZARD_VOICEFIX_MODEL_REF}`,
};

/** The runtime settings the /menu control panel shows and changes. */
export class SettingsController {
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
}

export type RootState = Awaited<ReturnType<SettingsController["root"]>>;
