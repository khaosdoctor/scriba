import type { Knex } from "knex";
import {
  parseClockTime,
  SETTINGS,
  type SettingKey,
  type SettingValue,
  type SwitchKey,
} from "../models/settings.ts";

export class SettingsRepository {
  constructor(private k: Knex) {}

  private async raw(key: SettingKey): Promise<string | undefined> {
    const r = await this.k("settings").where({ key }).first();
    return r?.value;
  }

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    return SETTINGS[key].parse(await this.raw(key)) as SettingValue<K>;
  }
  async set(key: SettingKey, value: string): Promise<void> {
    await this.k("settings")
      .insert({ key, value, updated_at: Date.now() })
      .onConflict("key")
      .merge();
  }
  /** Toggle a switch and return its new state. */
  async toggle(key: SwitchKey): Promise<boolean> {
    const next = !(await this.get(key));
    await this.set(key, next ? "on" : "off");
    return next;
  }
  /** Write each default whose key is unset or blank, in order. First boot only: from then
   *  on the stored value wins. */
  async seedDefaults(
    defaults: Partial<Record<SettingKey, string>>,
  ): Promise<void> {
    for (const [key, value] of Object.entries(defaults) as [
      SettingKey,
      string,
    ][]) {
      if (!(await this.raw(key))) await this.set(key, value);
    }
  }
  /** The nightly rating time in force: the stored time, else the configured one. */
  async ratingTime(fallback: string): Promise<string> {
    return (
      (await this.get("ratingTime")) ?? parseClockTime(fallback) ?? fallback
    );
  }
}
