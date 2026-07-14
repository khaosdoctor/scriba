import assert from "node:assert/strict";
import { test } from "node:test";
import {
	anchorLine,
	candidates,
	combineEnrichSource,
	deleteAnchorLine,
	distinctSurfaces,
	doneMessage,
	donePreview,
	editConfirmation,
	enrichableSource,
	entitiesToMarkdown,
	escapeHtml,
	extractInstructions,
	forcedCandidates,
	formatDeployNotice,
	formatDuration,
	formatJotDetail,
	formatStats,
	formatStatus,
	insertJournalLine,
	isBlank,
	isEditableJot,
	isRecoverable,
	jotPreview,
	journalLine,
	linkDateWords,
	makeJotId,
	monthGrid,
	normalizeNotePath,
	parseLiteralEdit,
	placeholderLine,
	pluralize,
	replaceAnchorLine,
	reprocessTargets,
	setFrontmatterNumber,
	stripJournalLine,
	tokenize,
	withinSquashWindow,
} from "./core.ts";
import type { Jot, StatsRow } from "./db.ts";

const STOP = new Set(["no", "we", "i", "on", "e", "de"]);

test("withinSquashWindow: rolling gap folds jots within the window, splits past it", () => {
	assert.equal(withinSquashWindow(1000, 12000, 15000), true); // 11s gap ≤ 15s
	assert.equal(withinSquashWindow(1000, 16001, 15000), false); // 15.001s gap > 15s
	assert.equal(withinSquashWindow(1000, 16000, 15000), true); // exactly 15s
	assert.equal(withinSquashWindow(1000, 2000, 0), false); // window 0 disables
});

test("combineEnrichSource joins parts, dropping blanks", () => {
	assert.equal(
		combineEnrichSource(["first", "  ", "second", ""]),
		"first\nsecond",
	);
	assert.equal(combineEnrichSource([]), "");
	assert.equal(combineEnrichSource([" solo "]), "solo");
});

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

test("forcedCandidates: matches registered surface->note pairs, ignoring length/stopword rules, marked forced", () => {
	const registered = [
		{ surface: "no", note: "Norway" }, // 2 chars + a stopword elsewhere — still forced
		{ surface: "Fume Extractor", note: "Fume Extractor" }, // multiword
		{ surface: "gym", note: "Fitness" },
	];
	const text = "said no to visiting the Fume Extractor room";
	const got = forcedCandidates(text, registered);
	assert.deepEqual(
		got.map((c) => [c.surface, c.note, c.forced]).sort(),
		[
			["Fume Extractor", "Fume Extractor", true],
			["no", "Norway", true],
		].sort(),
	);
});

test("linkDateWords turns relative date phrases into daily-note wikilinks", () => {
	const ref = "2026-07-10"; // a Friday
	assert.equal(
		linkDateWords("I did this yesterday", ref),
		"I did this [[2026-07-09|yesterday]]",
	);
	assert.equal(
		linkDateWords("see you tomorrow", ref),
		"see you [[2026-07-11|tomorrow]]",
	);
	assert.equal(
		linkDateWords("I went to the beach three weeks ago", ref),
		"I went to the beach [[2026-06-19|three weeks ago]]",
	);
	assert.equal(
		linkDateWords("in 2 days we ship", ref),
		"[[2026-07-12|in 2 days]] we ship",
	);
	assert.equal(
		linkDateWords("last month was rough", ref),
		"[[2026-06-10|last month]] was rough",
	);
});

test("linkDateWords ignores bare clock times that carry no date", () => {
	const ref = "2026-07-10";
	assert.equal(linkDateWords("Call is at 3pm", ref), "Call is at 3pm");
	assert.equal(linkDateWords("We land at 22:30", ref), "We land at 22:30");
	assert.equal(linkDateWords("meeting at 9", ref), "meeting at 9");
	// but a time attached to an actual day keyword still links
	assert.equal(
		linkDateWords("Met the doctor at 3pm today", ref),
		"Met the doctor [[2026-07-10|at 3pm today]]",
	);
});

test('linkDateWords leaves "now" alone but still links "today" in the same sentence', () => {
	const ref = "2026-07-10";
	assert.equal(
		linkDateWords("it's good now, deploy maybe tomorrow, or today", ref),
		"it's good now, deploy maybe [[2026-07-11|tomorrow]], or [[2026-07-10|today]]",
	);
	assert.equal(
		linkDateWords("just now I fixed it", ref),
		"just now I fixed it",
	);
});

test("linkDateWords ignores plain text and never re-links inside a wikilink", () => {
	const ref = "2026-07-10";
	assert.equal(linkDateWords("no date words here", ref), "no date words here");
	assert.equal(linkDateWords("", ref), "");
	assert.equal(
		linkDateWords("read [[Monday Blues]] again", ref),
		"read [[Monday Blues]] again",
	);
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

test("donePreview shows enriched text in full, labels attach-only", () => {
	assert.equal(donePreview("text", "  went for a run  "), "went for a run");
	assert.equal(donePreview("audio", "x".repeat(250)), "x".repeat(250));
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
		doneMessage("14:32:00", "text", "ran <5k> today", "a1b2c3d4"),
		"✅ Saved to your journal\n<blockquote>🕒 14:32:00 · ran &lt;5k&gt; today</blockquote>\n🔖 <code>a1b2c3d4</code>",
	);
});

test("doneMessage notes a squash only when more than one jot merged", () => {
	// 0/1 = no merge, no extra line; 2+ appends the squash count.
	assert.ok(!doneMessage("14:32:00", "text", "x", "a1b2c3d4").includes("🧵"));
	assert.ok(
		!doneMessage("14:32:00", "text", "x", "a1b2c3d4", 1).includes("🧵"),
	);
	assert.match(
		doneMessage("14:32:00", "text", "x", "a1b2c3d4", 3),
		/🧵 3 jots squashed into one entry$/,
	);
});

test("editConfirmation blockquotes the time and escapes content", () => {
	assert.equal(
		editConfirmation("14:32:00", "ran <5k> today"),
		"✏️ Updated\n<blockquote>🕒 14:32:00 · ran &lt;5k&gt; today</blockquote>",
	);
});

test("editConfirmation falls back to an ellipsis for a blank result (e.g. a delete)", () => {
	assert.equal(
		editConfirmation("14:32:00", "   "),
		"✏️ Updated\n<blockquote>🕒 14:32:00 · …</blockquote>",
	);
});

test("pluralize suffixes -s for everything but 1", () => {
	assert.equal(pluralize(1, "jot"), "1 jot");
	assert.equal(pluralize(0, "jot"), "0 jots");
	assert.equal(pluralize(3, "jot"), "3 jots");
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

test("formatDeployNotice reports version, sha, and uptime", () => {
	const out = formatDeployNotice("1.2.3", "abcdef1234", 90_000);
	assert.match(out, /scriba deployed — 1\.2\.3 \(abcdef1\)/);
	assert.match(out, /Uptime: 1m 30s/);
});

test("formatStatus summarises health", () => {
	const out = formatStatus({
		counts: {
			pending: 1,
			processing: 1,
			done: 10,
			failed: 2,
			abandoned: 0,
			deleted: 0,
		},
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
		counts: {
			pending: 0,
			processing: 0,
			done: 0,
			failed: 0,
			abandoned: 0,
			deleted: 0,
		},
		queueDepth: 0,
		transcriber: "remote",
		links: { enabled: false, files: 0, aliases: 0 },
		version: "1",
		sha: "0000000",
		uptimeMs: 0,
	});
	assert.match(out, /Link index: disabled/);
});

test("isRecoverable flags transient infra errors, not terminal ones", () => {
	assert.equal(
		isRecoverable(new Error("connect ETIMEDOUT 10.0.0.1:443")),
		true,
	);
	assert.equal(
		isRecoverable(new Error("Request failed with status 503")),
		true,
	);
	assert.equal(isRecoverable(new Error("429 Too Many Requests")), true);
	assert.equal(isRecoverable(new Error("invalid path")), false);
});

test("stripJournalLine strips the time prefix and anchor suffix", () => {
	assert.equal(
		stripJournalLine("- _23:13:18 ::_ hi ^a1b2c3d4", "23:13:18", "a1b2c3d4"),
		"hi",
	);
});

test("isBlank treats empty and whitespace-only edits as a delete gesture", () => {
	assert.equal(isBlank(""), true);
	assert.equal(isBlank("   "), true);
	assert.equal(isBlank("\n\t "), true);
	assert.equal(isBlank("x"), false);
	assert.equal(isBlank("  hi  "), false);
});

test("isEditableJot is true only for done/abandoned (a line exists to edit)", () => {
	assert.equal(isEditableJot("done"), true);
	assert.equal(isEditableJot("abandoned"), true);
	assert.equal(isEditableJot("pending"), false);
	assert.equal(isEditableJot("processing"), false);
	assert.equal(isEditableJot("failed"), false);
	assert.equal(isEditableJot("deleted"), false);
});

test("formatJotDetail shows full text and includes errors", () => {
	const jot: Jot = {
		id: "deadbeef",
		kind: "audio",
		note_path: "notes/x.md",
		anchor: "deadbeef",
		time: "10:00:00",
		raw_text: null,
		text: null,
		transcript: "x".repeat(400),
		asset_path: null,
		file_id: null,
		status: "failed",
		attempts: 3,
		error: "boom",
		received_at: Date.now(),
		updated_at: Date.now(),
		instructions_run: false,
	};
	const out = formatJotDetail(jot);
	assert.match(out, /deadbeef \[audio\] — failed/);
	assert.match(out, /Attempts: 3/);
	assert.match(out, /Error: boom/);
	assert.ok(out.includes(`Text: ${"x".repeat(400)}`)); // transcript shown in full
});

test("entitiesToMarkdown returns text unchanged when entities is undefined", () => {
	assert.equal(entitiesToMarkdown("hello world", undefined), "hello world");
});
test("entitiesToMarkdown returns text unchanged when entities is empty", () => {
	assert.equal(entitiesToMarkdown("hello world", []), "hello world");
});
test("entitiesToMarkdown wraps bold in **", () => {
	assert.equal(
		entitiesToMarkdown("hello world", [{ type: "bold", offset: 6, length: 5 }]),
		"hello **world**",
	);
});
test("entitiesToMarkdown wraps italic in _", () => {
	assert.equal(
		entitiesToMarkdown("hello world", [
			{ type: "italic", offset: 6, length: 5 },
		]),
		"hello _world_",
	);
});
test("entitiesToMarkdown wraps code in backticks", () => {
	assert.equal(
		entitiesToMarkdown("I added things to internal", [
			{ type: "code", offset: 18, length: 8 },
		]),
		"I added things to `internal`",
	);
});
test("entitiesToMarkdown wraps strike in ~~", () => {
	assert.equal(
		entitiesToMarkdown("hello world", [
			{ type: "strikethrough", offset: 6, length: 5 },
		]),
		"hello ~~world~~",
	);
});
test("entitiesToMarkdown wraps spoiler in ||", () => {
	assert.equal(
		entitiesToMarkdown("hello world", [
			{ type: "spoiler", offset: 6, length: 5 },
		]),
		"hello ||world||",
	);
});
test("entitiesToMarkdown wraps underline in __", () => {
	assert.equal(
		entitiesToMarkdown("hello world", [
			{ type: "underline", offset: 6, length: 5 },
		]),
		"hello __world__",
	);
});
test("entitiesToMarkdown wraps text_link in Markdown link", () => {
	assert.equal(
		entitiesToMarkdown("hello example", [
			{ type: "text_link", offset: 6, length: 7, url: "https://example.com" },
		]),
		"hello [example](https://example.com)",
	);
});
test("entitiesToMarkdown wraps pre with language", () => {
	assert.equal(
		entitiesToMarkdown("hello world", [
			{ type: "pre", offset: 6, length: 5, language: "ts" },
		]),
		"hello ```ts\nworld\n```",
	);
});
test("entitiesToMarkdown wraps pre without language", () => {
	assert.equal(
		entitiesToMarkdown("hello world", [{ type: "pre", offset: 6, length: 5 }]),
		"hello ```\nworld\n```",
	);
});
test("entitiesToMarkdown handles multiple entities sorted by offset", () => {
	const text = "abcboldandcode";
	assert.equal(
		entitiesToMarkdown(text, [
			{ type: "code", offset: 10, length: 4 },
			{ type: "bold", offset: 3, length: 4 },
		]),
		"abc**bold**and`code`",
	);
});
test("entitiesToMarkdown skips nested entities instead of duplicating text", () => {
	// bold spanning the whole string with a link nested inside it: keep the
	// outer formatting, drop the inner one, never re-emit the covered text.
	assert.equal(
		entitiesToMarkdown("hello world", [
			{ type: "bold", offset: 0, length: 11 },
			{ type: "text_link", offset: 0, length: 5, url: "https://x.com" },
		]),
		"**hello world**",
	);
});
test("entitiesToMarkdown preserves text before the first entity and after the last", () => {
	assert.equal(
		entitiesToMarkdown("before code after", [
			{ type: "code", offset: 7, length: 4 },
		]),
		"before `code` after",
	);
});
test("distinctSurfaces dedupes surfaces, preserving list order", () => {
	assert.deepEqual(
		distinctSurfaces([
			{ surface: "gym", note: "Health" },
			{ surface: "gym", note: "Fitness" },
			{ surface: "mom", note: "Family" },
		]),
		["gym", "mom"],
	);
});

test("jotPreview falls back to (kind) for a captionless attach-only jot", () => {
	const base = {
		id: "aaaaaaaa",
		kind: "image" as const,
		note_path: "x.md",
		anchor: "aaaaaaaa",
		time: "10:00:00",
		raw_text: null,
		text: null,
		transcript: null,
		asset_path: null,
		file_id: null,
		status: "done" as const,
		attempts: 0,
		error: null,
		received_at: 0,
		updated_at: 0,
		instructions_run: false,
	};
	assert.equal(jotPreview(base), "(image)");
	assert.equal(
		jotPreview({ ...base, raw_text: "a  sunset\nphoto" }),
		"a sunset photo",
	);
	assert.equal(
		jotPreview({ ...base, kind: "audio", transcript: "hello there" }, 5),
		"hello",
	);
	assert.equal(
		jotPreview({ ...base, raw_text: "old", text: "new" }),
		"new", // stripped `text` wins over the untouched `raw_text`
	);
});

test("extractInstructions strips all @@...@@ blocks, collapsing whitespace", () => {
	assert.deepEqual(extractInstructions("plain text, no markers"), {
		text: "plain text, no markers",
		instructions: [],
	});
	assert.deepEqual(
		extractInstructions("Went for a run @@create Running log.md@@ today"),
		{
			text: "Went for a run today",
			instructions: ["create Running log.md"],
		},
	);
	assert.deepEqual(
		extractInstructions(
			"@@create Idea.md@@Had a great idea@@also remind me tomorrow@@",
		),
		{
			text: "Had a great idea",
			instructions: ["create Idea.md", "also remind me tomorrow"],
		},
	);
	// blank/whitespace-only instruction bodies are dropped, not kept as empty strings
	assert.deepEqual(extractInstructions("hi @@   @@ there"), {
		text: "hi there",
		instructions: [],
	});
});

test("enrichableSource prefers the stripped `text` over `raw_text` for text jots", () => {
	const base: Jot = {
		id: "aaaaaaaa",
		kind: "text",
		note_path: "x.md",
		anchor: "aaaaaaaa",
		time: "10:00:00",
		raw_text: "original @@create X.md@@ message",
		text: null,
		transcript: null,
		asset_path: null,
		file_id: null,
		status: "done",
		attempts: 0,
		error: null,
		received_at: 0,
		updated_at: 0,
		instructions_run: false,
	};
	assert.equal(enrichableSource(base), "original @@create X.md@@ message"); // no `text` yet: falls back to raw_text
	assert.equal(
		enrichableSource({ ...base, text: "original message" }),
		"original message",
	);
});

test("normalizeNotePath rejects traversal/absolute paths and adds .md", () => {
	assert.equal(normalizeNotePath("Ideas/Trip"), "Ideas/Trip.md");
	assert.equal(normalizeNotePath("Ideas/Trip.md"), "Ideas/Trip.md");
	assert.equal(normalizeNotePath("/etc/passwd"), null);
	assert.equal(normalizeNotePath("../../secrets.md"), null);
	assert.equal(normalizeNotePath("a/../b.md"), null);
	assert.equal(normalizeNotePath("   "), null);
});

test("monthGrid pads a month to full weeks starting Sunday", () => {
	// July 2026 starts on a Wednesday and has 31 days.
	const grid = monthGrid(2026, 7);
	assert.equal(grid[0]!.filter((d) => d === 0).length, 3); // Sun/Mon/Tue padding
	assert.equal(grid[0]![3], 1); // Wed 1st
	const flat = grid.flat().filter((d) => d !== 0);
	assert.deepEqual(
		flat,
		Array.from({ length: 31 }, (_, i) => i + 1),
	);
	for (const week of grid) assert.equal(week.length, 7);
});

test("reprocessTargets dedupes to leader ids, preserving first-seen order", () => {
	assert.deepEqual(
		reprocessTargets([
			{ anchor: "leader1" },
			{ anchor: "leader1" }, // follower sharing leader1's anchor
			{ anchor: "leader2" },
		]),
		["leader1", "leader2"],
	);
});
