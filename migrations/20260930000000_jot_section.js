// Which daily-note section a jot's line lives under: "journal" or "til".
export async function up(knex) {
  await knex.schema.alterTable("jots", (table) => {
    table.text("section").notNullable().defaultTo("journal");
  });
}

export async function down(knex) {
  await knex.schema.alterTable("jots", (table) => {
    table.dropColumn("section");
  });
}
