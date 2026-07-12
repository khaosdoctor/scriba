import knexLib, { type Knex } from "knex";
import { logger } from "./log.ts";

const log = logger("db");

export type JotKind = "text" | "audio" | "image" | "video";
export type JotStatus =
	| "pending" // placeholder written, awaiting processing
	| "processing" // claimed by a worker (atomic) — in flight
	| "done" // enriched + written
	| "failed" // last attempt failed; retried until attempts hit the cap
	| "abandoned" // gave up (cap or unrecoverable); posted un-enriched
	| "deleted"; // user removed the line (blank edit or /delete) — terminal, never requeued

export const MAX_ATTEMPTS = 10;

/** Jot counts over a window, broken down by kind and outcome — for the /stats command. */
export interface StatsRow {
	total: number;
	text: number;
	audio: number;
	image: number;
	video: number;
	done: number;
	failed: number;
	abandoned: number;
	inflight: number;
}

export interface Jot {
	id: string;
	kind: JotKind;
	note_path: string;
	anchor: string;
	time: string;
	raw_text: string | null;
	transcript: string | null;
	asset_path: string | null;
	file_id: string | null;
	status: JotStatus;
	attempts: number;
	error: string | null;
	received_at: number;
	updated_at: number;
}

/**
 * The single data-access boundary. ALL knex/SQL lives here — nothing else in the
 * codebase touches the query builder. Callers speak in domain methods only.
 */
export class Repository {
	private constructor(private k: Knex) {}

	static async open(dbPath: string): Promise<Repository> {
		// ponytail: app builds knex config inline; the root knexfile.js drives the CLI.
		const k = knexLib({
			client: "better-sqlite3",
			connection: { filename: dbPath },
			useNullAsDefault: true,
			migrations: { directory: "./migrations", loadExtensions: [".js"] },
			pool: {
				afterCreate: (conn: any, done: (e: Error | null, c: any) => void) => {
					conn.pragma("journal_mode = WAL");
					conn.pragma("foreign_keys = ON");
					done(null, conn);
				},
			},
		});
		const [batch, done] = await k.migrate.latest();
		if (done.length)
			log.info({ batch, count: done.length }, "migrations applied");
		return new Repository(k);
	}

	// --- jots ---
	async insertJot(j: Jot): Promise<void> {
		await this.k("jots").insert(j);
		log.debug({ id: j.id, kind: j.kind, note: j.note_path }, "jot inserted");
	}
	async getJot(id: string): Promise<Jot | undefined> {
		return this.k<Jot>("jots").where({ id }).first();
	}
	async updateJot(id: string, patch: Partial<Jot>): Promise<void> {
		await this.k("jots")
			.where({ id })
			.update({ ...patch, updated_at: Date.now() });
		log.debug({ id, ...patch }, "jot updated");
	}
	/**
	 * Atomically claim a jot for processing. Returns true only for the caller that won
	 * the transition pending|failed -> processing, so flush and retry sweeps can't
	 * double-process the same jot.
	 */
	async claim(id: string): Promise<boolean> {
		const n = await this.k("jots")
			.where({ id })
			.whereIn("status", ["pending", "failed"])
			.update({ status: "processing", updated_at: Date.now() });
		const won = n > 0;
		log.debug({ id, won }, "claim attempt");
		return won;
	}
	/** Crash recovery: any jot stuck in `processing` from a previous run goes back to pending. */
	async resetProcessing(): Promise<number> {
		return this.k("jots")
			.where({ status: "processing" })
			.update({ status: "pending", updated_at: Date.now() });
	}
	/** Most recent still-pending text/voice jot in a note — the open end of a squash run.
	 *  A new enrichable jot arriving within the squash window folds into this one's line. */
	async lastPendingEnrichableJot(notePath: string): Promise<Jot | undefined> {
		return this.k<Jot>("jots")
			.where({ note_path: notePath, status: "pending" })
			.whereIn("kind", ["text", "audio"])
			.orderBy("received_at", "desc")
			.first();
	}
	/** Pull a squashed follower back out of its merge — the user's 🤝 opt-out. Atomic
	 *  compare-and-swap like `claim()`: only flips `anchor` to the jot's own id (making it
	 *  a standalone leader) while it's still `pending`. Returns false if the leader already
	 *  folded it in (or it was never a follower), so the caller knows not to write a
	 *  placeholder for a jot that's already merged into another line. */
	async unsquash(id: string): Promise<boolean> {
		const n = await this.k("jots")
			.where({ id, status: "pending" })
			.whereNot("anchor", id)
			.update({ anchor: id, updated_at: Date.now() });
		const won = n > 0;
		log.debug({ id, won }, "unsquash attempt");
		return won;
	}
	/** Followers folded into a leader's line: other live jots sharing its anchor, oldest
	 *  first. The leader (id === anchor) is excluded; deleted jots are skipped. */
	async groupFollowers(leaderId: string): Promise<Jot[]> {
		return this.k<Jot>("jots")
			.where({ anchor: leaderId })
			.whereNot({ id: leaderId })
			.whereNot({ status: "deleted" })
			.orderBy("received_at");
	}
	/** Jots eligible for (re)processing: fresh, or failed but under the retry cap. */
	async pendingJots(): Promise<Jot[]> {
		return this.k<Jot>("jots")
			.where({ status: "pending" })
			.orWhere((q) =>
				q.where({ status: "failed" }).andWhere("attempts", "<", MAX_ATTEMPTS),
			)
			.orderBy("received_at");
	}

	// --- telegram message → jot map (reply-to-edit) ---
	async mapMessage(tgMessageId: number, jotId: string): Promise<void> {
		await this.k("msg_map")
			.insert({ tg_message_id: tgMessageId, jot_id: jotId })
			.onConflict("tg_message_id")
			.merge();
	}
	async jotForMessage(tgMessageId: number): Promise<string | undefined> {
		const r = await this.k("msg_map")
			.where({ tg_message_id: tgMessageId })
			.first();
		return r?.jot_id;
	}
	async messageForJot(jotId: string): Promise<number | undefined> {
		const r = await this.k("msg_map").where({ jot_id: jotId }).first();
		return r?.tg_message_id;
	}
	/** Forget a telegram message → jot mapping (e.g. a status message we just deleted). */
	async unmapMessage(tgMessageId: number): Promise<void> {
		await this.k("msg_map").where({ tg_message_id: tgMessageId }).delete();
	}

	// --- learned link rejections ---
	async rejections(): Promise<Set<string>> {
		const rows = await this.k("rejections").select("surface", "note");
		return new Set(rows.map((r) => `${r.surface} ${r.note}`)); // surface stored lowercased
	}
	async reject(surface: string, note: string): Promise<void> {
		await this.k("rejections")
			.insert({ surface: surface.toLowerCase(), note, created_at: Date.now() })
			.onConflict(["surface", "note"])
			.ignore();
	}

	// --- stopwords (editable in DB) ---
	async stopwords(): Promise<Set<string>> {
		const rows = await this.k("stopwords").select("word");
		return new Set(rows.map((r) => String(r.word).toLowerCase()));
	}

	// --- registered links: user-curated surface->note pairs that always force a link
	// (the opposite of a rejection). Read as a list, not a set, since forcedCandidates
	// needs the note target per surface, not just membership.
	async registeredLinks(): Promise<{ surface: string; note: string }[]> {
		// Ordered by (surface, note) so an interactive picker (mirroring /unreject's) can
		// index into this list by position and re-derive the same order on each tap.
		return this.k("registered_links")
			.select("surface", "note")
			.orderBy(["surface", "note"]);
	}
	async addRegisteredLink(surface: string, note: string): Promise<void> {
		await this.k("registered_links")
			.insert({
				surface: surface.trim().toLowerCase(),
				note: note.trim(),
				created_at: Date.now(),
			})
			.onConflict(["surface", "note"])
			.ignore();
	}
	async delRegisteredLink(surface: string, note: string): Promise<number> {
		return this.k("registered_links")
			.where({ surface: surface.trim().toLowerCase(), note: note.trim() })
			.del();
	}

	// --- pending ambiguous-link questions ---
	async addPendingLink(
		id: string,
		jotId: string,
		surface: string,
		note: string,
	): Promise<void> {
		await this.k("pending_links").insert({
			id,
			jot_id: jotId,
			surface,
			note,
			created_at: Date.now(),
		});
	}
	/** Atomic take: only one of two fast button taps gets the row. */
	async takePendingLink(
		id: string,
	): Promise<{ jot_id: string; surface: string; note: string } | undefined> {
		return this.k.transaction(async (trx) => {
			const row = await trx("pending_links").where({ id }).first();
			if (!row) return undefined;
			await trx("pending_links").where({ id }).del();
			return { jot_id: row.jot_id, surface: row.surface, note: row.note };
		});
	}

	// --- edits queued while a jot was still processing ---
	async queueEdit(jotId: string, instruction: string): Promise<void> {
		await this.k("queued_edits").insert({
			jot_id: jotId,
			instruction,
			created_at: Date.now(),
		});
	}
	/** Peek at queued edits without removing them, oldest first. The caller applies them
	 *  and then calls clearQueuedEdits — so a failed apply doesn't lose the edits. */
	async queuedEdits(jotId: string): Promise<string[]> {
		const rows = await this.k("queued_edits")
			.where({ jot_id: jotId })
			.orderBy("created_at");
		return rows.map((r) => r.instruction as string);
	}
	async clearQueuedEdits(jotId: string): Promise<void> {
		await this.k("queued_edits").where({ jot_id: jotId }).del();
	}

	// --- daily ratings (write-once gate) ---
	/** Atomically claim a day's rating. Returns `recorded: false` with the existing value
	 *  if the day is already rated, so a double-tap or a second prompt can't overwrite it. */
	async recordRating(
		date: string,
		rating: number,
	): Promise<{ recorded: boolean; current: number }> {
		return this.k.transaction(async (trx) => {
			const row = await trx("ratings").where({ date }).first();
			if (row) return { recorded: false, current: Number(row.rating) };
			await trx("ratings").insert({ date, rating, created_at: Date.now() });
			return { recorded: true, current: rating };
		});
	}
	/** Release a claimed rating so it can be retried (used when the vault write fails). */
	async clearRating(date: string): Promise<void> {
		await this.k("ratings").where({ date }).del();
	}

	/** Jot counts by kind + outcome over a [from,to) epoch-ms window, for /stats and the
	 *  daily summary. */
	async windowStats(from: number, to: number): Promise<StatsRow> {
		const row = await this.k("jots")
			.where("received_at", ">=", from)
			.andWhere("received_at", "<", to)
			.select(
				this.k.raw("COUNT(*) as total"),
				this.k.raw("SUM(CASE WHEN kind='text' THEN 1 ELSE 0 END) as text"),
				this.k.raw("SUM(CASE WHEN kind='audio' THEN 1 ELSE 0 END) as audio"),
				this.k.raw("SUM(CASE WHEN kind='image' THEN 1 ELSE 0 END) as image"),
				this.k.raw("SUM(CASE WHEN kind='video' THEN 1 ELSE 0 END) as video"),
				this.k.raw("SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done"),
				this.k.raw(
					"SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed",
				),
				this.k.raw(
					"SUM(CASE WHEN status='abandoned' THEN 1 ELSE 0 END) as abandoned",
				),
				this.k.raw(
					"SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) as inflight",
				),
			)
			.first();
		const n = (v: unknown) => Number(v ?? 0);
		return {
			total: n(row?.total),
			text: n(row?.text),
			audio: n(row?.audio),
			image: n(row?.image),
			video: n(row?.video),
			done: n(row?.done),
			failed: n(row?.failed),
			abandoned: n(row?.abandoned),
			inflight: n(row?.inflight),
		};
	}

	/** Live jot counts per status (whole table), for /status. */
	async statusCounts(): Promise<Record<JotStatus, number>> {
		const rows = await this.k("jots")
			.select("status")
			.count("* as n")
			.groupBy("status");
		const out: Record<JotStatus, number> = {
			pending: 0,
			processing: 0,
			done: 0,
			failed: 0,
			abandoned: 0,
			deleted: 0,
		};
		for (const r of rows) out[r.status as JotStatus] = Number(r.n);
		return out;
	}

	/** Most recently touched failed/abandoned jots, for /failed. */
	async failedJots(limit = 10): Promise<Jot[]> {
		return this.k<Jot>("jots")
			.whereIn("status", ["failed", "abandoned"])
			.orderBy("updated_at", "desc")
			.limit(limit);
	}

	/** Most recent live jots (any status except deleted), newest first — for the /menu
	 *  jots browser, which gives a read/edit surface the reply-to-message flow can't. */
	async recentJots(limit = 10): Promise<Jot[]> {
		return this.k<Jot>("jots")
			.whereNot({ status: "deleted" })
			.orderBy("received_at", "desc")
			.limit(limit);
	}

	/** Reprocess-eligible jots (done/failed/abandoned — not deleted, not in flight) whose
	 *  `received_at` falls in [from, to). Backs /reprocess's day and date-range pickers.
	 *  Only `id`/`anchor` are selected — callers dedupe/resolve to a leader's anchor, they
	 *  never touch the (potentially large) raw_text/transcript payloads. */
	async jotsInRange(
		from: number,
		to: number,
	): Promise<Pick<Jot, "id" | "anchor">[]> {
		return this.k<Jot>("jots")
			.select("id", "anchor")
			.where("received_at", ">=", from)
			.andWhere("received_at", "<", to)
			.whereIn("status", ["done", "failed", "abandoned"])
			.orderBy("received_at");
	}

	/** Page of reprocess-eligible jots, newest first — /reprocess's "one jot" picker, which
	 *  browses full history rather than recentJots' fixed top-10. */
	async jotsPage(offset: number, limit: number): Promise<Jot[]> {
		return this.k<Jot>("jots")
			.whereIn("status", ["done", "failed", "abandoned"])
			.orderBy("received_at", "desc")
			.limit(limit)
			.offset(offset);
	}

	// SQLite's bound-parameter cap (SQLITE_MAX_VARIABLE_NUMBER, 32766 on the bundled
	// better-sqlite3 build) — resetForReprocess chunks whereIn("id", ids) to this size so
	// an unusually large date-range reprocess can't hit "too many SQL variables".
	private static readonly ID_CHUNK = 500;

	/** Reset a specific set of jots to pending for reprocessing (clears attempts/error) —
	 *  only touches ones still eligible (done/failed/abandoned), so a jot that started
	 *  processing meanwhile isn't clobbered. A single atomic UPDATE...WHERE per chunk (the
	 *  same claim-style pattern as `claim()`) rather than a select-then-update: the latter
	 *  leaves a race window where a jot could flip to `processing` between the two
	 *  statements and get clobbered back to `pending` anyway. Returns the ids actually
	 *  reset (a subset of `ids`, via RETURNING), so the caller enqueues only jots it
	 *  actually flipped to pending rather than ones that raced to `processing` or came
	 *  from a stale/crafted callback. */
	async resetForReprocess(ids: string[]): Promise<string[]> {
		const reset: string[] = [];
		for (let i = 0; i < ids.length; i += Repository.ID_CHUNK) {
			const chunk = ids.slice(i, i + Repository.ID_CHUNK);
			const rows: { id: string }[] = await this.k("jots")
				.whereIn("id", chunk)
				.whereIn("status", ["done", "failed", "abandoned"])
				.update({
					status: "pending",
					attempts: 0,
					error: null,
					updated_at: Date.now(),
				})
				.returning("id");
			reset.push(...rows.map((r) => r.id));
		}
		return reset;
	}

	/** Requeue failed (and optionally abandoned) jots: reset to pending, clear attempts.
	 *  Returns how many were reset. */
	async resetFailed(includeAbandoned: boolean): Promise<number> {
		const statuses = includeAbandoned ? ["failed", "abandoned"] : ["failed"];
		return this.k("jots").whereIn("status", statuses).update({
			status: "pending",
			attempts: 0,
			error: null,
			updated_at: Date.now(),
		});
	}

	/** Reset one jot to be retried from scratch (clears attempts + error). The caller
	 *  re-queues it (the queue lives outside the persistence boundary). */
	async resetForRetry(id: string): Promise<void> {
		await this.updateJot(id, { status: "pending", attempts: 0, error: null });
	}

	/** Terminal state for a jot whose journal line the user removed. Distinct from
	 *  `abandoned` so /retry --abandoned never resurrects a deliberate deletion. */
	async markDeleted(id: string): Promise<void> {
		await this.updateJot(id, { status: "deleted" });
	}

	// --- stopwords: writes (reads via stopwords() above) ---
	async addStopword(word: string): Promise<void> {
		await this.k("stopwords")
			.insert({ word: word.toLowerCase() })
			.onConflict("word")
			.ignore();
	}
	async delStopword(word: string): Promise<number> {
		return this.k("stopwords").where({ word: word.toLowerCase() }).del();
	}

	// --- rejections: list + undo (set-shaped read via rejections() above) ---
	async rejectionList(): Promise<{ surface: string; note: string }[]> {
		// Ordered by (surface, note) so the interactive /unreject menu can index into
		// this list by position and re-derive the same order on each button tap.
		return this.k("rejections")
			.select("surface", "note")
			.orderBy(["surface", "note"]);
	}
	async unreject(surface: string, note: string): Promise<number> {
		return this.k("rejections")
			.where({ surface: surface.toLowerCase(), note })
			.del();
	}

	// --- runtime settings (key/value; survives restart) ---
	async getSetting(key: string): Promise<string | undefined> {
		const r = await this.k("settings").where({ key }).first();
		return r?.value;
	}
	async setSetting(key: string, value: string): Promise<void> {
		await this.k("settings")
			.insert({ key, value, updated_at: Date.now() })
			.onConflict("key")
			.merge();
	}

	async close(): Promise<void> {
		await this.k.destroy();
	}
}
