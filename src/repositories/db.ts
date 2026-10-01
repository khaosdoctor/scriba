import knexLib, { type Knex } from "knex";
import { logger } from "../log.ts";

const log = logger("db");

export async function openDb(dbPath: string): Promise<Knex> {
  // ponytail: app builds knex config inline; the root knexfile.js drives the CLI.
  const k = knexLib({
    client: "better-sqlite3",
    connection: { filename: dbPath },
    useNullAsDefault: true,
    migrations: { directory: "./migrations", loadExtensions: [".js"] },
    pool: {
      afterCreate: (conn: any, done: (e: Error | null, c: any) => void) => {
        conn.pragma("journal_mode = WAL");
        conn.pragma("foreign_keys = ON");
        done(null, conn);
      },
    },
  });
  const [batch, done] = await k.migrate.latest();
  if (done.length)
    log.info({ batch, count: done.length }, "migrations applied");
  return k;
}
