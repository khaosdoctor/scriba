import assert from "node:assert/strict";
import { test } from "node:test";
import knexLib, { type Knex } from "knex";
import { openDb } from "./data/connections/sqlite.ts";
import { JotRepository } from "./data/repositories/jots.ts";
import { withNative } from "./test/sqlite.ts";

const BEFORE_SECTION = "20260922000000";
const SECTION = "20260930000000";
const TIL_OFFERED = "20260930000001";
const ORIGINAL_TRANSCRIPT = "20261009000000";

const columns = async (knex: Knex) =>
  ((await knex.raw("PRAGMA table_info(jots)")) as { name: string }[]).map(
    (column) => column.name,
  );

const insertOld = (knex: Knex, id: string) =>
  knex.raw(
    "INSERT INTO jots (id, kind, note_path, anchor, time, status, received_at, updated_at) VALUES (?, 'text', 'n.md', ?, '10:00:00', 'pending', 1000, 1000)",
    [id, id],
  );

/** A knex on a fresh sqlite file; throws when better-sqlite3 can't build here. */
async function open(dbPath: string): Promise<Knex> {
  const knex = knexLib({
    client: "better-sqlite3",
    connection: { filename: dbPath },
    useNullAsDefault: true,
    migrations: { directory: "./migrations", loadExtensions: [".js"] },
    pool: {
      afterCreate: (conn: any, done: any) => {
        conn.pragma("foreign_keys = ON");
        done(null, conn);
      },
    },
  });
  try {
    await knex.raw("select 1");
    return knex;
  } catch (error) {
    await knex.destroy();
    throw error;
  }
}

const withDb = (
  testContext: { skip: (why: string) => void },
  fn: (knex: Knex, dbPath: string) => Promise<void>,
) => withNative(testContext, open, fn, { ignoreCloseErrors: true });

async function migrateTo(knex: Knex, version: string) {
  while ((await knex.migrate.currentVersion()) !== version)
    await knex.migrate.up();
}

test("jot_section adds the section column and down removes only that column", async (testContext) => {
  await withDb(testContext, async (knex) => {
    await migrateTo(knex, SECTION);
    const up = await columns(knex);
    assert.ok(up.includes("section"));

    await knex.migrate.down();
    const down = await columns(knex);
    assert.ok(!down.includes("section"));
    assert.deepEqual(
      down,
      up.filter((column) => column !== "section"),
    );
    assert.equal(await knex.migrate.currentVersion(), BEFORE_SECTION);
  });
});

test("rolling jot_section back keeps the rows and the status index", async (testContext) => {
  await withDb(testContext, async (knex) => {
    await migrateTo(knex, SECTION);
    await knex("jots").insert([
      {
        id: "aaaaaaaa",
        kind: "text",
        note_path: "n.md",
        anchor: "aaaaaaaa",
        time: "10:00:00",
        raw_text: "one",
        status: "pending",
        received_at: 1,
        updated_at: 1,
        section: "journal",
      },
      {
        id: "bbbbbbbb",
        kind: "text",
        note_path: "n.md",
        anchor: "bbbbbbbb",
        time: "10:00:01",
        raw_text: "two",
        status: "done",
        received_at: 2,
        updated_at: 2,
        section: "til",
      },
    ]);
    await knex.migrate.down();

    const rows = await knex("jots")
      .select("id", "raw_text", "status")
      .orderBy("id");
    assert.deepEqual(rows, [
      { id: "aaaaaaaa", raw_text: "one", status: "pending" },
      { id: "bbbbbbbb", raw_text: "two", status: "done" },
    ]);
    await assert.rejects(() => knex("jots").select("section"), /section/);
    const indexes = (await knex.raw("PRAGMA index_list(jots)")) as {
      name: string;
    }[];
    assert.ok(indexes.some((index) => index.name.includes("status")));
  });
});

test("jot_section gives rows that predate it the journal section", async (testContext) => {
  await withDb(testContext, async (knex, dbPath) => {
    await migrateTo(knex, BEFORE_SECTION);
    await insertOld(knex, "aaaaaaaa");
    await knex.migrate.latest();
    assert.equal((await knex("jots").first())?.section, "journal");
    await knex.destroy();

    // The repository sees that old row as a journal jot and never as a TIL one.
    const reopened = await openDb(dbPath);
    const repo = new JotRepository(reopened);
    try {
      assert.equal(
        (await repo.lastPendingEnrichableJot("n.md", "journal"))?.id,
        "aaaaaaaa",
      );
      assert.equal(
        await repo.lastPendingEnrichableJot("n.md", "til"),
        undefined,
      );
    } finally {
      await reopened.destroy();
    }
  });
});

test("a row inserted without a section reads back as journal", async (testContext) => {
  await withDb(testContext, async (knex) => {
    await knex.migrate.latest();
    await insertOld(knex, "aaaaaaaa");
    assert.equal((await knex("jots").first())?.section, "journal");
  });
});

test("til_offered adds a column that defaults to false for rows that predate it", async (testContext) => {
  await withDb(testContext, async (knex) => {
    await migrateTo(knex, SECTION);
    await insertOld(knex, "aaaaaaaa");
    await insertOld(knex, "bbbbbbbb");
    await knex.migrate.latest();
    const rows = await knex("jots").select("id", "til_offered").orderBy("id");
    assert.deepEqual(
      rows.map((row) => Number(row.til_offered)),
      [0, 0],
    );
  });
});

test("til_offered down drops only its column, and up again does not collide", async (testContext) => {
  await withDb(testContext, async (knex) => {
    await migrateTo(knex, TIL_OFFERED);
    await insertOld(knex, "aaaaaaaa");
    await insertOld(knex, "bbbbbbbb");
    await knex("jots").where({ id: "aaaaaaaa" }).update({ til_offered: true });

    await knex.migrate.down();
    const down = await columns(knex);
    assert.ok(!down.includes("til_offered"));
    assert.ok(down.includes("section"));
    assert.equal(await knex.migrate.currentVersion(), SECTION);
    assert.equal((await knex("jots").select("id")).length, 2);

    await knex.migrate.latest();
    const rows = await knex("jots").select("til_offered");
    // The earlier offered state is gone with the column, which is expected.
    assert.deepEqual(
      rows.map((row) => Number(row.til_offered)),
      [0, 0],
    );
  });
});

test("original_transcript takes over proposed_text with its data, and down gives it back", async (testContext) => {
  await withDb(testContext, async (knex) => {
    await migrateTo(knex, TIL_OFFERED);
    await insertOld(knex, "aaaaaaaa");
    await knex("jots")
      .where({ id: "aaaaaaaa" })
      .update({ proposed_text: "raw words" });

    await migrateTo(knex, ORIGINAL_TRANSCRIPT);
    assert.deepEqual(
      await knex("jots").select("original_transcript", "parent_id"),
      [{ original_transcript: "raw words", parent_id: null }],
    );

    await knex.migrate.down();
    const down = await columns(knex);
    assert.ok(down.includes("proposed_text"));
    assert.ok(!down.includes("original_transcript"));
    assert.ok(!down.includes("parent_id"));
  });
});

test("old split pieces are linked to the one jot at their whole second, and only that", async (testContext) => {
  await withDb(testContext, async (knex) => {
    await migrateTo(knex, ORIGINAL_TRANSCRIPT);
    const row = (
      id: string,
      receivedAt: number,
      over: Record<string, unknown> = {},
    ) => ({
      id,
      kind: "text",
      note_path: "n.md",
      anchor: id,
      time: "10:00:00",
      status: "done",
      received_at: receivedAt,
      updated_at: receivedAt,
      ...over,
    });
    await knex("jots").insert([
      row("leader01", 5000, { kind: "audio" }),
      row("piece001", 5001),
      row("piece002", 5002),
      row("other001", 9000, { note_path: "other.md" }),
      row("strayp01", 9001),
      row("twin0001", 7000),
      row("twin0002", 7000, { kind: "audio" }),
      row("twinpc01", 7001),
      row("plain001", 8000),
    ]);

    await knex.migrate.latest();
    const links = Object.fromEntries(
      (await knex("jots").select("id", "parent_id")).map((linked) => [
        linked.id,
        linked.parent_id,
      ]),
    );
    assert.deepEqual(links, {
      leader01: null,
      piece001: "leader01",
      piece002: "leader01",
      other001: null,
      strayp01: null,
      twin0001: null,
      twin0002: null,
      twinpc01: null,
      plain001: null,
    });
  });
});

const schema = async (knex: Knex) =>
  (await knex.raw(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'knex_%' ORDER BY type, name",
  )) as { type: string; name: string; sql: string }[];

test("every migration rolls back, and migrating again rebuilds the same schema", async (testContext) => {
  await withDb(testContext, async (knex) => {
    await knex.migrate.latest();
    const built = await schema(knex);
    const stopwords = await knex("stopwords").count("* as n").first();
    assert.ok(built.length > 8);
    assert.ok(Number(stopwords?.n) > 100);

    // A down() that misses a table, index or column would leave it behind or make the
    // next up() collide with it.
    await knex.migrate.rollback(undefined, true);
    assert.deepEqual(await schema(knex), []);
    assert.equal(await knex.migrate.currentVersion(), "none");

    await knex.migrate.latest();
    assert.deepEqual(await schema(knex), built);
    assert.deepEqual(
      await knex("stopwords").count("* as n").first(),
      stopwords,
      "the seeded stopwords come back",
    );
  });
});
