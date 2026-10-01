import assert from "node:assert/strict";
import { test } from "node:test";
import knexLib, { type Knex } from "knex";
import { openDb } from "./repositories/db.ts";
import { JotRepository } from "./repositories/jots.ts";
import { removeDb, tempDbPath } from "./test/sqlite.ts";

const BEFORE_SECTION = "20260922000000";
const SECTION = "20260930000000";

const columns = async (k: Knex) =>
  ((await k.raw("PRAGMA table_info(jots)")) as { name: string }[]).map(
    (c) => c.name,
  );

const insertOld = (k: Knex, id: string) =>
  k.raw(
    "INSERT INTO jots (id, kind, note_path, anchor, time, status, received_at, updated_at) VALUES (?, 'text', 'n.md', ?, '10:00:00', 'pending', 1000, 1000)",
    [id, id],
  );

/** A knex on a fresh sqlite file, or null when better-sqlite3 can't build here. */
async function open(dbPath: string): Promise<Knex | null> {
  const k = knexLib({
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
    await k.raw("select 1");
    return k;
  } catch {
    await k.destroy();
    return null;
  }
}

async function withDb(
  t: { skip: (why: string) => void },
  fn: (k: Knex, dbPath: string) => Promise<void>,
) {
  const dbPath = tempDbPath();
  const k = await open(dbPath);
  if (!k) return t.skip("native sqlite unavailable");
  try {
    await fn(k, dbPath);
  } finally {
    await k.destroy().catch(() => {});
    await removeDb(dbPath);
  }
}

async function migrateTo(k: Knex, version: string) {
  while ((await k.migrate.currentVersion()) !== version) await k.migrate.up();
}

test("jot_section adds the section column and down removes only that column", async (t) => {
  await withDb(t, async (k) => {
    await migrateTo(k, SECTION);
    const up = await columns(k);
    assert.ok(up.includes("section"));

    await k.migrate.down();
    const down = await columns(k);
    assert.ok(!down.includes("section"));
    assert.deepEqual(
      down,
      up.filter((c) => c !== "section"),
    );
    assert.equal(await k.migrate.currentVersion(), BEFORE_SECTION);
  });
});

test("rolling jot_section back keeps the rows and the status index", async (t) => {
  await withDb(t, async (k) => {
    await migrateTo(k, SECTION);
    await k("jots").insert([
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
    await k.migrate.down();

    const rows = await k("jots")
      .select("id", "raw_text", "status")
      .orderBy("id");
    assert.deepEqual(rows, [
      { id: "aaaaaaaa", raw_text: "one", status: "pending" },
      { id: "bbbbbbbb", raw_text: "two", status: "done" },
    ]);
    await assert.rejects(() => k("jots").select("section"), /section/);
    const indexes = (await k.raw("PRAGMA index_list(jots)")) as {
      name: string;
    }[];
    assert.ok(indexes.some((i) => i.name.includes("status")));
  });
});

test("jot_section gives rows that predate it the journal section", async (t) => {
  await withDb(t, async (k, dbPath) => {
    await migrateTo(k, BEFORE_SECTION);
    await insertOld(k, "aaaaaaaa");
    await k.migrate.latest();
    assert.equal((await k("jots").first())?.section, "journal");
    await k.destroy();

    // The repository sees that old row as a journal jot and never as a TIL one.
    const k2 = await openDb(dbPath);
    const repo = new JotRepository(k2);
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
      await k2.destroy();
    }
  });
});

test("a row inserted without a section reads back as journal", async (t) => {
  await withDb(t, async (k) => {
    await k.migrate.latest();
    await insertOld(k, "aaaaaaaa");
    assert.equal((await k("jots").first())?.section, "journal");
  });
});

test("jot_section can be rolled back and applied again", async (t) => {
  await withDb(t, async (k) => {
    await migrateTo(k, SECTION);
    await k.migrate.down();
    await migrateTo(k, SECTION);
    assert.ok((await columns(k)).includes("section"));
    assert.equal(await k.migrate.currentVersion(), SECTION);
  });
});

test("til_offered adds a column that defaults to false for rows that predate it", async (t) => {
  await withDb(t, async (k) => {
    await migrateTo(k, SECTION);
    await insertOld(k, "aaaaaaaa");
    await insertOld(k, "bbbbbbbb");
    await k.migrate.latest();
    const rows = await k("jots").select("id", "til_offered").orderBy("id");
    assert.deepEqual(
      rows.map((r) => Number(r.til_offered)),
      [0, 0],
    );
  });
});

test("til_offered down drops only its column, and up again does not collide", async (t) => {
  await withDb(t, async (k) => {
    await k.migrate.latest();
    await insertOld(k, "aaaaaaaa");
    await insertOld(k, "bbbbbbbb");
    await k("jots").where({ id: "aaaaaaaa" }).update({ til_offered: true });

    await k.migrate.down();
    const down = await columns(k);
    assert.ok(!down.includes("til_offered"));
    assert.ok(down.includes("section"));
    assert.equal(await k.migrate.currentVersion(), SECTION);
    assert.equal((await k("jots").select("id")).length, 2);

    await k.migrate.latest();
    const rows = await k("jots").select("til_offered");
    // The earlier offered state is gone with the column, which is expected.
    assert.deepEqual(
      rows.map((r) => Number(r.til_offered)),
      [0, 0],
    );
  });
});

const schema = async (k: Knex) =>
  (await k.raw(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'knex_%' ORDER BY type, name",
  )) as { type: string; name: string; sql: string }[];

test("every migration rolls back, and migrating again rebuilds the same schema", async (t) => {
  await withDb(t, async (k) => {
    await k.migrate.latest();
    const built = await schema(k);
    const stopwords = await k("stopwords").count("* as n").first();
    assert.ok(built.length > 8);
    assert.ok(Number(stopwords?.n) > 100);

    // A down() that misses a table, index or column would leave it behind or make the
    // next up() collide with it.
    await k.migrate.rollback(undefined, true);
    assert.deepEqual(await schema(k), []);
    assert.equal(await k.migrate.currentVersion(), "none");

    await k.migrate.latest();
    assert.deepEqual(await schema(k), built);
    assert.deepEqual(
      await k("stopwords").count("* as n").first(),
      stopwords,
      "the seeded stopwords come back",
    );
  });
});
