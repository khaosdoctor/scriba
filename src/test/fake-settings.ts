import {
  parseClockTime,
  SETTINGS,
  type SettingKey,
  type SettingValue,
  type SwitchKey,
} from "../models/settings.ts";

/** The settings half of a fake Repository: typed reads and string writes over a plain map,
 *  the way SettingsRepository behaves over the table. */
export function fakeSettings(
  stored: Map<string, string> = new Map(),
  onSet?: (key: SettingKey, value: string) => void,
) {
  const getSetting = async <K extends SettingKey>(
    key: K,
  ): Promise<SettingValue<K>> =>
    SETTINGS[key].parse(stored.get(key)) as SettingValue<K>;
  const setSetting = async (key: SettingKey, value: string) => {
    stored.set(key, value);
    onSet?.(key, value);
  };
  return {
    getSetting,
    setSetting,
    toggleSetting: async (key: SwitchKey) => {
      const next = !(await getSetting(key));
      await setSetting(key, next ? "on" : "off");
      return next;
    },
    ratingTime: async (fallback: string) =>
      (await getSetting("ratingTime")) ?? parseClockTime(fallback) ?? fallback,
  };
}
