// Drives the app createScriba builds through grammy's handleUpdate with in-memory collaborators.
// Every call a handler makes to the repository, Obsidian, the queue or Telegram is recorded
// on one ordered timeline, which is what the routing and ack-ledger tests assert against.

import { createScriba } from "../app.ts";
import type { Jot } from "../domain/jot/entity.ts";
import { testConfig } from "./config.ts";
import { type ApiCall, BOT_INFO, FakeSettings, recordingApi } from "./fakes.ts";
import { noteOps } from "./note-ops.ts";
import { sampleJot as baseJot } from "./sqlite.ts";

export const OWNER = 1;
export const CHAT = 1;
export const NOW = Date.UTC(2026, 7, 16, 10, 0, 0);
export const JOT_ID = "aaaaaaaa";
/** The dash the bot's own messages use, for asserting their exact text. */
export const EM = String.fromCharCode(0x2014);

export const sampleJot = (over: Partial<Jot> = {}): Jot =>
  baseJot(JOT_ID, {
    note_path: "notes/daily notes/2026-08-16.md",
    time: "09:58:00",
    raw_text: "bought milk",
    status: "done",
    received_at: NOW - 2000,
    updated_at: NOW - 2000,
    ...over,
  });

/** Per-method behavior of a fake. A function is called with the arguments, anything else
 *  is returned as is. */
export type Behaviors = Record<string, unknown>;

export type Call = ApiCall;

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
          const member = prop in impl ? impl[prop] : defaults[prop];
          return typeof member === "function" ? member(...args) : member;
        };
        if (opts.sync?.includes(prop)) return (...args: unknown[]) => run(args);
        return async (...args: unknown[]) => run(args);
      },
    },
  );
}

export function renderTimeline(events: string[]): string {
  const out: string[] = [];
  for (let index = 0; index < events.length; ) {
    let repeats = 1;
    while (events[index + repeats] === events[index]) repeats++;
    out.push(repeats > 1 ? `${events[index]}×${repeats}` : events[index]!);
    index += repeats;
  }
  return out.join(" > ");
}

const user = { id: OWNER, is_bot: false, first_name: "Lucas" };
const chat = { id: CHAT, type: "private" as const };

export async function botHarness() {
  const timeline: string[] = [];
  const settings = new Map<string, string>();
  let messageId = 100;
  let updateId = 1;

  const repoImpl: Behaviors = {};
  const obsidianImpl: Behaviors = {};
  const queueImpl: Behaviors = {};
  const enricherImpl: Behaviors = {};
  const processorImpl: Behaviors = {};
  const schedulerImpl: Behaviors = {};
  const transcriberImpl: Behaviors = {};
  const links = { entries: [] as { note: string; alias: string }[] };
  const telegram = recordingApi({
    onCall: ({ method, payload }) => {
      if (method !== "answerCallbackQuery")
        return void timeline.push(`tg.${method}`);
      const mark = payload?.show_alert ? "ack!" : "ack";
      timeline.push(`${mark}(${payload?.text ?? ""})`);
    },
  });

  const repo = recorder("repo", timeline, repoImpl, {
    ...new FakeSettings(settings),
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
    resetForRetry: true,
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
  const scheduler = recorder("scheduler", timeline, schedulerImpl, {});
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
    enabled: true,
  };
  const health = { snapshot: () => [] };
  const github = {
    latest: async () => null,
    recent: async () => [],
    byVersion: async () => null,
  };

  const bot: any = await createScriba(
    testConfig,
    { version: "0.0.0", sha: "0123456789" },
    {
      repo,
      obsidian,
      enricher,
      transcriber,
      links: linkIndex as never,
      scheduler,
      queue,
      processing: processor,
      health: health as never,
      github: github as never,
    },
  );
  bot.bot.botInfo = BOT_INFO;
  bot.bot.api.config.use(telegram.transformer as never);

  /** Run one update to the end and report what it did. */
  async function run(update: object): Promise<Run> {
    timeline.length = 0;
    const first = telegram.calls.length;
    // handleUpdates is what long polling calls: a handler error reaches bot.catch.
    await bot.bot.handleUpdates([{ update_id: updateId++, ...update }]);
    // Chained sends (command mode) finish a tick after the handler returns.
    await new Promise((resolve) => setImmediate(resolve));
    const done = telegram.calls.slice(first);
    const events = [...timeline];
    return {
      events,
      rendered: renderTimeline(events),
      calls: done,
      texts: (method) =>
        done
          .filter((call) => call.method === method)
          .map((call) => call.payload.text),
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
  const replyTo = (target?: Reply) =>
    target ? { reply_to_message: { date: 0, chat, ...target } } : {};

  return {
    bot,
    timeline,
    settings,
    links,
    failApi: telegram.fail,
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
