// Pieces split off before parent_id existed carry no link to their jot, so /fix and
// 📝 Use original can't find them. A jot's received_at is Telegram's whole-second date,
// and a piece's is its jot's plus a few milliseconds, so a text jot off the whole second
// belongs to the one jot in the same note at that second. Two jots sharing that second
// leave the piece unlinked rather than guessed.
const MATCH = `
  FROM jots AS parent
  WHERE parent.note_path = jots.note_path
    AND parent.received_at = jots.received_at - (jots.received_at % 1000)
    AND parent.id != jots.id`;

export async function up(knex) {
  await knex.raw(`
    UPDATE jots SET parent_id = (SELECT parent.id ${MATCH})
    WHERE parent_id IS NULL
      AND kind = 'text'
      AND received_at % 1000 != 0
      AND (SELECT COUNT(*) ${MATCH}) = 1`);
}

// A backfilled link can't be told apart from one written at split time, so down keeps them.
export async function down() {}
