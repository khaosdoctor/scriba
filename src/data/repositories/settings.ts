import type { Knex } from "knex";
import {
  ratingTimeOrFallback,
  SETTINGS,
  type SettingKey,
  type SettingValue,
  type SwitchKey,
} from "../../domain/setting/entity.ts";

export class SettingsRepository {
  constructor(private knex: Knex) {}

  private async raw(key: SettingKey): Promise<string | undefined> {
    const row = await this.knex("settings").where({ key }).first();
    return row?.value;
  }

  async getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    return SETTINGS[key].parse(await this.raw(key)) as SettingValue<K>;
  }
  async setSetting(key: SettingKey, value: string): Promise<void> {
    await this.knex("settings")
      .insert({ key, value, updated_at: Date.now() })
      .onConflict("key")
      .merge();
  }
  async toggleSetting(key: SwitchKey): Promise<boolean> {
    const next = !(await this.getSetting(key));
    await this.setSetting(key, next ? "on" : "off");
    return next;
  }
  async seedSettings(
    defaults: Partial<Record<SettingKey, string>>,
  ): Promise<void> {
    for (const [key, value] of Object.entries(defaults) as [
      SettingKey,
      string,
    ][]) {
      if (!(await this.raw(key))) await this.setSetting(key, value);
    }
  }
  async ratingTime(fallback: string): Promise<string> {
    return ratingTimeOrFallback(await this.getSetting("ratingTime"), fallback);
  }
}
