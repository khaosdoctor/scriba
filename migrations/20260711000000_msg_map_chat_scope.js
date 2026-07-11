// tg_message_id is only unique per chat, not globally — msg_map was keyed by message id
// alone, so the same id turning up in two different chats (the allowed user's DM and a
// group they're both in, say) could collide and route a reply/edit to the wrong jot.
// Recreated with a composite (chat_id, tg_message_id) key. Old rows carry no chat id and
// are short-lived reply-routing pointers with no expiry logic, so dropping them is safe —
// a reply to a message from before this migration just won't resolve to a jot (same as
// any other expired/missing mapping), and a fresh mapping is written on the next intake.
export async function up(knex) {
	await knex.schema.dropTableIfExists("msg_map");
	await knex.schema.createTable("msg_map", (t) => {
		t.bigInteger("chat_id").notNullable();
		t.bigInteger("tg_message_id").notNullable();
		t.string("jot_id", 8).notNullable();
		t.primary(["chat_id", "tg_message_id"]);
	});
}

export async function down(knex) {
	await knex.schema.dropTableIfExists("msg_map");
	await knex.schema.createTable("msg_map", (t) => {
		t.bigInteger("tg_message_id").primary();
		t.string("jot_id", 8).notNullable();
	});
}
