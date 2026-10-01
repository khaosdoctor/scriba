import {
  parseClockTime,
  SETTINGS,
  type SettingKey,
  type SettingValue,
  type SwitchKey,
} from "../models/settings.ts";

/** The settings half of a fake Repository: typed reads and string writes over a plain map,
 *  the way SettingsRepository behaves over the table. Members are arrow properties so the
 *  instance can be spread into a repository stub. */
export class FakeSettings {
  private readonly stored: Map<string, string>;
  /** Every key read through `getSetting`, in order. */
  readonly reads: SettingKey[] = [];

  constructor(
    stored: Map<string, string> | Record<string, string> = new Map(),
    private onSet?: (key: SettingKey, value: string) => void,
  ) {
    this.stored =
      stored instanceof Map ? stored : new Map(Object.entries(stored));
  }

  getSetting = async <K extends SettingKey>(
    key: K,
  ): Promise<SettingValue<K>> => {
    this.reads.push(key);
    return SETTINGS[key].parse(this.stored.get(key)) as SettingValue<K>;
  };

  setSetting = async (key: SettingKey, value: string) => {
    this.stored.set(key, value);
    this.onSet?.(key, value);
  };

  toggleSetting = async (key: SwitchKey) => {
    const next = !(await this.getSetting(key));
    await this.setSetting(key, next ? "on" : "off");
    return next;
  };

  ratingTime = async (fallback: string) =>
    (await this.getSetting("ratingTime")) ??
    parseClockTime(fallback) ??
    fallback;
}

/** What grammy's `getMe` would have filled in, so `bot.handleUpdate` works offline. */
export const BOT_INFO = {
  id: 99,
  is_bot: true,
  first_name: "scriba",
  username: "scriba_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};
