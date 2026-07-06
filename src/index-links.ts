import { readdir, readFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import type { AliasEntry } from "./core.ts";

/**
 * Title+alias index used to propose wikilink candidates. Reads the vault from a
 * read-only filesystem mount (cheap, no tokens, no API spam) and refreshes on an
 * interval. If no vault path is set the index stays empty and no links are proposed.
 */
export class LinkIndex {
  private cache: AliasEntry[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private vaultPath: string | null) {}

  list(): AliasEntry[] {
    return this.cache;
  }

  async rebuild(): Promise<number> {
    if (!this.vaultPath) { this.cache = []; return 0; }
    const files: string[] = [];
    await this.walk(this.vaultPath, files);
    const index: AliasEntry[] = [];
    for (const f of files) {
      const note = basename(f, ".md");
      index.push({ note, alias: note }); // the title is always an alias
      let text: string;
      try { text = await readFile(f, "utf8"); } catch { continue; }
      const fm = text.match(/^---\n([\s\S]*?)\n---/);
      if (fm?.[1]) for (const a of this.parseAliases(fm[1])) index.push({ note, alias: a });
    }
    this.cache = index;
    return files.length;
  }

  startRefresh(ms = 10 * 60_000): void {
    void this.rebuild();
    this.timer = setInterval(() => void this.rebuild(), ms);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
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
