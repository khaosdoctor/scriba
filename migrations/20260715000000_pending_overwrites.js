// Human-in-the-loop gate for the `write_note` instruction tool's "overwrite" mode: an
// overwrite of a note that already has different content is never applied immediately —
// it's queued here and the user is asked to confirm in Telegram (mirrors pending_links'
// ambiguous-link confirmation). "create" and "append" never touch existing content, so
// they don't need this — only "overwrite" does.
export async function up(knex) {
	await knex.schema.createTable("pending_overwrites", (t) => {
		t.string("id", 8).primary();
		t.string("jot_id", 8).notNullable();
		t.text("path").notNullable();
		t.text("content").notNullable();
		t.bigInteger("created_at").notNullable();
	});
}

export async function down(knex) {
	await knex.schema.dropTableIfExists("pending_overwrites");
}
