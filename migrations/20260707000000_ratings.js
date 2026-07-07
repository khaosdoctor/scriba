// One row per rated day — the gate that makes daily ratings write-once, so a second
// prompt (another /rate, a re-fired nightly job) can't overwrite an existing rating.
export async function up(knex) {
	await knex.schema.createTable("ratings", (t) => {
		t.text("date").primary(); // YYYY-MM-DD
		t.integer("rating").notNullable();
		t.bigInteger("created_at").notNullable();
	});
}

export async function down(knex) {
	await knex.schema.dropTableIfExists("ratings");
}
