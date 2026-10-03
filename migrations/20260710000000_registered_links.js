export async function up(knex) {
  await knex.schema.createTable("registered_links", (table) => {
    table.text("surface").notNullable();
    table.text("note").notNullable();
    table.bigInteger("created_at").notNullable();
    table.primary(["surface", "note"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("registered_links");
}
