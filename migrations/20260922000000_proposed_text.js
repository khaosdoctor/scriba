// Voice-fix feature: stores the LLM-proposed transcript alongside the original
// so the user can pick which one to enrich.
export async function up(knex) {
	await knex.schema.alterTable("jots", (t) => {
		t.text("proposed_text").nullable();
	});
}

export async function down(knex) {
	await knex.schema.alterTable("jots", (t) => {
		t.dropColumn("proposed_text");
	});
}
