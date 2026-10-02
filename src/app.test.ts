import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { Bot } from "grammy";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createScriba } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Repository } from "./data/repositories/index.ts";
import { SettingsRepository } from "./data/repositories/settings.ts";
import { VaultService } from "./data/repositories/vault.ts";
import type { SettingKey } from "./domain/setting/entity.ts";
import { Scheduler } from "./libs/scheduler.ts";
import { WIZARD_RATING_TIME_REF } from "./libs/wizard.ts";
import type { SwitchNotifier } from "./services/enrich.ts";
import { HealthMonitor } from "./services/health.ts";

const env = {
  TELEGRAM_BOT_TOKEN: "t",
  ALLOWED_TELEGRAM_USER_ID: "1",
  OBSIDIAN_API_KEY: "o",
  SCRIBA_VAULT_HOST_PATH: "",
};

type Scriba = Awaited<ReturnType<typeof createScriba>>;

const EM = String.fromCharCode(0x2014);
const COMMANDS = [
  ["start", "What scriba does"],
  ["menu", "Open the interactive control menu"],
  ["rate", "Rate a day 1–10 (today, or /rate YYYY-MM-DD)"],
  ["habits", "Review habits (yesterday, or /habits YYYY-MM-DD)"],
  ["reprocess", `Reprocess jots ${EM} a day, a date range, or one jot`],
  ["command", "Open a vault assistant session (/done to close)"],
  ["task", "Turn every message into a task (/done to close)"],
  ["taskadd", "Add one task in one message: /taskadd <what and when>"],
  ["tasks", `List your tasks ${EM} open, today, this week, done`],
  ["done", "Close the vault assistant or task session"],
  ["delete", "Reply to a journal message with /delete to remove it"],
  ["version", "bot version + commit sha"],
  ["changelog", `what's new ${EM} /changelog [version|N]`],
  ["stats", `jot counts ${EM} /stats [today|week|all]`],
  ["status", "health snapshot"],
  ["failed", "recent failed/abandoned jots, each with retry + delete buttons"],
  ["jot", `dump one jot's record ${EM} /jot <id>`],
  ["flush", "drain the flush queue now"],
  ["retry", `requeue failed jots ${EM} /retry [id|all]`],
  ["sweep", "run the retry sweep now"],
  ["unstick", "reset jots wedged in 'processing'"],
  ["stopword", `manage stopwords ${EM} /stopword add|del|list [word|page]`],
  ["rejections", `list learned link-rejections ${EM} /rejections [page]`],
  ["unreject", "undo a link-rejection (menu, or /unreject <word> <note>)"],
  ["help", "list admin commands"],
].map(([command, description]) => ({ command, description }));

const nativeSqlite = await Repository.open(":memory:").then(
  (repo) => repo.close().then(() => true),
  () => false,
);
const dbTest = (name: string, fn: (t: TestContext) => Promise<void>) =>
  test(name, { skip: !nativeSqlite && "native sqlite unavailable" }, fn);

// Nothing here may reach the network: probes and release lookups fail at once.
const offline = new MockAgent();
offline.disableNetConnect();
setGlobalDispatcher(offline);

const configFor = (dbPath = ":memory:", extra: Record<string, string> = {}) =>
  loadConfig({ ...env, DB_PATH: dbPath, ...extra });

const fakeObsidian = { dispatcher: undefined } as never;
const fakeTranscriber = {} as never;

/** Answers the Telegram calls of one app and records them, in order, on `events`. */
function fakeTelegram(
  app: Scriba,
  events: string[] = [],
  opts: { failSend?: boolean } = {},
) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const { api } = app.bot;
  api.config.use((async (
    _prev: unknown,
    method: string,
    payload: Record<string, unknown>,
  ) => {
    calls.push({ method, payload });
    switch (method) {
      case "getMe":
        return {
          ok: true,
          result: {
            id: 9,
            is_bot: true,
            first_name: "scriba",
            username: "scriba_bot",
          },
        };
      case "getUpdates":
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: true, result: [] };
      case "sendMessage":
        events.push("tg.sendMessage");
        if (opts.failSend)
          return {
            ok: false,
            error_code: 500,
            description: "Internal Server Error",
          };
        return {
          ok: true,
          result: {
            message_id: 1,
            date: 0,
            chat: { id: 1, type: "private" },
            text: payload.text,
          },
        };
      default:
        return { ok: true, result: true };
    }
  }) as never);
  return calls;
}

/** Records every settings write on `events`, then performs it. */
function recordSettingWrites(t: TestContext, events: string[]) {
  const write = SettingsRepository.prototype.set;
  t.mock.method(
    SettingsRepository.prototype,
    "set",
    function (this: SettingsRepository, key: SettingKey, value: string) {
      events.push(`set ${key}=${value}`);
      return write.call(this, key, value);
    },
  );
}

dbTest("createScriba wires everything and starts nothing", async (t) => {
  const started = {
    scheduler: t.mock.method(Scheduler.prototype, "start"),
    health: t.mock.method(HealthMonitor.prototype, "start"),
    links: t.mock.method(VaultService.prototype, "startIndex"),
    polling: t.mock.method(Bot.prototype, "start"),
  };
  const closed = t.mock.method(Repository.prototype, "close");

  const app = await createScriba(
    configFor(),
    { version: "9.9.9", sha: "abc" },
    { obsidian: fakeObsidian, transcriber: fakeTranscriber },
  );
  for (const [name, spy] of Object.entries(started))
    assert.equal(spy.mock.callCount(), 0, `${name} started at creation`);

  await app.stop();
  assert.equal(closed.mock.callCount(), 1);
});

dbTest(
  "the daily jobs read their own configured times, and only the rating arms before it runs",
  async (t) => {
    const daily = t.mock.method(Scheduler.prototype, "daily");
    const every = t.mock.method(Scheduler.prototype, "every");
    const app = await createScriba(
      configFor(":memory:", {
        SUMMARY_TIME: "21:00",
        RATING_TIME: "22:00",
        HABITS_TIME: "23:00",
        TASKS_TIME: "07:00",
      }),
      { version: "9.9.9", sha: "abc" },
      { obsidian: fakeObsidian, transcriber: fakeTranscriber },
    );

    const jobs = [];
    for (const { arguments: args } of daily.mock.calls) {
      const [name, time, , options] = args as unknown as [
        string,
        () => Promise<string> | string,
        unknown,
        { armBeforeRun?: boolean } | undefined,
      ];
      jobs.push([name, await time(), options?.armBeforeRun ?? false]);
    }
    await app.stop();
    assert.deepEqual(jobs, [
      ["summary", "21:00", false],
      ["rating", "22:00", true],
      ["habits", "23:00", false],
      ["tasks", "07:00", false],
    ]);
    assert.deepEqual(
      every.mock.calls.map((c) => c.arguments.slice(0, 2)),
      [["retry", 5 * 60_000]],
    );
  },
);

dbTest(
  "a rating time typed in the menu re-arms the nightly job on the scheduler that registered it",
  async (t) => {
    const daily = t.mock.method(Scheduler.prototype, "daily");
    const rearm = t.mock.method(Scheduler.prototype, "rearm", async () => {});
    const app = await createScriba(
      configFor(),
      { version: "9.9.9", sha: "abc" },
      { obsidian: fakeObsidian, transcriber: fakeTranscriber },
    );
    const calls = fakeTelegram(app);
    const { bot } = app;
    const chat = { id: 1, type: "private" as const, first_name: "Lucas" };

    await bot.init();
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 2,
        date: 0,
        chat,
        from: { id: 1, is_bot: false, first_name: "Lucas" },
        text: "23:30",
        reply_to_message: {
          message_id: 1,
          date: 0,
          chat,
          text: `when? ${WIZARD_RATING_TIME_REF}`,
          reply_to_message: undefined,
        },
      },
    });
    await app.stop();

    const owner = daily.mock.calls.find((c) => c.arguments[0] === "rating");
    assert.ok(owner?.this instanceof Scheduler, "daily('rating') registered");
    assert.deepEqual(
      rearm.mock.calls.map((c) => c.arguments),
      [["rating"]],
    );
    assert.equal(rearm.mock.calls[0]?.this, owner.this);
    assert.equal(
      calls.find((c) => c.method === "sendMessage")?.payload.text,
      "🕛 nightly rating at 23:30",
    );
  },
);

dbTest(
  "start seeds the models, registers the commands and announces the deploy",
  async (t) => {
    const events: string[] = [];
    recordSettingWrites(t, events);
    const config = configFor();
    const app = await createScriba(config, { version: "9.9.9", sha: "abc" });
    const calls = fakeTelegram(app, events);

    await app.start();
    await app.stop();

    assert.deepEqual(
      calls.find((c) => c.method === "setMyCommands")?.payload.commands,
      COMMANDS,
    );
    assert.deepEqual(events, [
      `set enrichModel=${config.enrich.model}`,
      `set voiceFixModel=${config.voiceFix.model}`,
      "tg.sendMessage",
      "set deployId=9.9.9@abc",
    ]);
    const notice = calls.find((c) => c.method === "sendMessage")?.payload;
    assert.equal(notice?.chat_id, 1);
    assert.match(String(notice?.text), /9\.9\.9 \(abc\)/);
  },
);

dbTest(
  "the deploy notice and the model seeding follow the database, not the process",
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "scriba-index-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = configFor(join(dir, "scriba.db"));
    const events: string[] = [];
    recordSettingWrites(t, events);

    const boots = [
      {
        sha: "abc",
        failSend: true,
        expected: [
          `set enrichModel=${config.enrich.model}`,
          `set voiceFixModel=${config.voiceFix.model}`,
          "tg.sendMessage",
        ],
      },
      {
        sha: "abc",
        expected: ["tg.sendMessage", "set deployId=9.9.9@abc"],
      },
      { sha: "abc", expected: [] },
      {
        sha: "def",
        expected: ["tg.sendMessage", "set deployId=9.9.9@def"],
      },
    ];
    for (const { sha, failSend, expected } of boots) {
      events.length = 0;
      const app = await createScriba(config, { version: "9.9.9", sha });
      fakeTelegram(app, events, { failSend });
      await app.start();
      await app.stop();
      assert.deepEqual(
        events,
        expected,
        `boot of ${sha}, failSend ${failSend}`,
      );
    }
  },
);

dbTest("the enricher starts on the model saved in the database", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "scriba-index-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = configFor(join(dir, "scriba.db"), {
    GROQ_API_KEY: "g",
    OPENCODE_GO_API_KEY: "oc",
  });
  const build = { version: "9.9.9", sha: "abc" };
  const modelOf = (app: Scriba) =>
    (app.enricher as unknown as { model: string }).model;

  const first = await createScriba(config, build);
  await first.stop();
  const saved = await Repository.open(config.dbPath);
  await saved.setSetting("enrichModel", "saved-model");
  await saved.close();
  const second = await createScriba(config, build);
  await second.stop();

  assert.deepEqual(
    [modelOf(first), modelOf(second)],
    [config.enrich.model, "saved-model"],
  );
});

dbTest("a model switch is told to the owner with its reason", async () => {
  const app = await createScriba(
    configFor(),
    { version: "9.9.9", sha: "abc" },
    { obsidian: fakeObsidian, transcriber: fakeTranscriber },
  );
  const calls = fakeTelegram(app);
  const { notifySwitch: notify } = app.enricher as unknown as {
    notifySwitch: SwitchNotifier;
  };

  await notify("fallback", "groq-model", new Error("usage exhausted"));
  await notify("primary", "haiku", undefined);
  await notify("down", "none", "overloaded");
  await app.stop();

  const texts = calls.map((c) => String(c.payload.text));
  assert.match(texts[0]!, /fallback model groq-model[\s\S]*usage exhausted/);
  assert.match(texts[1]!, /back on haiku/);
  assert.match(texts[2]!, /Every enrichment model is down[\s\S]*overloaded/);
});
