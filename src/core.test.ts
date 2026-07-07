import assert from "node:assert/strict";
import { test } from "node:test";
import {
	anchorLine,
	candidates,
	deleteAnchorLine,
	doneMessage,
	donePreview,
	escapeHtml,
	formatDuration,
	formatJotDetail,
	formatStats,
	formatStatus,
	insertJournalLine,
	journalLine,
	makeJotId,
	parseLiteralEdit,
	placeholderLine,
	replaceAnchorLine,
	setFrontmatterNumber,
	tokenize,
} from "./core.ts";
import type { Jot, StatsRow } from "./db.ts";

const STOP = new Set(["no", "we", "i", "on", "e", "de"]);

test("setFrontmatterNumber replaces an existing field in place", () => {
	const note = "---\noverallRating: 5\ntags: [daily]\n---\n\n## Journal\n";
	assert.equal(
		setFrontmatterNumber(note, "overallRating", 8),
		"---\noverallRating: 8\ntags: [daily]\n---\n\n## Journal\n",
	);
});

test("setFrontmatterNumber inserts a missing field before the closing fence", () => {
	const note = "---\ntags: [daily]\n---\n\nbody\n";
	assert.equal(
		setFrontmatterNumber(note, "overallRating", 7),
		"---\ntags: [daily]\noverallRating: 7\n---\n\nbody\n",
	);
});

test("setFrontmatterNumber creates frontmatter when the note has none", () => {
	assert.equal(
		setFrontmatterNumber("# hi\n", "overallRating", 3),
		"---\noverallRating: 3\n---\n\n# hi\n",
	);
});

test("ids are fixed 8-char hex", () => {
	const id = makeJotId();
	assert.match(id, /^[0-9a-f]{8}$/);
});

test("journal + placeholder lines match the vault house style", () => {
	assert.equal(
		journalLine("23:13:18", "hi", "a1b2c3d4"),
		"- _23:13:18 ::_ hi ^a1b2c3d4",
	);
	assert.equal(
		placeholderLine("09:00:00", "deadbeef"),
		"- _09:00:00 ::_ ⏳ ^deadbeef",
	);
});

test("insertJournalLine replaces the empty template bullet on the first jot", () => {
	const note = "# 2026-07-07\n\n## Journal\n- \n";
	const out = insertJournalLine(
		note,
		"Journal",
		"- _19:56:31 ::_ ⏳ ^23c78f08",
	);
	assert.equal(
		out,
		"# 2026-07-07\n\n## Journal\n- _19:56:31 ::_ ⏳ ^23c78f08\n",
	);
});

test("insertJournalLine appends right after the last bullet, no blank line", () => {
	const note = "## Journal\n- _19:56:31 ::_ first ^aaaaaaaa\n";
	const out = insertJournalLine(
		note,
		"Journal",
		"- _19:57:00 ::_ ⏳ ^bbbbbbbb",
	);
	assert.equal(
		out,
		"## Journal\n- _19:56:31 ::_ first ^aaaaaaaa\n- _19:57:00 ::_ ⏳ ^bbbbbbbb\n",
	);
});

test("insertJournalLine stays within the section, before the next heading", () => {
	const note = "## Journal\n- _10:00:00 ::_ a ^aaaaaaaa\n\n## Notes\n- keep\n";
	const out = insertJournalLine(
		note,
		"Journal",
		"- _10:01:00 ::_ ⏳ ^bbbbbbbb",
	);
	assert.equal(
		out,
		"## Journal\n- _10:00:00 ::_ a ^aaaaaaaa\n- _10:01:00 ::_ ⏳ ^bbbbbbbb\n\n## Notes\n- keep\n",
	);
});

test("insertJournalLine inserts right after the heading when the section is empty", () => {
	const note = "## Journal\n";
	const out = insertJournalLine(
		note,
		"Journal",
		"- _10:00:00 ::_ ⏳ ^aaaaaaaa",
	);
	assert.equal(out, "## Journal\n- _10:00:00 ::_ ⏳ ^aaaaaaaa\n");
});

test("replace/delete/read find the line by anchor and leave others intact", () => {
	const note = [
		"## Journal",
		"- _10:00:00 ::_ first ^aaaaaaaa",
		"- _10:01:00 ::_ ⏳ ^bbbbbbbb",
		"- _10:02:00 ::_ third ^cccccccc",
	].join("\n");
	const replaced = replaceAnchorLine(
		note,
		"bbbbbbbb",
		"- _10:01:00 ::_ enriched ^bbbbbbbb",
	);
	assert.ok(replaced?.includes("enriched ^bbbbbbbb"));
	assert.ok(replaced?.includes("first ^aaaaaaaa"));
	assert.ok(!replaced?.includes("⏳"));
	assert.equal(replaceAnchorLine(note, "ffffffff", "x"), null);
	assert.equal(anchorLine(note, "cccccccc"), "- _10:02:00 ::_ third ^cccccccc");

	const deleted = deleteAnchorLine(note, "aaaaaaaa");
	assert.ok(!deleted?.includes("aaaaaaaa"));
	assert.ok(deleted?.includes("cccccccc"));
});

test("candidates drop stopwords/short aliases and honour rejections", () => {
	const index = [
		{ note: "Norway", alias: "no" }, // stopword → dropped
		{ note: "Norway", alias: "Norway" }, // real → kept
		{ note: "We (novel)", alias: "We" }, // 2 chars → dropped
		{ note: "Fume Extractor", alias: "Fume Extractor" }, // multiword → kept
		{ note: "Lev", alias: "Lev" },
	];
	const text =
		"I said no to visiting Norway but fixed the Fume Extractor for Lev";
	const got = candidates(text, index, STOP, new Set());
	assert.deepEqual(got.map((c) => c.note).sort(), [
		"Fume Extractor",
		"Lev",
		"Norway",
	]);

	const rejected = new Set(["lev Lev"]); // user previously said no to Lev
	const got2 = candidates(text, index, STOP, rejected);
	assert.ok(!got2.some((c) => c.note === "Lev"));
});

test("literal edit parser handles sed and natural forms, rejects freeform", () => {
	assert.deepEqual(parseLiteralEdit("s/pot/potentiometer/"), {
		old: "pot",
		new: "potentiometer",
	});
	assert.deepEqual(parseLiteralEdit("replace pot with potentiometer"), {
		old: "pot",
		new: "potentiometer",
	});
	assert.deepEqual(parseLiteralEdit('replace "the cat" with "the dog"'), {
		old: "the cat",
		new: "the dog",
	});
	assert.equal(parseLiteralEdit("make this clearer"), null);
});

test("tokenize keeps accented letters", () => {
	assert.deepEqual(tokenize("Não é fácil"), ["não", "é", "fácil"]);
});

test("donePreview shows enriched text, truncates long, labels attach-only", () => {
	assert.equal(donePreview("text", "  went for a run  "), "went for a run");
	assert.equal(donePreview("audio", "x".repeat(250)), `${"x".repeat(200)}…`);
	assert.equal(donePreview("image", ""), "image saved to the note");
	assert.equal(donePreview("video", "  "), "video saved to the note");
	assert.equal(donePreview("text", ""), "saved");
});

test("escapeHtml neutralises Telegram HTML metacharacters", () => {
	assert.equal(
		escapeHtml(`a <b> & "c" 'd'`),
		"a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39;",
	);
});

test("doneMessage blockquotes the time and escapes content", () => {
	assert.equal(
		doneMessage("14:32:00", "text", "ran <5k> today"),
		"✅ Saved to your journal\n<blockquote>🕒 14:32:00 · ran &lt;5k&gt; today</blockquote>",
	);
});

test("formatDuration picks the two coarsest units", () => {
	assert.equal(formatDuration(45_000), "45s");
	assert.equal(formatDuration(90_000), "1m 30s");
	assert.equal(formatDuration(3 * 3600_000 + 20 * 60_000), "3h 20m");
	assert.equal(formatDuration(2 * 86400_000 + 5 * 3600_000), "2d 5h");
});

test("formatStats hides zero outcome tails", () => {
	const base: StatsRow = {
		total: 4,
		text: 3,
		audio: 1,
		image: 0,
		video: 0,
		done: 4,
		failed: 0,
		abandoned: 0,
		inflight: 0,
	};
	const clean = formatStats("today", base);
	assert.match(clean, /Jots: 4/);
	assert.match(clean, /voice 1/);
	assert.equal(clean.includes("failed"), false); // no failures → no tail
	const withFail = formatStats("today", { ...base, failed: 2, inflight: 1 });
	assert.match(withFail, /in-flight 1 · failed 2/);
});

test("formatStatus summarises health", () => {
	const out = formatStatus({
		counts: { pending: 1, processing: 1, done: 10, failed: 2, abandoned: 0 },
		queueDepth: 3,
		transcriber: "local",
		links: { enabled: true, files: 5, aliases: 9 },
		version: "1.2.3",
		sha: "abcdef1234",
		uptimeMs: 90_000,
	});
	assert.match(out, /scriba 1\.2\.3 \(abcdef1\)/);
	assert.match(out, /10 done · 2 in-flight · 2 failed/); // pending+processing = in-flight
	assert.match(out, /Queue depth: 3/);
	assert.match(out, /Transcriber: local/);
	assert.match(out, /5 files \/ 9 aliases/);
});

test("formatStatus shows a disabled link index", () => {
	const out = formatStatus({
		counts: { pending: 0, processing: 0, done: 0, failed: 0, abandoned: 0 },
		queueDepth: 0,
		transcriber: "remote",
		links: { enabled: false, files: 0, aliases: 0 },
		version: "1",
		sha: "0000000",
		uptimeMs: 0,
	});
	assert.match(out, /Link index: disabled/);
});

test("formatJotDetail truncates long text and includes errors", () => {
	const jot: Jot = {
		id: "deadbeef",
		kind: "audio",
		note_path: "notes/x.md",
		anchor: "deadbeef",
		time: "10:00:00",
		raw_text: null,
		transcript: "x".repeat(400),
		asset_path: null,
		file_id: null,
		status: "failed",
		attempts: 3,
		error: "boom",
		received_at: Date.now(),
		updated_at: Date.now(),
	};
	const out = formatJotDetail(jot);
	assert.match(out, /deadbeef \[audio\] — failed/);
	assert.match(out, /Attempts: 3/);
	assert.match(out, /Error: boom/);
	assert.ok(out.includes("…")); // transcript truncated
});
