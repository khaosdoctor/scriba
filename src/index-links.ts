import { readdir, readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join, basename, extname } from "node:path";
import type { AliasEntry } from "./core.ts";
import { logger } from "./log.ts";

const log = logger("links");

interface FileEntry { mtimeMs: number; aliases: AliasEntry[]; }

/**
 * Title+alias index for wikilink candidates, read from a read-only vault mount.
 * Re-reads only files whose mtime changed and watches the vault (recursive fs.watch)
 * to refresh on change. A slow periodic rebuild backstops dropped watch events.
 */
export class LinkIndex {
  private byFile = new Map<string, FileEntry>();
  private flat: AliasEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;

  constructor(private vaultPath: string | null) {}

  list(): AliasEntry[] {
    return this.flat;
  }

  /** Initial scan, then watch for changes with a slow periodic rebuild as backstop. */
  start(periodicMs = 30 * 60_000): void {
    if (!this.vaultPath) return log.warn("no SCRIBA_VAULT_HOST_PATH — link index disabled, no wikilinks will be suggested");
    log.info({ vaultPath: this.vaultPath, periodicMs }, "link index starting");
    void this.rebuild();
    this.startWatch();
    this.timer = setInterval(() => void this.rebuild(), periodicMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
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
    log.debug({ files: this.byFile.size, aliases: this.flat.length }, "vault index rebuilt");
    return this.byFile.size;
  }

  private startWatch(): void {
    if (!this.vaultPath) return;
    try {
      this.watcher = watch(this.vaultPath, { recursive: true }, (_event, file) => {
        const f = file ? String(file) : "";
        // Ignore dotdirs (e.g. .obsidian writes constantly) and non-markdown churn.
        if (f && (f.split(/[/\\]/).some((seg) => seg.startsWith(".")) || !f.endsWith(".md"))) return;
        this.scheduleRebuild();
      });
      this.watcher.on("error", () => { /* periodic rebuild is the backstop */ });
    } catch { /* watch unsupported here → rely on the periodic rebuild */ }
  }

  private scheduleRebuild(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.rebuild(), 1500); // coalesce bursts
    this.debounce.unref();
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
