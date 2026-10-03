// A task being composed — typed in task mode, or proposed from a jot — before it is
// written into one of the task notes. Drafts live here because a description can't ride in
// Telegram's 64 bytes of callback data, and a confirmation card whose buttons go dead on a
// restart is worse than one that survives it. Created tasks are NOT mirrored here: the two
// task notes stay the single source of truth, so a task edited in Obsidian is still the
// task scriba lists.
export async function up(knex) {
  await knex.schema.createTable("task_drafts", (table) => {
    table.text("id").primary();
    table.text("source").notNullable(); // "mode" | "jot"
    table.text("jot_id"); // set for a task spotted in a journal entry
    table.text("type").notNullable(); // "work" | "personal"
    table.text("description").notNullable();
    table.text("start"); // YYYY-MM-DD, optional (falls back to due)
    table.text("due"); // YYYY-MM-DD, mandatory before it can be created
    table.text("source_date").notNullable(); // the day it came from, for "(from [[date]])"
    table.text("status").notNullable(); // pending | created | cancelled | dismissed
    table.bigInteger("chat_id").notNullable();
    table.integer("message_id"); // the confirmation card, edited in place
    table.bigInteger("created_at").notNullable();
    table.bigInteger("updated_at").notNullable();
    table.index(["jot_id"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists("task_drafts");
}
