// The line's own words before a past-day move filed the rewrite, so undo can put them back.
export async function up(knex) {
  await knex.schema.alterTable("jots", (table) => {
    table.text("pre_move_text");
  });
}

export async function down(knex) {
  await knex.schema.alterTable("jots", (table) => {
    table.dropColumn("pre_move_text");
  });
}
