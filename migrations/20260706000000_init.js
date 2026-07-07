// Common words whose note-aliases would otherwise mislink (Norway aliased "no", etc).
// Seeded once; editable in the DB afterwards. EN + PT-BR.
const SEED_STOPWORDS = [
	"a",
	"an",
	"the",
	"and",
	"or",
	"but",
	"no",
	"not",
	"yes",
	"we",
	"i",
	"you",
	"he",
	"she",
	"it",
	"they",
	"on",
	"in",
	"at",
	"to",
	"of",
	"for",
	"is",
	"are",
	"was",
	"be",
	"do",
	"did",
	"so",
	"if",
	"as",
	"my",
	"me",
	"up",
	"us",
	"am",
	"by",
	"ok",
	"e",
	"ou",
	"o",
	"os",
	"as",
	"um",
	"uma",
	"de",
	"da",
	"do",
	"na",
	"no",
	"em",
	"eu",
	"tu",
	"ele",
	"ela",
	"nao",
	"não",
	"sim",
	"que",
	"se",
	"com",
	"por",
	"pra",
	"ja",
	"já",
];

export async function up(knex) {
	await knex.schema.createTable("jots", (t) => {
		t.string("id", 8).primary();
		t.text("kind").notNullable();
		t.text("note_path").notNullable();
		t.text("anchor").notNullable();
		t.text("time").notNullable();
		t.text("raw_text");
		t.text("transcript");
		t.text("asset_path");
		t.text("file_id");
		t.text("status").notNullable().defaultTo("pending");
		t.integer("attempts").notNullable().defaultTo(0);
		t.text("error");
		t.bigInteger("received_at").notNullable();
		t.bigInteger("updated_at").notNullable();
		t.index(["status"]);
	});

	await knex.schema.createTable("msg_map", (t) => {
		t.bigInteger("tg_message_id").primary();
		t.string("jot_id", 8).notNullable();
	});

	await knex.schema.createTable("rejections", (t) => {
		t.text("surface").notNullable();
		t.text("note").notNullable();
		t.bigInteger("created_at").notNullable();
		t.primary(["surface", "note"]);
	});

	await knex.schema.createTable("pending_links", (t) => {
		t.string("id", 8).primary();
		t.string("jot_id", 8).notNullable();
		t.text("surface").notNullable();
		t.text("note").notNullable();
		t.bigInteger("created_at").notNullable();
	});

	// Edits that arrived while a jot was still processing — applied once it's done.
	await knex.schema.createTable("queued_edits", (t) => {
		t.increments("id").primary();
		t.string("jot_id", 8).notNullable();
		t.text("instruction").notNullable();
		t.bigInteger("created_at").notNullable();
		t.index(["jot_id"]);
	});

	await knex.schema.createTable("stopwords", (t) => {
		t.text("word").primary();
	});
	await knex("stopwords").insert(
		[...new Set(SEED_STOPWORDS)].map((word) => ({ word })),
	);
}

export async function down(knex) {
	await knex.schema.dropTableIfExists("stopwords");
	await knex.schema.dropTableIfExists("queued_edits");
	await knex.schema.dropTableIfExists("pending_links");
	await knex.schema.dropTableIfExists("rejections");
	await knex.schema.dropTableIfExists("msg_map");
	await knex.schema.dropTableIfExists("jots");
}
