/** knex config — shared by the CLI (`npm run migrate`) and the app at boot. */
export default {
  client: "better-sqlite3",
  connection: { filename: process.env.DB_PATH || "./data/scriba.db" },
  useNullAsDefault: true,
  migrations: { directory: "./migrations", loadExtensions: [".js"] },
  pool: {
    afterCreate: (conn, done) => {
      conn.pragma("journal_mode = WAL");
      conn.pragma("foreign_keys = ON");
      done(null, conn);
    },
  },
};
