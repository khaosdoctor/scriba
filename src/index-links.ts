import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import type { AliasEntry } from "./core.ts";

interface FileEntry { mtimeMs: number; aliases: AliasEntry[]; }

/**
 * Title+alias index for wikilink candidates. Reads the vault from a read-only
 * filesystem mount. Like Obsidian's metadata cache, it re-reads only files whose
 * mtime changed since the last scan — enumeration is cheap, parsing is incremental —
 * so it stays fast on a large vault. If no vault path is set the index is empty.
 */
export class LinkIndex {
  private byFile = new Map<string, FileEntry>();
  private flat: AliasEntry[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private vaultPath: string | null) {}

  list(): AliasEntry[] {
    return this.flat;
  }

  /** Re-scan the vault, re-reading only changed/added files and dropping deleted ones. */
  async rebuild(): Promise<number> {
    if (!this.vaultPath) { this.byFile.clear(); this.flat = []; return 0; }

    const found: string[] = [];
    await this.walk(this.vaultPath, found);
    const present = new Set(found);

    for (const p of this.byFile.keys()) if (!present.has(p)) this.byFile.delete(p);

    for (const f of found) {
      let mtimeMs: number;
      try { mtimeMs = (await stat(f)).mtimeMs; } catch { continue; }
      if (this.byFile.get(f)?.mtimeMs === mtimeMs) continue; // unchanged → reuse
      let text: string;
      try { text = await readFile(f, "utf8"); } catch { continue; }
      this.byFile.set(f, { mtimeMs, aliases: this.parseFile(f, text) });
    }

    this.flat = [...this.byFile.values()].flatMap((e) => e.aliases);
    return this.byFile.size;
  }

  startRefresh(ms = 10 * 60_000): void {
    void this.rebuild();
    this.timer = setInterval(() => void this.rebuild(), ms);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private parseFile(path: string, text: string): AliasEntry[] {
    const note = basename(path, ".md");
    const out: AliasEntry[] = [{ note, alias: note }]; // the title is always an alias
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    if (fm?.[1]) for (const a of this.parseAliases(fm[1])) out.push({ note, alias: a });
    return out;
  }

  private async walk(dir: string, acc: string[]): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await this.walk(p, acc);
      else if (extname(e.name) === ".md") acc.push(p);
    }
  }

  private parseAliases(front: string): string[] {
    const inline = front.match(/^aliases:\s*\[(.*?)\]/m);
    if (inline?.[1]?.trim()) {
      return inline[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    const block = front.match(/^aliases:\s*\n((?:\s*-\s*.+\n?)+)/m);
    if (block?.[1]) {
      return block[1].split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    return [];
  }
}
