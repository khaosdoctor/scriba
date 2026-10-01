import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { Bot } from "grammy";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Repository } from "./db.ts";
import { loadConfig } from "./models/config.ts";
import { HealthMonitor } from "./services/health.ts";
import { LinkIndex } from "./services/links.ts";

// The classes still read the config singleton, which parses the environment on import.
const env = {
  TELEGRAM_BOT_TOKEN: "t",
  ALLOWED_TELEGRAM_USER_ID: "1",
  OBSIDIAN_API_KEY: "o",
  SCRIBA_VAULT_HOST_PATH: "",
};
Object.assign(process.env, env);

const { createScriba } = await import("./index.ts");
const { Scheduler } = await import("./lib/scheduler.ts");
const { Enricher } = await import("./services/enrich.ts");

type Scriba = Awaited<ReturnType<typeof createScriba>>;
type Seams = NonNullable<Parameters<typeof createScriba>[2]>;

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
  const { api } = (app.bot as unknown as { bot: Bot }).bot;
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
  const write = Repository.prototype.setSetting;
  t.mock.method(
    Repository.prototype,
    "setSetting",
    function (this: Repository, key: string, value: string) {
      events.push(`set ${key}=${value}`);
      return write.call(this, key, value);
    },
  );
}

dbTest("createScriba wires everything and starts nothing", async (t) => {
  const started = {
    scheduler: t.mock.method(Scheduler.prototype, "start"),
    health: t.mock.method(HealthMonitor.prototype, "start"),
    links: t.mock.method(LinkIndex.prototype, "start"),
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
  const models: string[] = [];
  const attach = Enricher.prototype.setSwitchNotifier;
  t.mock.method(
    Enricher.prototype,
    "setSwitchNotifier",
    function (this: { model: string }, fn: never) {
      models.push(this.model);
      return attach.call(this as never, fn);
    },
  );
  const build = { version: "9.9.9", sha: "abc" };

  await (await createScriba(config, build)).stop();
  const saved = await Repository.open(config.dbPath);
  await saved.setSetting("enrichModel", "saved-model");
  await saved.close();
  await (await createScriba(config, build)).stop();

  assert.deepEqual(models, [config.enrich.model, "saved-model"]);
});

dbTest("a model switch is told to the owner with its reason", async () => {
  let notify!: Parameters<
    InstanceType<typeof Enricher>["setSwitchNotifier"]
  >[0];
  const enricher = {
    setSwitchNotifier: (fn: typeof notify) => {
      notify = fn;
    },
  } as unknown as Seams["enricher"];
  const app = await createScriba(
    configFor(),
    { version: "9.9.9", sha: "abc" },
    { obsidian: fakeObsidian, transcriber: fakeTranscriber, enricher },
  );
  const calls = fakeTelegram(app);

  await notify("fallback", "groq-model", new Error("usage exhausted"));
  await notify("primary", "haiku", undefined);
  await notify("down", "none", "overloaded");
  await app.stop();

  const texts = calls.map((c) => String(c.payload.text));
  assert.match(texts[0]!, /fallback model groq-model[\s\S]*usage exhausted/);
  assert.match(texts[1]!, /back on haiku/);
  assert.match(texts[2]!, /Every enrichment model is down[\s\S]*overloaded/);
});
