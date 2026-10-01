import type { Knex } from "knex";

export class SettingsRepository {
  constructor(private k: Knex) {}

  async getSetting(key: string): Promise<string | undefined> {
    const r = await this.k("settings").where({ key }).first();
    return r?.value;
  }
  async setSetting(key: string, value: string): Promise<void> {
    await this.k("settings")
      .insert({ key, value, updated_at: Date.now() })
      .onConflict("key")
      .merge();
  }
}
