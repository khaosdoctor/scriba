// Voice fix applies on its own now: the raw transcript is kept in original_transcript (the
// old, unused proposed_text column) for the 📝 Use original button, and a split piece
// records its parent_id so that button can take the old pieces out before re-splitting.
export async function up(knex) {
  await knex.schema.alterTable("jots", (table) => {
    table.renameColumn("proposed_text", "original_transcript");
    table.text("parent_id").nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable("jots", (table) => {
    table.renameColumn("original_transcript", "proposed_text");
    table.dropColumn("parent_id");
  });
}
