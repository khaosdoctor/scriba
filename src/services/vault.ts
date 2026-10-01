import { type FSWatcher, watch } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { AliasEntry } from "../lib/links.ts";
import { logger } from "../log.ts";
import type { ObsidianClient } from "./obsidian.ts";

const log = logger("vault");

/** True when `target` is `root` itself or lies under it. Both must already be resolved to
 *  absolute paths; the caller still realpaths afterwards, since this is string-only and a
 *  symlink inside the vault can still point out of it. */
export function isInsideRoot(root: string, target: string): boolean {
  if (!root || !target) return false;
  const r = root.endsWith(sep) ? root.slice(0, -1) : root;
  return target === r || target.startsWith(r + sep);
}

// Enforced here, not asked for in the prompt: a request for "the whole vault" gets a
// truncated answer, not an unbounded read.
const MAX_READ_CHARS = 200_000;
const MAX_LIST = 400;
const MAX_HITS = 60;

interface WalkOptions {
  /** Stop descending once this many notes are collected. */
  limit?: number;
  /** Include symlinked notes. The agent never follows a link, see safePath. */
  symlinks?: boolean;
  /** One directory name to skip besides the dot-directories. */
  skip?: string;
}

const AGENT_WALK: WalkOptions = { limit: MAX_LIST * 4 };
const INDEX_WALK: WalkOptions = { symlinks: true, skip: "internal" };

/**
 * The vault, read from its read-only mount. Two jobs share one path check and one walker:
 * the sandboxed note tools of the `/command` agent (writes and deletes go through
 * Obsidian's REST API, since the mount is read-only) and the title+alias index behind
 * wikilink candidates. The index re-reads only files whose mtime changed, refreshes on a
 * recursive fs.watch, and rebuilds periodically in case the watch drops events.
 */
export class VaultService {
  private byFile = new Map<
    string,
    { mtimeMs: number; aliases: AliasEntry[] }
  >();
  private flat: AliasEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;

  constructor(
    private root: string | null,
    private obsidian: ObsidianClient,
  ) {}

  get enabled(): boolean {
    return !!this.root;
  }

  /**
   * Resolve a caller-supplied vault-relative path, or throw. Two checks, both needed: the
   * string check catches `../` traversal, and the realpath check catches a symlink inside
   * the vault pointing out of it. For a path that doesn't exist yet (a new note) the
   * nearest existing parent is what gets realpathed.
   */
  private async safePath(
    p: string,
  ): Promise<{ abs: string; rel: string; root: string }> {
    if (!this.root) throw new Error("vault path is not configured");
    if (typeof p !== "string" || !p.trim()) throw new Error("path is required");
    if (p.includes("\0")) throw new Error("invalid path");
    const root = await realpath(this.root);
    const abs = resolve(root, p.replace(/^\/+/, ""));
    if (!isInsideRoot(root, abs))
      throw new Error(`path escapes the vault: ${p}`);
    let probe = abs;
    for (;;) {
      try {
        const real = await realpath(probe);
        if (!isInsideRoot(root, real))
          throw new Error(`path escapes the vault via a symlink: ${p}`);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        const parent = dirname(probe);
        if (parent === probe) break; // reached the filesystem root
        probe = parent;
      }
    }
    return { abs, rel: relative(root, abs), root };
  }

  private async walk(
    dir: string,
    opts: WalkOptions,
    acc: string[] = [],
  ): Promise<string[]> {
    if (acc.length > (opts.limit ?? Number.POSITIVE_INFINITY)) return acc;
    const entries = await readdir(dir, { withFileTypes: true }).catch(
      () => null,
    );
    if (!entries) {
      // `dir` may be a single note (list/search called with a note path).
      const s = await stat(dir).catch(() => null);
      if (s?.isFile() && extname(dir) === ".md") acc.push(dir);
      return acc;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === opts.skip) continue; // .obsidian, .trash, .git
      if (e.isSymbolicLink() && !opts.symlinks) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await this.walk(p, opts, acc);
      else if (extname(e.name) === ".md") acc.push(p);
    }
    return acc;
  }

  private async notesUnder(dir: string) {
    const { abs, root } = await this.safePath(dir || ".");
    return { root, files: await this.walk(abs, AGENT_WALK) };
  }

  private async notePath(path: string): Promise<string> {
    const { rel } = await this.safePath(path);
    return extname(rel) ? rel : `${rel}.md`;
  }

  /** Vault-relative paths of the notes under `dir` (default: the whole vault). */
  async listNotes(dir = ""): Promise<string> {
    const { root, files } = await this.notesUnder(dir);
    const rels = files.map((f) => relative(root, f)).sort();
    const shown = rels.slice(0, MAX_LIST);
    const cut =
      rels.length > shown.length
        ? `\n… ${rels.length - shown.length} more not shown; narrow the directory or use vault_search`
        : "";
    log.info({ dir, found: rels.length }, "command: vault_list");
    return shown.length ? shown.join("\n") + cut : "(no notes here)";
  }

  async read(path: string): Promise<string> {
    const { abs, rel } = await this.safePath(path);
    const text = await readFile(abs, "utf8");
    log.info({ path: rel, chars: text.length }, "command: vault_read");
    return text.length > MAX_READ_CHARS
      ? `${text.slice(0, MAX_READ_CHARS)}\n… (truncated at ${MAX_READ_CHARS} characters)`
      : text;
  }

  /** Case-insensitive substring search across the vault's notes, with line context. */
  async searchNotes(query: string, dir = ""): Promise<string> {
    const q = query.trim().toLowerCase();
    if (!q) throw new Error("query is required");
    const { root, files } = await this.notesUnder(dir);
    const hits: string[] = [];
    for (const f of files) {
      if (hits.length >= MAX_HITS) break;
      const text = await readFile(f, "utf8").catch(() => "");
      if (!text.toLowerCase().includes(q)) continue;
      const line = text
        .split("\n")
        .find((l) => l.toLowerCase().includes(q))
        ?.trim()
        .slice(0, 200);
      hits.push(`${relative(root, f)}: ${line ?? ""}`);
    }
    log.info({ query, hits: hits.length }, "command: vault_search");
    return hits.length ? hits.join("\n") : `no note matches "${query}"`;
  }

  /** Create or overwrite a note. */
  async write(path: string, content: string): Promise<string> {
    const vaultPath = await this.notePath(path);
    await this.obsidian.writeNote(vaultPath, content);
    log.info(
      { path: vaultPath, chars: content.length },
      "command: vault_write",
    );
    return `wrote ${vaultPath} (${content.length} characters)`;
  }

  async delete(path: string): Promise<string> {
    const vaultPath = await this.notePath(path);
    await this.obsidian.deleteNote(vaultPath);
    log.info({ path: vaultPath }, "command: vault_delete");
    return `deleted ${vaultPath}`;
  }

  /** Alias entries for wikilink candidates. */
  list(): AliasEntry[] {
    return this.flat;
  }

  /** Index health for /status: whether it's enabled and how much it holds. */
  stats(): { enabled: boolean; files: number; aliases: number } {
    return {
      enabled: this.enabled,
      files: this.byFile.size,
      aliases: this.flat.length,
    };
  }

  /** Initial scan, then watch for changes with a slow periodic rebuild as backstop. */
  startIndex(periodicMs = 30 * 60_000): void {
    if (!this.root) {
      log.warn(
        "no SCRIBA_VAULT_HOST_PATH, link index disabled, no wikilinks will be suggested",
      );
      return;
    }
    log.info({ vaultPath: this.root, periodicMs }, "link index starting");
    void this.rebuild();
    this.startWatch(this.root);
    this.timer = setInterval(() => void this.rebuild(), periodicMs);
    this.timer.unref();
  }

  stopIndex(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
  }

  /** Re-scan the vault, re-reading only changed/added files and dropping deleted ones. */
  async rebuild(): Promise<number> {
    if (!this.root) {
      this.byFile.clear();
      this.flat = [];
      return 0;
    }

    const found = await this.walk(this.root, INDEX_WALK);
    const present = new Set(found);
    for (const p of this.byFile.keys())
      if (!present.has(p)) this.byFile.delete(p);

    for (const f of found) {
      const mtimeMs = (await stat(f).catch(() => null))?.mtimeMs;
      if (mtimeMs === undefined || this.byFile.get(f)?.mtimeMs === mtimeMs)
        continue;
      const text = await readFile(f, "utf8").catch(() => null);
      if (text === null) continue;
      this.byFile.set(f, { mtimeMs, aliases: parseAliasEntries(f, text) });
    }

    this.flat = [...this.byFile.values()].flatMap((e) => e.aliases);
    log.debug(
      { files: this.byFile.size, aliases: this.flat.length },
      "vault index rebuilt",
    );
    return this.byFile.size;
  }

  private startWatch(root: string): void {
    try {
      this.watcher = watch(root, { recursive: true }, (_event, file) => {
        const f = file ? String(file) : "";
        // Ignore dotdirs (e.g. .obsidian writes constantly) and non-markdown churn.
        if (
          f &&
          (f.split(/[/\\]/).some((seg) => seg.startsWith(".")) ||
            !f.endsWith(".md"))
        )
          return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.rebuild(), 1500); // coalesce bursts
        this.debounce.unref();
      });
      this.watcher.on("error", () => {
        /* periodic rebuild is the backstop */
      });
    } catch {
      /* watch unsupported here, rely on the periodic rebuild */
    }
  }
}

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");

function parseAliasEntries(path: string, text: string): AliasEntry[] {
  const note = basename(path, ".md");
  const out: AliasEntry[] = [{ note, alias: note }]; // the title is always an alias
  const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const inline = front.match(/^aliases:\s*\[(.*?)\]/m)?.[1];
  const block = front.match(/^aliases:\s*\n((?:\s*-\s*.+\n?)+)/m)?.[1];
  const items = inline?.trim()
    ? inline.split(",")
    : (block?.split("\n").map((l) => l.replace(/^\s*-\s*/, "")) ?? []);
  for (const a of items.map(unquote).filter(Boolean))
    out.push({ note, alias: a });
  return out;
}
