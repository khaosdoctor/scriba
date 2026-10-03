import {
  ratingTimeOrFallback,
  SETTINGS,
  type SettingKey,
  type SettingValue,
  type SwitchKey,
} from "../domain/setting/entity.ts";
import type { Task } from "../domain/task/entity.ts";

export const sampleTask = (over: Partial<Task>): Task => ({
  index: 0,
  line: "",
  fingerprint: "0",
  type: "personal",
  state: "open",
  text: "t",
  start: null,
  due: null,
  completion: null,
  ...over,
});

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
    ratingTimeOrFallback(await this.getSetting("ratingTime"), fallback);
}

export type ApiCall = { method: string; payload: any };

export type RecordingApi = {
  /** Every Telegram call, in order. */
  calls: ApiCall[];
  /** Methods Telegram refuses: the call answers `{ ok: false }`, which grammy throws. */
  fail: Set<string>;
  /** Results per method in place of the defaults. */
  results: Record<string, unknown>;
  /** The transformer to install with `api.config.use(...)`. */
  transformer: (prev: unknown, method: string, payload: any) => Promise<any>;
  /** Texts of the calls of one method (sendMessage, editMessageText, ...). */
  texts(method: string): string[];
  /** The answerCallbackQuery toasts, in order; a bare ack is `undefined`. */
  answers(): (string | undefined)[];
  /** A call's inline keyboard as [label, callback_data] pairs. */
  buttons(call: ApiCall | undefined): [string, string][];
};

/** A grammy api transformer that records every call and answers it offline: `sendMessage`
 *  gets a fresh message id from 900 up, everything else `true`. `onCall` sees each call
 *  before it is answered, for tests that keep one timeline across layers. */
export function recordingApi(
  opts: { onCall?: (call: ApiCall) => void } = {},
): RecordingApi {
  const calls: ApiCall[] = [];
  const fail = new Set<string>();
  const results: Record<string, unknown> = {};
  let nextMessageId = 900;
  const transformer = async (_prev: unknown, method: string, payload: any) => {
    const call = { method, payload };
    calls.push(call);
    opts.onCall?.(call);
    if (fail.has(method))
      return { ok: false, error_code: 400, description: "Bad Request: failed" };
    if (method in results) return { ok: true, result: results[method] };
    if (method === "sendMessage")
      return {
        ok: true,
        result: {
          message_id: nextMessageId++,
          date: 0,
          chat: { id: payload.chat_id, type: "private" },
          text: payload.text,
        },
      };
    return { ok: true, result: true };
  };
  const of = (method: string) => calls.filter((call) => call.method === method);
  return {
    calls,
    fail,
    results,
    transformer,
    texts: (method) => of(method).map((call) => call.payload.text),
    answers: () => of("answerCallbackQuery").map((call) => call.payload.text),
    buttons: (call) =>
      (call?.payload.reply_markup?.inline_keyboard ?? [])
        .flat()
        .map((button: any) => [button.text, button.callback_data]),
  };
}

/** What grammy's `getMe` would have filled in, so `bot.handleUpdate` works offline. */
export const BOT_INFO = {
  id: 99,
  is_bot: true as const,
  first_name: "scriba",
  username: "scriba_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};
