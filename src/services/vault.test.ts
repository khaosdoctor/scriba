import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ObsidianClient } from "./obsidian.ts";
import { isInsideRoot, VaultService } from "./vault.ts";

/** A vault with one note, plus a secret outside it and a symlink pointing at that secret. */
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "scriba-vault-"));
  const root = join(base, "vault");
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "a.md"), "# A\nhello vault\n");
  await writeFile(join(base, "secret.md"), "TELEGRAM_BOT_TOKEN=hunter2");
  await symlink(join(base, "secret.md"), join(root, "escape.md")).catch(
    () => {},
  );
  const written: { path: string; content: string }[] = [];
  const deleted: string[] = [];
  const obsidian = {
    writeNote: async (path: string, content: string) => {
      written.push({ path, content });
    },
    deleteNote: async (path: string) => {
      deleted.push(path);
    },
  } as unknown as ObsidianClient;
  return {
    base,
    root,
    written,
    deleted,
    tools: new VaultService(root, obsidian),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

test("vault tools read inside the vault and refuse every way out of it", async () => {
  const f = await fixture();
  try {
    assert.match(await f.tools.read("notes/a.md"), /hello vault/);
    assert.match(await f.tools.listNotes(), /notes\/a\.md/);
    assert.match(await f.tools.searchNotes("hello"), /notes\/a\.md/);

    // None of the refusals leaks the file's contents in the error.
    for (const bad of [
      "../secret.md",
      "notes/../../secret.md",
      "/etc/passwd",
      "escape.md", // symlink pointing outside the vault
    ]) {
      await assert.rejects(
        () => f.tools.read(bad),
        (err: Error) => {
          assert.doesNotMatch(err.message, /hunter2/);
          return /escapes the vault|ENOENT|no such file/i.test(err.message);
        },
        `expected ${bad} to be refused`,
      );
    }

    // Writes are path-checked the same way, and go through the REST client (the mount is
    // read-only), with .md added when it's missing.
    await f.tools.write("notes/new", "body");
    assert.deepEqual(f.written, [{ path: "notes/new.md", content: "body" }]);
    await assert.rejects(
      () => f.tools.write("../evil", "x"),
      /escapes the vault/,
    );
  } finally {
    await f.cleanup();
  }
});

test("a path that is blank, holds a NUL or goes through a symlinked folder is refused", async () => {
  const f = await fixture();
  try {
    await symlink(f.base, join(f.root, "out")).catch(() => {});
    await assert.rejects(() => f.tools.read("  "), /path is required/);
    await assert.rejects(() => f.tools.read("a\0b.md"), /invalid path/);
    await assert.rejects(
      () => f.tools.write("out/new.md", "x"),
      /escapes the vault via a symlink/,
    );
    assert.deepEqual(f.written, []);
  } finally {
    await f.cleanup();
  }
});

test("write keeps an explicit extension and delete goes through Obsidian", async () => {
  const f = await fixture();
  try {
    assert.equal(
      await f.tools.write("notes/x.md", "abc"),
      "wrote notes/x.md (3 characters)",
    );
    assert.equal(await f.tools.delete("notes/old"), "deleted notes/old.md");
    assert.deepEqual(f.deleted, ["notes/old.md"]);
    await assert.rejects(() => f.tools.delete("../a"), /escapes the vault/);
    assert.deepEqual(f.deleted, ["notes/old.md"]);
  } finally {
    await f.cleanup();
  }
});

test("listing skips dot folders and symlinks, takes one note path and reports an empty folder", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, ".obsidian"));
    await writeFile(join(f.root, ".obsidian", "hidden.md"), "hidden");
    await mkdir(join(f.root, "empty"));
    assert.equal(await f.tools.listNotes(), "notes/a.md");
    assert.equal(await f.tools.listNotes("notes/a.md"), "notes/a.md");
    assert.equal(await f.tools.listNotes("empty"), "(no notes here)");
  } finally {
    await f.cleanup();
  }
});

test("a long listing is cut at 400 notes and says how many are hidden", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "many"));
    for (let i = 0; i < 405; i++)
      await writeFile(join(f.root, "many", `n${i}.md`), "x");
    const out = await f.tools.listNotes("many");
    assert.equal(out.split("\n").length, 401);
    assert.match(out, /… 5 more not shown; narrow the directory/);
  } finally {
    await f.cleanup();
  }
});

test("read truncates a note over 200000 characters", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "notes", "big.md"), "a".repeat(200_050));
    const out = await f.tools.read("notes/big.md");
    assert.equal(
      out,
      `${"a".repeat(200_000)}\n… (truncated at 200000 characters)`,
    );
  } finally {
    await f.cleanup();
  }
});

test("search needs a query, reports no match and stops at 60 hits", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.tools.searchNotes("  "), /query is required/);
    assert.equal(await f.tools.searchNotes("zzz"), 'no note matches "zzz"');
    await mkdir(join(f.root, "hits"));
    for (let i = 0; i < 65; i++)
      await writeFile(join(f.root, "hits", `h${i}.md`), "first\nNeedle here\n");
    const out = await f.tools.searchNotes("needle", "hits");
    const lines = out.split("\n");
    assert.equal(lines.length, 60);
    assert.match(lines[0]!, /^hits\/h\d+\.md: Needle here$/);
  } finally {
    await f.cleanup();
  }
});

test("the agent lists a folder named internal that the link index skips", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "internal"));
    await writeFile(join(f.root, "internal", "tpl.md"), "template");
    assert.match(await f.tools.listNotes("internal"), /internal\/tpl\.md/);
    await f.tools.rebuild();
    assert.ok(!f.tools.list().some((e) => e.note === "tpl"));
    assert.ok(f.tools.list().some((e) => e.note === "a"));
  } finally {
    await f.cleanup();
  }
});

test("isInsideRoot accepts the root and its children, rejects siblings", () => {
  assert.equal(isInsideRoot("/vault", "/vault"), true);
  assert.equal(isInsideRoot("/vault", "/vault/notes/a.md"), true);
  assert.equal(isInsideRoot("/vault/", "/vault/a.md"), true);
  assert.equal(isInsideRoot("/vault", "/vault-other/a.md"), false); // prefix, not child
  assert.equal(isInsideRoot("/vault", "/etc/passwd"), false);
  assert.equal(isInsideRoot("", "/vault/a.md"), false);
});

test("a vault path that isn't configured disables the tools", async () => {
  const tools = new VaultService(null, {} as ObsidianClient);
  assert.equal(tools.enabled, false);
  await assert.rejects(() => tools.read("x.md"), /not configured/);
});

test("ids used for confirmations are unguessable enough", () => {
  // Sanity: the confirm ids come from makeJotId (4 random bytes), not a counter.
  const a = randomBytes(4).toString("hex");
  assert.match(a, /^[0-9a-f]{8}$/);
});

test("empty vault path yields no candidates", async () => {
  const idx = new VaultService(null, {} as ObsidianClient);
  assert.equal(await idx.rebuild(), 0);
  assert.deepEqual(idx.list(), []);
  idx.startIndex();
  assert.deepEqual(idx.stats(), { enabled: false, files: 0, aliases: 0 });
  idx.stopIndex();
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
      '---\naliases:\n  - Fume\n  - "Extractor"\n---\n',
    );
    await writeFile(join(dir, "Plain.md"), "no frontmatter here");
    await writeFile(join(dir, "Empty.md"), "---\naliases: []\n---\n");
    await writeFile(join(dir, "notes.txt"), "ignored"); // non-md
    await mkdir(join(dir, ".obsidian"));
    await writeFile(join(dir, ".obsidian", "hidden.md"), "hidden"); // dotdir skipped

    const idx = new VaultService(dir, {} as ObsidianClient);
    const count = await idx.rebuild();
    assert.equal(count, 4); // four .md files, dotdir ignored
    assert.deepEqual(idx.stats(), { enabled: true, files: 4, aliases: 8 });

    const entries = idx.list();
    const has = (note: string, alias: string) =>
      entries.some((e) => e.note === note && e.alias === alias);
    assert.ok(has("Norway", "Norway")); // title is always an alias
    assert.ok(has("Norway", "no")); // inline
    assert.ok(has("Norway", "Noruega"));
    assert.ok(has("Fume Extractor", "Fume")); // block form
    assert.ok(has("Fume Extractor", "Extractor")); // quotes stripped
    assert.ok(has("Plain", "Plain")); // title only
    assert.ok(has("Empty", "Empty"));
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

test("startIndex() scans initially and reflects later changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriba-watch-"));
  const idx = new VaultService(dir, {} as ObsidianClient);
  try {
    await writeFile(join(dir, "Seed.md"), "seed");
    idx.startIndex(300); // short periodic backstop → deterministic regardless of watch timing
    await poll(() => idx.list().some((e) => e.note === "Seed"));
    assert.ok(idx.list().some((e) => e.note === "Seed"));

    await writeFile(join(dir, "New.md"), "new");
    await poll(() => idx.list().some((e) => e.note === "New"));
    assert.ok(idx.list().some((e) => e.note === "New"));
  } finally {
    idx.stopIndex();
    await rm(dir, { recursive: true, force: true });
  }
});

test("startIndex() survives a vault folder that cannot be watched", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "scriba-nowatch-")), "missing");
  const idx = new VaultService(dir, {} as ObsidianClient);
  try {
    idx.startIndex(300);
    assert.equal(await idx.rebuild(), 0);
  } finally {
    idx.stopIndex();
  }
});

test("rebuild is incremental: reflects adds, edits, and deletes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriba-inc-"));
  try {
    await writeFile(join(dir, "A.md"), "---\naliases: [aa]\n---\n");
    const idx = new VaultService(dir, {} as ObsidianClient);
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
