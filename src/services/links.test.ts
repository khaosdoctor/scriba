import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkIndex } from "./links.ts";

test("empty vault path yields no candidates", async () => {
	const idx = new LinkIndex(null);
	assert.equal(await idx.rebuild(), 0);
	assert.deepEqual(idx.list(), []);
});

test("rebuild indexes titles + inline and block aliases, skips non-md/dotfiles", async () => {
	const dir = await mkdtemp(join(tmpdir(), "scriba-idx-"));
	try {
		await writeFile(
			join(dir, "Norway.md"),
			"---\naliases: [no, Noruega]\n---\nbody",
		);
		await writeFile(
			join(dir, "Fume Extractor.md"),
			"---\naliases:\n  - Fume\n  - Extractor\n---\n",
		);
		await writeFile(join(dir, "Plain.md"), "no frontmatter here");
		await writeFile(join(dir, "notes.txt"), "ignored"); // non-md
		await mkdir(join(dir, ".obsidian"));
		await writeFile(join(dir, ".obsidian", "hidden.md"), "hidden"); // dotdir skipped

		const idx = new LinkIndex(dir);
		const count = await idx.rebuild();
		assert.equal(count, 3); // three .md files, dotdir ignored

		const entries = idx.list();
		const has = (note: string, alias: string) =>
			entries.some((e) => e.note === note && e.alias === alias);
		assert.ok(has("Norway", "Norway")); // title is always an alias
		assert.ok(has("Norway", "no")); // inline
		assert.ok(has("Norway", "Noruega"));
		assert.ok(has("Fume Extractor", "Fume")); // block form
		assert.ok(has("Fume Extractor", "Extractor"));
		assert.ok(has("Plain", "Plain")); // title only
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

const poll = async (cond: () => boolean, tries = 40, ms = 100) => {
	for (let i = 0; i < tries; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, ms));
	}
};

test("start() scans initially and reflects later changes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "scriba-watch-"));
	const idx = new LinkIndex(dir);
	try {
		await writeFile(join(dir, "Seed.md"), "seed");
		idx.start(300); // short periodic backstop → deterministic regardless of watch timing
		await poll(() => idx.list().some((e) => e.note === "Seed"));
		assert.ok(idx.list().some((e) => e.note === "Seed"));

		await writeFile(join(dir, "New.md"), "new");
		await poll(() => idx.list().some((e) => e.note === "New"));
		assert.ok(idx.list().some((e) => e.note === "New"));
	} finally {
		idx.stop();
		await rm(dir, { recursive: true, force: true });
	}
});

test("rebuild is incremental: reflects adds, edits, and deletes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "scriba-inc-"));
	try {
		await writeFile(join(dir, "A.md"), "---\naliases: [aa]\n---\n");
		const idx = new LinkIndex(dir);
		assert.equal(await idx.rebuild(), 1);
		assert.ok(idx.list().some((e) => e.alias === "aa"));

		await writeFile(join(dir, "B.md"), "body"); // add
		assert.equal(await idx.rebuild(), 2);
		assert.ok(idx.list().some((e) => e.note === "B"));

		await writeFile(join(dir, "A.md"), "---\naliases: [bb]\n---\n"); // edit
		await idx.rebuild();
		assert.ok(idx.list().some((e) => e.alias === "bb"));
		assert.ok(!idx.list().some((e) => e.alias === "aa"));

		await rm(join(dir, "B.md")); // delete
		assert.equal(await idx.rebuild(), 1);
		assert.ok(!idx.list().some((e) => e.note === "B"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
