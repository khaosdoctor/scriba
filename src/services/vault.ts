import { lookup } from "node:dns/promises";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { Agent, fetch } from "undici";
import { htmlToText, isInsideRoot } from "../core.ts";
import { logger } from "../log.ts";
import type { ObsidianClient } from "./obsidian.ts";

const log = logger("vault");

// Hard caps. The agent is told about them, but they're enforced here — a prompt that asks
// for "the whole vault" gets a truncated answer, not an unbounded read.
const MAX_READ_CHARS = 200_000;
const MAX_FETCH_BYTES = 4_000_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_LIST = 400;
const MAX_HITS = 60;

/** Reads never leave the vault mount; writes and deletes go through Obsidian's REST API
 *  (the mount is read-only), and every path is checked against the vault root first. */
export class VaultTools {
	// One dispatcher, so a slow page can't hold a socket forever.
	private dispatcher = new Agent({
		connect: { timeout: 10_000 },
		headersTimeout: FETCH_TIMEOUT_MS,
		bodyTimeout: FETCH_TIMEOUT_MS,
	});

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
	private async safePath(p: string): Promise<{ abs: string; rel: string }> {
		if (!this.root) throw new Error("vault path is not configured");
		if (typeof p !== "string" || !p.trim()) throw new Error("path is required");
		if (p.includes("\0")) throw new Error("invalid path");
		const root = await realpath(this.root);
		const abs = resolve(root, p.replace(/^\/+/, ""));
		if (!isInsideRoot(root, abs))
			throw new Error(`path escapes the vault: ${p}`);
		// Walk up to the nearest existing ancestor and realpath that, so symlinked
		// directories can't be used to step outside.
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
		return { abs, rel: relative(root, abs) };
	}

	/** Vault-relative paths of the notes under `dir` (default: the whole vault). */
	async list(dir = ""): Promise<string> {
		const { abs } = await this.safePath(dir || ".");
		const found: string[] = [];
		await this.walk(abs, found);
		const root = await realpath(this.root!);
		const rels = found.map((f) => relative(root, f)).sort();
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
	async search(query: string, dir = ""): Promise<string> {
		const q = query.trim().toLowerCase();
		if (!q) throw new Error("query is required");
		const { abs } = await this.safePath(dir || ".");
		const root = await realpath(this.root!);
		const files: string[] = [];
		await this.walk(abs, files);
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

	/** Create or overwrite a note. Goes through the REST API — the mount is read-only. */
	async write(path: string, content: string): Promise<string> {
		const { rel } = await this.safePath(path);
		const vaultPath = extname(rel) ? rel : `${rel}.md`;
		await this.obsidian.writeNote(vaultPath, content);
		log.info(
			{ path: vaultPath, chars: content.length },
			"command: vault_write",
		);
		return `wrote ${vaultPath} (${content.length} characters)`;
	}

	async delete(path: string): Promise<string> {
		const { rel } = await this.safePath(path);
		const vaultPath = extname(rel) ? rel : `${rel}.md`;
		await this.obsidian.deleteNote(vaultPath);
		log.info({ path: vaultPath }, "command: vault_delete");
		return `deleted ${vaultPath}`;
	}

	/**
	 * Fetch a page and return it as text. http(s) only, redirects re-checked at every hop,
	 * and anything resolving to a private/loopback address is refused — the bot sits inside
	 * a home LAN full of unauthenticated services, so "fetch a URL" must not become a way to
	 * read them. No JS runs: the body is a string that gets tags stripped.
	 */
	async fetchPage(url: string): Promise<string> {
		let current = url;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			await this.assertPublicHttpUrl(current);
			const res = await fetch(current, {
				redirect: "manual",
				dispatcher: this.dispatcher,
				headers: {
					// Some sites 403 an unknown agent; be honest about what this is.
					"user-agent":
						"scriba-bot/1.0 (+https://github.com/khaosdoctor/scriba)",
					accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
				},
			});
			const location = res.headers.get("location");
			if (res.status >= 300 && res.status < 400 && location) {
				current = new URL(location, current).toString();
				log.debug({ from: url, to: current }, "command: web_fetch redirect");
				continue;
			}
			if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
			const type = res.headers.get("content-type") ?? "";
			if (!/text\/|json|xml/i.test(type))
				throw new Error(`not a text page (content-type: ${type || "unknown"})`);
			const size = Number(res.headers.get("content-length") ?? 0);
			if (size > MAX_FETCH_BYTES)
				throw new Error(`page too large (${size} bytes)`);
			const body = (await res.text()).slice(0, MAX_FETCH_BYTES);
			const text = /html|xml/i.test(type) ? htmlToText(body) : body;
			log.info({ url: current, chars: text.length }, "command: web_fetch");
			return text.length > MAX_READ_CHARS
				? `${text.slice(0, MAX_READ_CHARS)}\n… (truncated)`
				: text;
		}
		throw new Error("too many redirects");
	}

	/** http(s) only, and never an address on the local machine or the home network. */
	private async assertPublicHttpUrl(raw: string): Promise<void> {
		let u: URL;
		try {
			u = new URL(raw);
		} catch {
			throw new Error(`not a URL: ${raw}`);
		}
		if (u.protocol !== "http:" && u.protocol !== "https:")
			throw new Error(`only http(s) URLs can be fetched, got ${u.protocol}`);
		const addrs = await lookup(u.hostname, { all: true }).catch(() => {
			throw new Error(`cannot resolve ${u.hostname}`);
		});
		for (const { address } of addrs)
			if (isPrivateAddress(address))
				throw new Error(
					`refusing to fetch ${u.hostname}: it resolves to a private address (${address})`,
				);
	}

	private async walk(dir: string, acc: string[]): Promise<void> {
		if (acc.length > MAX_LIST * 4) return; // stop runaway scans early
		const entries = await readdir(dir, { withFileTypes: true }).catch(
			() => null,
		);
		if (!entries) {
			// `dir` may be a single file (list/search called with a note path).
			const s = await stat(dir).catch(() => null);
			if (s?.isFile() && extname(dir) === ".md") acc.push(dir);
			return;
		}
		for (const e of entries) {
			if (e.name.startsWith(".")) continue; // .obsidian, .trash, .git
			const p = join(dir, e.name);
			if (e.isSymbolicLink()) continue; // never followed — see safePath
			if (e.isDirectory()) await this.walk(p, acc);
			else if (extname(e.name) === ".md") acc.push(p);
		}
	}
}

/** Loopback, link-local, CGNAT and the RFC1918 ranges, v4 and v6. */
export function isPrivateAddress(ip: string): boolean {
	const v4 = ip.replace(/^::ffff:/i, "");
	const parts = v4.split(".").map(Number);
	if (parts.length === 4 && parts.every((n) => Number.isInteger(n))) {
		const [a = 0, b = 0] = parts;
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127) || // CGNAT
			a >= 224 // multicast + reserved
		);
	}
	const v6 = ip.toLowerCase();
	return (
		v6 === "::" ||
		v6 === "::1" ||
		v6.startsWith("fc") ||
		v6.startsWith("fd") || // unique local
		v6.startsWith("fe80") // link-local
	);
}
