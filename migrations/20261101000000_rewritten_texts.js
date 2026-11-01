// The enricher's rewrites for a move, kept until the card is answered: the learning alone
// for TIL, and the entry without its "last tuesday" for a past day.
export async function up(knex) {
  await knex.schema.alterTable("jots", (table) => {
    table.text("til_text");
    table.text("past_text");
  });
}

export async function down(knex) {
  await knex.schema.alterTable("jots", (table) => {
    table.dropColumn("til_text");
    table.dropColumn("past_text");
  });
}
