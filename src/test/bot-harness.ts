// Drives the real ScribaBot through grammy's handleUpdate with in-memory collaborators.
// Every call a handler makes to the repository, Obsidian, the queue or Telegram is recorded
// on one ordered timeline, which is what the routing and ack-ledger tests assert against.
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ALLOWED_TELEGRAM_USER_ID ??= "1";
process.env.OBSIDIAN_API_KEY ??= "o";

import type { Jot } from "../db.ts";
import { fakeSettings } from "./fake-settings.ts";
import { noteOps } from "./note-ops.ts";

export const OWNER = 1;
export const CHAT = 1;
export const NOW = Date.UTC(2026, 7, 16, 10, 0, 0);
export const JOT_ID = "aaaaaaaa";
/** The dash the bot's own messages use, for asserting their exact text. */
export const EM = String.fromCharCode(0x2014);

export const sampleJot = (over: Partial<Jot> = {}): Jot => ({
  id: JOT_ID,
  kind: "text",
  note_path: "notes/daily notes/2026-08-16.md",
  anchor: JOT_ID,
  time: "09:58:00",
  raw_text: "bought milk",
  transcript: null,
  proposed_text: null,
  section: "journal",
  asset_path: null,
  file_id: null,
  status: "done",
  attempts: 0,
  error: null,
  received_at: NOW - 2000,
  updated_at: NOW - 2000,
  ...over,
});

/** Per-method behavior of a fake. A function is called with the arguments, anything else
 *  is returned as is. */
export type Behaviors = Record<string, unknown>;

export type Call = { method: string; payload: any };

export type Run = {
  /** Timeline entries of this update, in order. */
  events: string[];
  /** `events` as one line: repeats collapsed to `name×N`, joined with " > ". */
  rendered: string;
  calls: Call[];
  /** Texts of the Telegram calls of one method (sendMessage, editMessageText...). */
  texts(method: string): string[];
};

const ZERO_STATS = {
  total: 0,
  text: 0,
  audio: 0,
  image: 0,
  video: 0,
  done: 0,
  failed: 0,
  abandoned: 0,
  inflight: 0,
};
const ZERO_COUNTS = {
  pending: 0,
  processing: 0,
  done: 0,
  failed: 0,
  abandoned: 0,
  deleted: 0,
};

function recorder(
  layer: string,
  timeline: string[],
  impl: Behaviors,
  defaults: Behaviors,
  opts: { sync?: string[]; quiet?: string[]; props?: Behaviors } = {},
): any {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        if (opts.props && prop in opts.props) return opts.props[prop];
        const run = (args: unknown[]) => {
          if (!opts.quiet?.includes(prop)) timeline.push(`${layer}.${prop}`);
          const b = prop in impl ? impl[prop] : defaults[prop];
          return typeof b === "function" ? b(...args) : b;
        };
        if (opts.sync?.includes(prop)) return (...args: unknown[]) => run(args);
        return async (...args: unknown[]) => run(args);
      },
    },
  );
}

export function renderTimeline(events: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < events.length; ) {
    let n = 1;
    while (events[i + n] === events[i]) n++;
    out.push(n > 1 ? `${events[i]}×${n}` : events[i]!);
    i += n;
  }
  return out.join(" > ");
}

const user = { id: OWNER, is_bot: false, first_name: "Lucas" };
const chat = { id: CHAT, type: "private" as const };

export async function botHarness() {
  const { ScribaBot } = await import("../bot.ts");
  const timeline: string[] = [];
  let calls: Call[] = [];
  const settings = new Map<string, string>();
  let messageId = 100;
  let sentId = 900;
  let updateId = 1;

  const repoImpl: Behaviors = {};
  const obsidianImpl: Behaviors = {};
  const queueImpl: Behaviors = {};
  const enricherImpl: Behaviors = {};
  const processorImpl: Behaviors = {};
  const schedulerImpl: Behaviors = {};
  const transcriberImpl: Behaviors = {};
  const links = { entries: [] as { note: string; alias: string }[] };
  const failApi = new Set<string>();

  const repo = recorder("repo", timeline, repoImpl, {
    ...fakeSettings(settings),
    stopwordList: [],
    rejectionList: [],
    registeredLinks: [],
    recentJots: [],
    failedJots: [],
    jotsInRange: [],
    jotsPage: [],
    groupFollowers: [],
    queuedEdits: [],
    windowStats: ZERO_STATS,
    statusCounts: ZERO_COUNTS,
    resetProcessing: 0,
    resetFailed: 0,
  });
  const obsidian: any = recorder(
    "obsidian",
    timeline,
    obsidianImpl,
    {
      dailyPath: (date: string) => `notes/daily notes/${date}.md`,
      ...noteOps(() => obsidian),
      readNote: "",
    },
    { sync: ["dailyPath"], quiet: ["dailyPath"] },
  );
  const queue = recorder(
    "queue",
    timeline,
    queueImpl,
    {},
    {
      sync: ["add"],
      props: { depth: 0 },
    },
  );
  const enricher = recorder(
    "enricher",
    timeline,
    enricherImpl,
    {},
    {
      sync: ["setModel"],
    },
  );
  const processor = recorder("processor", timeline, processorImpl, {});
  const scheduler = recorder(
    "scheduler",
    timeline,
    schedulerImpl,
    {},
    {
      sync: ["setRatingTime"],
    },
  );
  const transcriber = recorder(
    "transcriber",
    timeline,
    transcriberImpl,
    {
      transcribe: "",
    },
    { props: { chain: "fake" } },
  );
  const linkIndex = {
    list: () => links.entries,
    stats: () => ({ enabled: true, files: 2, aliases: 3 }),
  };
  const health = { snapshot: () => [] };

  const bot: any = new ScribaBot(
    repo,
    obsidian,
    enricher,
    transcriber,
    linkIndex as any,
    {} as any,
    "0.0.0",
    "0123456789",
    NOW,
  );
  bot.setQueue(queue);
  bot.setProcessor(processor);
  bot.setHealth(health as any);
  bot.setScheduler(scheduler);
  bot.bot.botInfo = {
    id: 99,
    is_bot: true,
    first_name: "scriba",
    username: "scriba_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };
  bot.bot.api.config.use(
    async (_prev: unknown, method: string, payload: any) => {
      calls.push({ method, payload });
      if (method === "answerCallbackQuery") {
        const mark = payload?.show_alert ? "ack!" : "ack";
        timeline.push(`${mark}(${payload?.text ?? ""})`);
      } else {
        timeline.push(`tg.${method}`);
      }
      if (failApi.has(method))
        return {
          ok: false,
          error_code: 400,
          description: "Bad Request: failed",
        };
      if (method === "sendMessage")
        return {
          ok: true,
          result: {
            message_id: sentId++,
            date: 0,
            chat,
            text: payload.text,
          },
        };
      return { ok: true, result: true };
    },
  );

  /** Run one update to the end and report what it did. */
  async function run(update: object): Promise<Run> {
    timeline.length = 0;
    calls = [];
    // handleUpdates is what long polling calls: a handler error reaches bot.catch.
    await bot.bot.handleUpdates([{ update_id: updateId++, ...update }]);
    // Chained sends (command mode) finish a tick after the handler returns.
    await new Promise((resolve) => setImmediate(resolve));
    const done = calls;
    const events = [...timeline];
    return {
      events,
      rendered: renderTimeline(events),
      calls: done,
      texts: (method) =>
        done.filter((c) => c.method === method).map((c) => c.payload.text),
    };
  }

  const message = (extra: object) => ({
    message_id: messageId++,
    date: NOW / 1000,
    chat,
    from: user,
    ...extra,
  });
  const textExtra = (text: string) => {
    const command = /^\/\S+/.exec(text);
    return command
      ? {
          text,
          entities: [
            { type: "bot_command", offset: 0, length: command[0].length },
          ],
        }
      : { text };
  };
  type Reply = { message_id: number; text?: string };
  const replyTo = (r?: Reply) =>
    r ? { reply_to_message: { date: 0, chat, ...r } } : {};

  return {
    bot,
    timeline,
    settings,
    links,
    failApi,
    repo: repoImpl,
    obsidian: obsidianImpl,
    queue: queueImpl,
    enricher: enricherImpl,
    processor: processorImpl,
    scheduler: schedulerImpl,
    transcriber: transcriberImpl,
    run,
    /** A button tap on a message that has `text` and, optionally, a replied-to history. */
    tap: (data: string, over: { message?: object | null } = {}) =>
      run({
        callback_query: {
          id: "cb",
          from: user,
          chat_instance: "ci",
          data,
          message:
            over.message === null
              ? undefined
              : {
                  message_id: 50,
                  date: 0,
                  chat,
                  text: "card",
                  ...over.message,
                },
        },
      }),
    say: (text: string, reply?: Reply) =>
      run({ message: message({ ...textExtra(text), ...replyTo(reply) }) }),
    /** A non-text message: `{ voice: {...} }`, `{ photo: [...] }`, `{ sticker: {...} }`. */
    media: (extra: object) => run({ message: message(extra) }),
    edited: (extra: object, id = 77) =>
      run({
        edited_message: { ...message(extra), message_id: id, edit_date: 1 },
      }),
    reaction: (emojiAdded: string[], id = 77) =>
      run({
        message_reaction: {
          chat,
          message_id: id,
          user,
          date: 0,
          old_reaction: [],
          new_reaction: emojiAdded.map((emoji) => ({ type: "emoji", emoji })),
        },
      }),
  };
}

export type Harness = Awaited<ReturnType<typeof botHarness>>;
