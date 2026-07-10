export async function up(knex) {
	await knex.schema.createTable("registered_links", (t) => {
		t.text("surface").notNullable();
		t.text("note").notNullable();
		t.bigInteger("created_at").notNullable();
		t.primary(["surface", "note"]);
	});
}

export async function down(knex) {
	await knex.schema.dropTableIfExists("registered_links");
}
