// Splits a text jot's stored content in two: `raw_text` stays the untouched original
// (as typed, `@@instruction@@` markers included) while `text` holds the stripped,
// enrichable/editable content. Edits fold into `text` from here on, never `raw_text` —
// so a later /reprocess re-enriches the edited text instead of silently reverting to
// the original. `instructions_run` guards against re-running a jot's `@@` instructions
// on reprocess/retry (their vault actions aren't idempotent).
export async function up(knex) {
	await knex.schema.alterTable("jots", (t) => {
		t.text("text");
		t.boolean("instructions_run").notNullable().defaultTo(false);
	});
}

export async function down(knex) {
	await knex.schema.alterTable("jots", (t) => {
		t.dropColumn("text");
		t.dropColumn("instructions_run");
	});
}
