// Common words whose note-aliases would otherwise mislink (Norway aliased "no", etc).
// Seeded once; editable in the DB afterwards. EN + PT-BR.
const SEED_STOPWORDS = [
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "no",
  "not",
  "yes",
  "we",
  "i",
  "you",
  "he",
  "she",
  "it",
  "they",
  "on",
  "in",
  "at",
  "to",
  "of",
  "for",
  "is",
  "are",
  "was",
  "be",
  "do",
  "did",
  "so",
  "if",
  "as",
  "my",
  "me",
  "up",
  "us",
  "am",
  "by",
  "ok",
  "e",
  "ou",
  "o",
  "os",
  "as",
  "um",
  "uma",
  "de",
  "da",
  "do",
  "na",
  "no",
  "em",
  "eu",
  "tu",
  "ele",
  "ela",
  "nao",
  "não",
  "sim",
  "que",
  "se",
  "com",
  "por",
  "pra",
  "ja",
  "já",
];

export async function up(knex) {
  await knex.schema.createTable("jots", (table) => {
    table.string("id", 8).primary();
    table.text("kind").notNullable();
    table.text("note_path").notNullable();
    table.text("anchor").notNullable();
    table.text("time").notNullable();
    table.text("raw_text");
    table.text("transcript");
    table.text("asset_path");
    table.text("file_id");
    table.text("status").notNullable().defaultTo("pending");
    table.integer("attempts").notNullable().defaultTo(0);
    table.text("error");
    table.bigInteger("received_at").notNullable();
    table.bigInteger("updated_at").notNullable();
    table.index(["status"]);
  });

  await knex.schema.createTable("msg_map", (table) => {
    table.bigInteger("tg_message_id").primary();
    table.string("jot_id", 8).notNullable();
  });

  await knex.schema.createTable("rejections", (table) => {
    table.text("surface").notNullable();
    table.text("note").notNullable();
    table.bigInteger("created_at").notNullable();
    table.primary(["surface", "note"]);
  });

  await knex.schema.createTable("pending_links", (table) => {
    table.string("id", 8).primary();
    table.string("jot_id", 8).notNullable();
    table.text("surface").notNullable();
    table.text("note").notNullable();
    table.bigInteger("created_at").notNullable();
  });

  // Edits that arrived while a jot was still processing — applied once it's done.
  await knex.schema.createTable("queued_edits", (table) => {
    table.increments("id").primary();
    table.string("jot_id", 8).notNullable();
    table.text("instruction").notNullable();
    table.bigInteger("created_at").notNullable();
    table.index(["jot_id"]);
  });

  await knex.schema.createTable("stopwords", (table) => {
    table.text("word").primary();
  });
  await knex("stopwords").insert(
    [...new Set(SEED_STOPWORDS)].map((word) => ({ word })),
  );
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("stopwords");
  await knex.schema.dropTableIfExists("queued_edits");
  await knex.schema.dropTableIfExists("pending_links");
  await knex.schema.dropTableIfExists("rejections");
  await knex.schema.dropTableIfExists("msg_map");
  await knex.schema.dropTableIfExists("jots");
}
