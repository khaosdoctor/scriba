import { Agent, fetch } from "undici";
import { insertJournalLine, setFrontmatterNumber } from "../core.ts";
import { logger } from "../log.ts";

const log = logger("obsidian");

export interface ObsidianConfig {
	url: string;
	key: string;
	dailyDir: string;
	dailyTemplate: string;
	journalHeading: string;
	habitsHeading: string;
	assetsDir: string;
	insecureTls: boolean;
}

/** Thin client over the Obsidian Local REST API (the VFB headless instance). */
export class ObsidianClient {
	// Obsidian's Local REST API serves a self-signed cert, so TLS verification is skipped
	// for a loopback target (the normal case). A non-loopback URL (e.g. the homelab deploy
	// reaching Obsidian over the LAN) gets real verification so the bearer token can't be
	// intercepted on an untrusted segment — unless OBSIDIAN_INSECURE_TLS opts out for a
	// trusted LAN with its own self-signed cert.
	private dispatcher: Agent;

	constructor(private cfg: ObsidianConfig) {
		const host = new URL(cfg.url).hostname;
		const loopback =
			host === "127.0.0.1" ||
			host === "localhost" ||
			host === "::1" ||
			host === "[::1]";
		const verifyTls = !loopback && !cfg.insecureTls;
		if (!verifyTls)
			log.warn({ host }, "TLS verification disabled for Obsidian");
		this.dispatcher = new Agent({
			connect: { rejectUnauthorized: verifyTls },
		});
	}

	private encode(p: string): string {
		return p.split("/").map(encodeURIComponent).join("/");
	}
	private headers(extra: Record<string, string> = {}) {
		return { Authorization: `Bearer ${this.cfg.key}`, ...extra };
	}
	/** Pure path for a day's note — no network. Callers persist this before any REST call so
	 *  a jot row exists even when Obsidian is unreachable at intake. */
	dailyPath(date: string): string {
		return `${this.cfg.dailyDir}/${date}.md`;
	}

	/** True for any path under the daily notes directory — a hard guard the instruction
	 *  tools check regardless of what the agent asks for, since writing there would bypass
	 *  the whole jot pipeline (anchors, squash, edit-fold) instead of going through it. */
	isDailyNote(vaultPath: string): boolean {
		return vaultPath.startsWith(`${this.cfg.dailyDir}/`);
	}

	private async getFile(vaultPath: string): Promise<string | null> {
		const res = await fetch(`${this.cfg.url}/vault/${this.encode(vaultPath)}`, {
			headers: this.headers(),
			dispatcher: this.dispatcher,
		});
		log.debug(
			{ method: "GET", path: vaultPath, status: res.status },
			"obsidian request",
		);
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`obsidian GET ${vaultPath}: ${res.status}`);
		return res.text();
	}
	private async putFile(
		vaultPath: string,
		body: string | Uint8Array,
		contentType: string,
	): Promise<void> {
		const res = await fetch(`${this.cfg.url}/vault/${this.encode(vaultPath)}`, {
			method: "PUT",
			headers: this.headers({ "Content-Type": contentType }),
			body: body as any,
			dispatcher: this.dispatcher,
		});
		log.debug(
			{ method: "PUT", path: vaultPath, status: res.status },
			"obsidian request",
		);
		if (!res.ok)
			throw new Error(
				`obsidian PUT ${vaultPath}: ${res.status} ${await res.text()}`,
			);
	}

	// Serialize concurrent first-of-day creation so two intakes can't both 404-then-PUT
	// the blank template (the later PUT would erase the earlier's placeholder line).
	private creating = new Map<string, Promise<string>>();

	/** Create today's note from the vault template if it doesn't exist yet. */
	async ensureDailyNote(date: string): Promise<string> {
		const inFlight = this.creating.get(date);
		if (inFlight) return inFlight;
		const p = this.doEnsureDailyNote(date).finally(() =>
			this.creating.delete(date),
		);
		this.creating.set(date, p);
		return p;
	}

	private async doEnsureDailyNote(date: string): Promise<string> {
		const path = this.dailyPath(date);
		if ((await this.getFile(path)) !== null) return path;
		log.info({ date, path }, "creating daily note from template");
		// ponytail: fill {{date}} only; richer template automations are out of scope.
		const tpl =
			(await this.getFile(`${this.cfg.dailyTemplate}.md`)) ?? "## Journal\n";
		await this.putFile(path, tpl.replaceAll("{{date}}", date), "text/markdown");
		return path;
	}

	// Serialize read-modify-write on a note so two concurrent stacks (intake, flush, retry
	// sweep, boot sweep) can't both read v1 and have the later PUT clobber the earlier's
	// line. Each op on a path chains onto the previous one for that path.
	// ponytail: the chain map grows one entry per distinct note path (≈1/day). If it ever
	// matters, prune settled tails — for a single-user bot it never will.
	private writeChain = new Map<string, Promise<unknown>>();
	async withNoteLock<T>(vaultPath: string, fn: () => Promise<T>): Promise<T> {
		const prev = (this.writeChain.get(vaultPath) ?? Promise.resolve()).catch(
			() => {},
		);
		const run = prev.then(fn);
		this.writeChain.set(
			vaultPath,
			run.catch(() => {}),
		);
		return run;
	}

	/** Insert a bullet under the ## Journal heading. Read-modify-write (not the REST
	 *  heading-append) so the line lands right after the last bullet — or replaces the
	 *  empty template bullet — instead of trailing a blank line below it. */
	async appendJournalLine(date: string, line: string): Promise<void> {
		const path = this.dailyPath(date);
		await this.withNoteLock(path, async () => {
			const note = await this.readNote(path);
			await this.writeNote(
				path,
				insertJournalLine(note, this.cfg.journalHeading, line),
			);
		});
	}

	/** Set the `overallRating` frontmatter of a day's note (creating the note if the day
	 *  was never journaled). Read-modify-write so a live edit in Obsidian isn't clobbered. */
	async setDailyRating(date: string, rating: number): Promise<void> {
		const path = await this.ensureDailyNote(date);
		await this.withNoteLock(path, async () => {
			const note = await this.readNote(path);
			await this.writeNote(
				path,
				setFrontmatterNumber(note, "overallRating", rating),
			);
		});
		log.info({ date, rating, path }, "overallRating frontmatter set");
	}

	/** Read a day's note by date, or null if that day was never journaled (no habits to
	 *  review). Unlike setDailyRating this never creates the note. */
	async readDailyNote(
		date: string,
	): Promise<{ path: string; content: string } | null> {
		const path = this.dailyPath(date);
		const content = await this.getFile(path);
		return content === null ? null : { path, content };
	}

	/** Read a note's current content (live — the user may have edited it in Obsidian). */
	async readNote(vaultPath: string): Promise<string> {
		const c = await this.getFile(vaultPath);
		if (c === null) throw new Error(`note not found: ${vaultPath}`);
		return c;
	}
	async writeNote(vaultPath: string, content: string): Promise<void> {
		await this.putFile(vaultPath, content, "text/markdown");
	}
	/** Ensure a vault note carries `content`, for a jot's `@@instruction@@` side effects.
	 *  "create": no-op if the note already exists. "append": add to the end, creating it
	 *  first if missing. Never overwrites existing content — the note-lock serializes this
	 *  against any other concurrent write to the same path. */
	async ensureNote(
		vaultPath: string,
		content: string,
		mode: "create" | "append",
	): Promise<{ created: boolean }> {
		return this.withNoteLock(vaultPath, async () => {
			const existing = await this.getFile(vaultPath);
			if (existing === null) {
				await this.putFile(vaultPath, content, "text/markdown");
				log.info({ vaultPath, mode }, "instruction: note created");
				return { created: true };
			}
			if (mode === "create") {
				log.debug({ vaultPath }, "instruction: note already exists — no-op");
				return { created: false };
			}
			await this.putFile(
				vaultPath,
				`${existing.replace(/\n*$/, "")}\n${content}\n`,
				"text/markdown",
			);
			log.info({ vaultPath }, "instruction: content appended to note");
			return { created: false };
		});
	}

	async saveAsset(
		name: string,
		bytes: Uint8Array,
		contentType: string,
	): Promise<string> {
		const vaultPath = `${this.cfg.assetsDir}/${name}`;
		await this.putFile(vaultPath, bytes, contentType);
		return vaultPath;
	}
}
