// Runtime-editable key/value settings that outlive a restart (e.g. the transcriber
// mode chosen via /transcriber, which overrides the TRANSCRIBER env default).
export async function up(knex) {
  await knex.schema.createTable("settings", (t) => {
    t.text("key").primary();
    t.text("value").notNullable();
    t.bigInteger("updated_at").notNullable();
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("settings");
}
