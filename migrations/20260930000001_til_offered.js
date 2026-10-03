// "Move this to TIL?" is asked once per jot: a /reprocess must not ask again about a jot
// that was already moved, or kept in the journal on purpose.
export async function up(knex) {
  await knex.schema.alterTable("jots", (table) => {
    table.boolean("til_offered").notNullable().defaultTo(false);
  });
}

export async function down(knex) {
  await knex.schema.alterTable("jots", (table) => {
    table.dropColumn("til_offered");
  });
}
