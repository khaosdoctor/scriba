import { basename } from "node:path";
import {
	candidates,
	combineEnrichSource,
	doneMessage,
	enrichableSource,
	escapeHtml,
	forcedCandidates,
	isRecoverable,
	journalLine,
	linkDateWords,
	makeJotId,
	replaceAnchorLine,
} from "../core.ts";
import { type Jot, MAX_ATTEMPTS, type Repository } from "../db.ts";
import { logger } from "../log.ts";
import type { Enricher } from "../services/enrich.ts";
import type { LinkIndex } from "../services/links.ts";
import type { ObsidianClient } from "../services/obsidian.ts";
import type { Transcriber } from "../services/transcribe.ts";

const log = logger("processor");

/** First status line shown per jot kind while it's being worked on. */
const STARTING: Record<Jot["kind"], string> = {
	audio: "🎤 Transcribing your voice note…",
	text: "✨ Weaving it into your journal…",
	image: "🖼️ Saving your image…",
	video: "🎬 Saving your video…",
};

export interface DownloadedFile {
	bytes: Uint8Array;
	ext: string;
	mime: string;
}

/** What the processor needs from the bot: user-facing I/O it can't do itself. */
export interface BotServices {
	notify: (text: string) => Promise<void>;
	// Create-or-edit the one live status message for a jot (HTML parse mode). Edited in
	// place through the jot's lifecycle so the chat stays a clean audit trail, not spam.
	// `retry: true` attaches a force-retry button (used when a jot is given up on).
	status: (
		jotId: string,
		html: string,
		opts?: { retry?: boolean },
	) => Promise<void>;
	// Delete a jot's live status message if one exists (used to collapse stray
	// per-follower messages into the leader's single confirmation on a squash).
	deleteStatus: (jotId: string) => Promise<void>;
	askLink: (pendingId: string, surface: string, note: string) => Promise<void>;
	downloadFile: (fileId: string) => Promise<DownloadedFile>;
	onJotDone: (jotId: string) => Promise<void>; // apply edits queued while processing
	react: (
		jotId: string,
		state: "done" | "failed" | "retrying",
	) => Promise<void>; // swap the intake reaction on the jot's message
	typing: () => Promise<void>; // "typing…" chat action while a jot is being processed
}

/** Turns a queued jot into an enriched, written journal line. Audio + text only. */
export class JotProcessor {
	constructor(
		private repo: Repository,
		private obsidian: ObsidianClient,
		private transcriber: Transcriber,
		private enricher: Enricher,
		private links: LinkIndex,
		private bot: BotServices,
	) {}

	async processBatch(ids: string[]): Promise<void> {
		// ponytail: one agent call per jot. Batching coalesces arrivals + retries;
		// true bulk-in-one-prompt enrichment is a future token optimisation.
		log.info({ count: ids.length, ids }, "processing batch");
		for (const id of ids) await this.processJot(id);
		log.info({ count: ids.length }, "batch complete");
	}

	/** Forever-retry for failed jots (capped) + crash recovery for pending. */
	async retrySweep(): Promise<void> {
		const pending = await this.repo.pendingJots();
		if (!pending.length) return log.debug("retry sweep: nothing pending");
		log.info(
			{ count: pending.length, ids: pending.map((j) => j.id) },
			"retry sweep",
		);
		for (const jot of pending) await this.processJot(jot.id);
	}

	async processJot(id: string): Promise<void> {
		const loaded = await this.repo.getJot(id);
		if (!loaded) return log.warn({ id }, "processJot: jot not found, skipping");
		// A squashed follower shares its leader's anchor and is folded into the leader's
		// line, so the leader processes it. Defer — unless the leader is gone (deleted), in
		// which case fall through and process this jot standalone (its write appends).
		if (loaded.anchor !== loaded.id) {
			const leader = await this.repo.getJot(loaded.anchor);
			if (leader && leader.status !== "deleted") {
				// Group already finished but this follower lingered (e.g. a crash between the
				// leader's write and marking its followers): reconcile so it doesn't stay pending.
				if (
					(leader.status === "done" || leader.status === "abandoned") &&
					loaded.status !== "done"
				)
					await this.repo.updateJot(loaded.id, { status: "done", error: null });
				return log.debug(
					{ id, leader: loaded.anchor },
					"processJot: squashed follower, deferred to leader",
				);
			}
		}
		// Atomic claim — only the winner proceeds, so flush + sweeps can't double-process.
		if (!(await this.repo.claim(id)))
			return log.debug({ id }, "processJot: claim lost, another worker has it");
		const t0 = Date.now();
		log.info(
			{ id, kind: loaded.kind, attempts: loaded.attempts },
			"processing jot",
		);
		await this.bot.typing(); // best-effort "typing…" so the user sees work is underway
		await this.bot.status(id, STARTING[loaded.kind]); // live status message, edited in place from here on
		try {
			const jot = await this.ensureMedia(loaded);
			// Voice notes: show the transcript the moment it exists, then the enriching step.
			if (jot.kind === "audio" && jot.transcript?.trim()) {
				await this.bot.status(
					id,
					`🎤 <i>${escapeHtml(jot.transcript.trim())}</i>\n\n✨ Weaving it into your journal…`,
				);
			}
			// Fold in any squashed followers (jots sharing this leader's anchor): transcribe
			// their audio, then enrich the whole burst as one entry. Attach-only leaders
			// (image/video) never have followers — only text/voice squash.
			const followers: Jot[] = [];
			for (const f of await this.repo.groupFollowers(jot.id))
				followers.push(await this.ensureMedia(f));
			const merged = followers.length > 0;
			const source = combineEnrichSource(
				[jot, ...followers].map((j) => enrichableSource(j)),
			); // image/video are attach-only
			if (merged)
				log.info(
					{ id, followers: followers.map((f) => f.id) },
					`squash: enriching ${followers.length + 1} jots as one line`,
				);

			let textPart = source;
			if (source.trim()) {
				const [stopwords, rejections, registered] = await Promise.all([
					this.repo.stopwords(),
					this.repo.rejections(),
					this.repo.registeredLinks(),
				]);
				const index = this.links.list();
				if (!index.length)
					log.warn(
						{ id },
						"enricher: link index empty (SCRIBA_VAULT_HOST_PATH unset or unreadable) — no wikilinks suggested",
					);
				// Registered (user-forced) pairs win over anything the vault index would also
				// suggest for the same surface+note, so it isn't listed (and judged) twice.
				// JSON-encoded so a surface/note containing a space can't collide with a
				// different pair (plain `${surface} ${note}` concatenation could).
				const pairKey = (c: { surface: string; note: string }) =>
					JSON.stringify([c.surface.toLowerCase(), c.note]);
				const forced = forcedCandidates(source, registered);
				const forcedKeys = new Set(forced.map(pairKey));
				const cands = [
					...forced,
					...candidates(source, index, stopwords, rejections).filter(
						(c) => !forcedKeys.has(pairKey(c)),
					),
				];
				log.info(
					{
						id,
						indexSize: index.length,
						count: cands.length,
						forced: forced.length,
						stopwords: stopwords.size,
						rejections: rejections.size,
						candidates: cands.map(
							(c) =>
								`"${c.surface}" -> [[${c.note}]]${c.forced ? " (registered)" : ""}`,
						),
					},
					`enricher: ${cands.length} link candidate(s) (${forced.length} registered) from local index of ${index.length} aliases`,
				);
				log.info(
					{ id, chars: source.length, candidates: cands.length },
					"enricher: calling agent",
				);
				const res = await this.enricher.enrich({
					text: source,
					candidates: cands,
					merge: merged,
				});
				textPart = res.text;
				log.info(
					{
						id,
						ambiguous: res.ambiguous.length,
						ambiguousLinks: res.ambiguous.map(
							(a) => `"${a.surface}" -> [[${a.note}]]`,
						),
						usage: res.usage,
					},
					"enricher: done",
				);
				for (const a of res.ambiguous) {
					const pid = makeJotId();
					await this.repo.addPendingLink(pid, jot.id, a.surface, a.note);
					await this.bot.askLink(pid, a.surface, a.note);
					log.debug(
						{ id, pid, surface: a.surface, note: a.note },
						"asked to confirm link",
					);
				}
			} else {
				log.debug(
					{ id, kind: jot.kind },
					"no enrichable text (attach-only or empty)",
				);
			}

			await this.writeLine(jot, this.composeLine(jot, textPart));
			await this.repo.updateJot(jot.id, { status: "done", error: null });
			// Followers rode into the leader's line — mark them done too so they're not
			// reprocessed or counted as in-flight.
			for (const f of followers)
				await this.repo.updateJot(f.id, { status: "done", error: null });
			// Post-`done` steps are best-effort UI + the queued-edit drain. A transient throw
			// here must NOT route to fail(): that would demote an already-committed `done` jot
			// to `failed`, causing wasted re-enrichment and duplicate link prompts on retry.
			try {
				await this.bot.react(jot.id, "done");
				await this.bot.status(
					jot.id,
					doneMessage(
						jot.time,
						jot.kind,
						textPart,
						jot.id,
						merged ? followers.length + 1 : 0,
					),
				);
				await this.bot.onJotDone(jot.id); // apply anything queued while we were working
				// Each follower's own message gets the done reaction + its queued edits drained;
				// the leader carries the single status message for the whole group. Any stray
				// status message a follower picked up (e.g. processed standalone before squash
				// caught it, then reconciled) is deleted so the burst ends with one bot message.
				for (const f of followers) {
					await this.bot.react(f.id, "done");
					await this.bot.deleteStatus(f.id);
					await this.bot.onJotDone(f.id);
				}
			} catch (err) {
				log.error({ id, err }, "post-done side effect failed — jot stays done");
			}
			log.info({ id, ms: Date.now() - t0 }, "jot done");
		} catch (err) {
			await this.fail(loaded, err);
		}
	}

	/** Record a failure: retry if transient and under the cap, else give up gracefully. */
	private async fail(jot: Jot, err: unknown): Promise<void> {
		const msg = err instanceof Error ? err.message : String(err);
		const attempts = (jot.attempts ?? 0) + 1;
		const recoverable = isRecoverable(err);
		if (recoverable && attempts < MAX_ATTEMPTS) {
			log.warn(
				{ id: jot.id, attempts, max: MAX_ATTEMPTS, err },
				"jot failed (transient) — will retry",
			);
			await this.repo.updateJot(jot.id, {
				status: "failed",
				attempts,
				error: msg,
			});
			await this.bot.react(jot.id, "retrying");
			return;
		}
		// Unrecoverable, or out of tries: post whatever we have un-enriched, then stop.
		const reason = recoverable
			? `no luck after ${attempts} tries`
			: "unrecoverable error";
		log.error(
			{ id: jot.id, attempts, recoverable, err },
			"jot abandoned — posting un-enriched",
		);
		// Fold squashed followers into the un-enriched line too, so nothing is dropped and
		// no follower is left stranded in `pending`.
		const followers = await this.repo.groupFollowers(jot.id);
		const source = combineEnrichSource(
			[jot, ...followers].map((j) =>
				enrichableSource(j, "🎤 (voice note — transcription failed)"),
			),
		);
		try {
			await this.writeLine(jot, this.composeLine(jot, source));
		} catch {
			/* the note write itself is failing — nothing more we can do */
		}
		for (const j of [jot, ...followers]) {
			await this.repo.updateJot(j.id, {
				status: "abandoned",
				attempts,
				error: msg,
			});
			await this.bot.react(j.id, "failed");
			// Followers folded into the leader's line — drop any stray status message so the
			// leader carries the single "gave up" confirmation for the whole burst.
			if (j.id !== jot.id) await this.bot.deleteStatus(j.id);
			await this.bot.onJotDone(j.id); // apply edits queued while it was failing
		}
		const squash =
			followers.length > 0
				? `\n🧵 ${followers.length + 1} jots squashed into one entry`
				: "";
		await this.bot.status(
			jot.id,
			`⚠️ Gave up on a ${jot.kind} jot (${reason}). Posted it un-enriched.\n<code>${escapeHtml(msg)}</code>${squash}`,
			{ retry: true },
		);
	}

	private async ensureMedia(jot: Jot): Promise<Jot> {
		if (jot.kind === "text" || !jot.file_id) return jot;
		if (jot.kind === "audio" && jot.transcript) return jot; // audio is transcription-only, never attached
		if (jot.asset_path) return jot;

		log.debug(
			{ id: jot.id, fileId: jot.file_id },
			"downloading media from telegram",
		);
		const file = await this.bot.downloadFile(jot.file_id);
		log.debug(
			{ id: jot.id, ext: file.ext, mime: file.mime, bytes: file.bytes.length },
			"media downloaded",
		);
		const patch: Partial<Jot> = {};
		if (jot.kind === "image" || jot.kind === "video") {
			const date = basename(jot.note_path, ".md");
			const name = `${date}_${jot.time.replaceAll(":", "")}_${jot.id}.${file.ext}`;
			patch.asset_path = await this.obsidian.saveAsset(
				name,
				file.bytes,
				file.mime,
			);
			log.info({ id: jot.id, asset: patch.asset_path }, "asset saved to vault");
		}
		if (jot.kind === "audio" && !jot.transcript) {
			log.debug({ id: jot.id }, "transcribing audio");
			patch.transcript = await this.transcriber.transcribe(
				file.bytes,
				file.ext,
			);
			log.info(
				{ id: jot.id, chars: patch.transcript.length },
				"audio transcribed",
			);
		}
		// Captionless image → generate one with vision (used as the embed display).
		if (jot.kind === "image" && !jot.raw_text) {
			log.debug({ id: jot.id }, "captioning image with vision");
			patch.raw_text = await this.enricher.describeImage(file.bytes, file.mime);
			log.info({ id: jot.id, caption: patch.raw_text }, "image captioned");
		}
		await this.repo.updateJot(jot.id, patch);
		return { ...jot, ...patch };
	}

	private composeLine(jot: Jot, textPart: string): string {
		const linked = linkDateWords(textPart, basename(jot.note_path, ".md"));
		let embed = "";
		if (jot.asset_path) {
			const caption =
				(jot.kind === "image" || jot.kind === "video") && jot.raw_text;
			embed = caption
				? `![[${jot.asset_path}|${jot.raw_text}]]`
				: `![[${jot.asset_path}]]`;
		}
		const content = [linked, embed].filter(Boolean).join(" ") || "…";
		return journalLine(jot.time, content, jot.anchor);
	}

	private async writeLine(jot: Jot, line: string): Promise<void> {
		// Recreate the daily note if intake never got to it (Obsidian was down at arrival).
		// Idempotent + cached, so it's ~one GET when the note already exists.
		await this.obsidian.ensureDailyNote(basename(jot.note_path, ".md"));
		// Read + replace + write under the per-note lock so a concurrent write (another jot,
		// an edit, the retry sweep) can't clobber the line we just placed.
		const replaced = await this.obsidian.withNoteLock(
			jot.note_path,
			async () => {
				const note = await this.obsidian.readNote(jot.note_path); // live — user may have edited
				const out = replaceAnchorLine(note, jot.anchor, line);
				if (out) await this.obsidian.writeNote(jot.note_path, out);
				return out !== null;
			},
		);
		if (replaced) {
			log.debug({ id: jot.id, anchor: jot.anchor }, "line replaced in place");
			return;
		}
		// Anchor missing (line hand-deleted, or note recreated). appendJournalLine takes the
		// same lock itself, so it must run AFTER the block above releases — no re-entrancy.
		log.warn(
			{ id: jot.id, anchor: jot.anchor },
			"anchor missing — appending line instead",
		);
		await this.obsidian.appendJournalLine(basename(jot.note_path, ".md"), line);
	}
}
