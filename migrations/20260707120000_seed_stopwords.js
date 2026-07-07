/**
 * Standard NLTK English stopword list. The init seed held only a handful of words, so
 * filler like "another"/"again"/"also" leaked through and flooded the confirm prompts.
 * Excludes content nouns ("test", "note") on purpose — those are the learn-on-reject
 * flow's job. onConflict.ignore keeps manual DB edits intact.
 */

const STOPWORDS = [
  "a", "about", "above", "after", "again", "against", "all", "also", "am", "an",
  "and", "another", "any", "anybody", "anyone", "anything", "are", "aren't", "as",
  "at", "back", "be", "because", "been", "before", "being", "below", "between",
  "both", "but", "by", "can", "cannot", "can't", "could", "couldn't", "did", "didn't",
  "do", "does", "doesn't", "doing", "don't", "down", "during", "each", "either",
  "else", "even", "ever", "every", "everybody", "everyone", "everything", "few",
  "for", "from", "further", "get", "got", "had", "hadn't", "has", "hasn't", "have",
  "haven't", "having", "he", "her", "here", "hers", "herself", "him", "himself",
  "his", "how", "however", "i", "if", "in", "into", "is", "isn't", "it", "its",
  "itself", "just", "let", "let's", "like", "make", "many", "may", "maybe", "me",
  "might", "mine", "more", "most", "much", "must", "mustn't", "my", "myself", "need",
  "neither", "never", "no", "nobody", "none", "nor", "not", "nothing", "now", "of",
  "off", "often", "on", "once", "one", "only", "onto", "or", "other", "others",
  "ought", "our", "ours", "ourselves", "out", "over", "own", "quite", "rather",
  "really", "same", "shall", "she", "should", "shouldn't", "so", "some", "somebody",
  "someone", "something", "sometimes", "still", "such", "than", "that", "that's",
  "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they",
  "thing", "things", "this", "those", "though", "through", "to", "too", "under",
  "until", "up", "upon", "us", "very", "was", "wasn't", "way", "we", "well", "were",
  "weren't", "what", "when", "where", "whether", "which", "while", "who", "whom",
  "whose", "why", "will", "with", "won't", "would", "wouldn't", "yeah", "yes", "yet",
  "you", "your", "yours", "yourself", "yourselves",
];

export async function up(knex) {
  const rows = [...new Set(STOPWORDS.map((w) => w.toLowerCase()))].map((word) => ({ word }));
  await knex("stopwords").insert(rows).onConflict("word").ignore();
}

export async function down(knex) {
  // Leave the words in place — a rollback shouldn't resurrect the mislink noise.
}
