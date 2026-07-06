import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinkIndex } from "./index-links.ts";

test("empty vault path yields no candidates", async () => {
  const idx = new LinkIndex(null);
  assert.equal(await idx.rebuild(), 0);
  assert.deepEqual(idx.list(), []);
});

test("rebuild indexes titles + inline and block aliases, skips non-md/dotfiles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriba-idx-"));
  try {
    await writeFile(join(dir, "Norway.md"), "---\naliases: [no, Noruega]\n---\nbody");
    await writeFile(join(dir, "Fume Extractor.md"), "---\naliases:\n  - Fume\n  - Extractor\n---\n");
    await writeFile(join(dir, "Plain.md"), "no frontmatter here");
    await writeFile(join(dir, "notes.txt"), "ignored");           // non-md
    await mkdir(join(dir, ".obsidian"));
    await writeFile(join(dir, ".obsidian", "hidden.md"), "hidden"); // dotdir skipped

    const idx = new LinkIndex(dir);
    const count = await idx.rebuild();
    assert.equal(count, 3); // three .md files, dotdir ignored

    const entries = idx.list();
    const has = (note: string, alias: string) => entries.some((e) => e.note === note && e.alias === alias);
    assert.ok(has("Norway", "Norway"));   // title is always an alias
    assert.ok(has("Norway", "no"));       // inline
    assert.ok(has("Norway", "Noruega"));
    assert.ok(has("Fume Extractor", "Fume"));   // block form
    assert.ok(has("Fume Extractor", "Extractor"));
    assert.ok(has("Plain", "Plain"));     // title only
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
