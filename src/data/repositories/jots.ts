import type { Knex } from "knex";
import {
  JOT_STATUSES,
  type Jot,
  type JotSection,
  type JotStatus,
  MAX_ATTEMPTS,
  TERMINAL_STATUSES,
} from "../../domain/jot/entity.ts";
import type { Stats, StatusCounts } from "../../domain/jot/structures.ts";
import { logger } from "../../libs/log.ts";

const log = logger("db");

export class JotRepository {
  constructor(private k: Knex) {}

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
  /** Most recent still-pending text/voice jot in a note, the open end of a squash run.
   *  A new enrichable jot arriving within the squash window folds into this one's line.
   *  Only jots in the same section count, so a TIL jot between two journal jots doesn't
   *  split their run. */
  async lastPendingEnrichableJot(
    notePath: string,
    section: JotSection,
  ): Promise<Jot | undefined> {
    return this.k<Jot>("jots")
      .where({ note_path: notePath, status: "pending", section })
      .whereIn("kind", ["text", "audio"])
      .orderBy("received_at", "desc")
      .first();
  }
  /** Pull a squashed follower back out of its merge, the user's 🤝 opt-out. Atomic
   *  compare-and-swap like `claim()`: only sets `anchor` to the jot's own id (making it
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

  async queueEdit(jotId: string, instruction: string): Promise<void> {
    await this.k("queued_edits").insert({
      jot_id: jotId,
      instruction,
      created_at: Date.now(),
    });
  }
  /** Peek at queued edits without removing them, oldest first. The caller applies them
   *  and then calls clearQueuedEdits, so a failed apply doesn't lose the edits. */
  async queuedEdits(jotId: string): Promise<string[]> {
    const rows = await this.k("queued_edits")
      .where({ jot_id: jotId })
      .orderBy("created_at");
    return rows.map((r) => r.instruction as string);
  }
  async clearQueuedEdits(jotId: string): Promise<void> {
    await this.k("queued_edits").where({ jot_id: jotId }).del();
  }

  /** Jot counts by kind + outcome over a [from,to) epoch-ms window, for /stats and the
   *  daily summary. */
  async windowStats(from: number, to: number): Promise<Stats> {
    const row = await this.k("jots")
      .where("received_at", ">=", from)
      .andWhere("received_at", "<", to)
      .select(
        this.k.raw("COUNT(*) as total"),
        this.k.raw("SUM(CASE WHEN kind='text' THEN 1 ELSE 0 END) as text"),
        this.k.raw("SUM(CASE WHEN kind='audio' THEN 1 ELSE 0 END) as audio"),
        this.k.raw("SUM(CASE WHEN kind='image' THEN 1 ELSE 0 END) as image"),
        this.k.raw("SUM(CASE WHEN kind='video' THEN 1 ELSE 0 END) as video"),
        ...TERMINAL_STATUSES.map((s) =>
          this.k.raw(`SUM(CASE WHEN status='${s}' THEN 1 ELSE 0 END) as ${s}`),
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
      ...(Object.fromEntries(
        TERMINAL_STATUSES.map((s) => [s, n(row?.[s])]),
      ) as Pick<Stats, (typeof TERMINAL_STATUSES)[number]>),
      inflight: n(row?.inflight),
    };
  }

  /** Live jot counts per status (whole table), for /status. */
  async statusCounts(): Promise<StatusCounts> {
    const rows = await this.k("jots")
      .select("status")
      .count("* as n")
      .groupBy("status");
    const out = Object.fromEntries(
      JOT_STATUSES.map((s) => [s, 0]),
    ) as StatusCounts;
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

  /** Most recent live jots (any status except deleted), newest first, for the /menu
   *  jots browser, which gives a read/edit surface the reply-to-message flow can't. */
  async recentJots(limit = 10): Promise<Jot[]> {
    return this.k<Jot>("jots")
      .whereNot({ status: "deleted" })
      .orderBy("received_at", "desc")
      .limit(limit);
  }

  /** Reprocess-eligible jots (done/failed/abandoned, not deleted, not in flight) whose
   *  `received_at` falls in [from, to). Backs /reprocess's day and date-range pickers.
   *  Only `id`/`anchor` are selected: callers dedupe/resolve to a leader's anchor, they
   *  never touch the (potentially large) raw_text/transcript payloads. */
  async jotsInRange(
    from: number,
    to: number,
  ): Promise<Pick<Jot, "id" | "anchor">[]> {
    return this.k<Jot>("jots")
      .select("id", "anchor")
      .where("received_at", ">=", from)
      .andWhere("received_at", "<", to)
      .whereIn("status", [...TERMINAL_STATUSES])
      .orderBy("received_at");
  }

  /** Page of reprocess-eligible jots, newest first, /reprocess's "one jot" picker, which
   *  browses full history rather than recentJots' fixed top-10. */
  async jotsPage(offset: number, limit: number): Promise<Jot[]> {
    return this.k<Jot>("jots")
      .whereIn("status", [...TERMINAL_STATUSES])
      .orderBy("received_at", "desc")
      .limit(limit)
      .offset(offset);
  }

  // SQLite's bound-parameter cap (SQLITE_MAX_VARIABLE_NUMBER, 32766 on the bundled
  // better-sqlite3 build), resetForReprocess chunks whereIn("id", ids) to this size so
  // an unusually large date-range reprocess can't hit "too many SQL variables".
  private static readonly ID_CHUNK = 500;

  /** Reset a specific set of jots to pending for reprocessing (clears attempts/error).
   *  Only touches ones still eligible (done/failed/abandoned), so a jot that started
   *  processing meanwhile isn't overwritten. A single atomic UPDATE...WHERE per chunk (the
   *  same claim-style pattern as `claim()`) rather than a select-then-update: the latter
   *  leaves a race window where a jot could move to `processing` between the two
   *  statements and get overwritten back to `pending` anyway. Returns the ids actually
   *  reset (a subset of `ids`, via RETURNING), so the caller enqueues only jots it
   *  actually set to pending rather than ones that raced to `processing` or came
   *  from a stale/crafted callback. */
  async resetForReprocess(ids: string[]): Promise<string[]> {
    const reset: string[] = [];
    for (let i = 0; i < ids.length; i += JotRepository.ID_CHUNK) {
      const chunk = ids.slice(i, i + JotRepository.ID_CHUNK);
      const rows: { id: string }[] = await this.k("jots")
        .whereIn("id", chunk)
        .whereIn("status", [...TERMINAL_STATUSES])
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

  /** Whether this jot was already asked "Move this to TIL?", whatever the answer was. */
  async tilOffered(jotId: string): Promise<boolean> {
    const row = await this.k("jots").where({ id: jotId }).first("til_offered");
    return Boolean(row?.til_offered);
  }

  async markTilOffered(jotId: string): Promise<void> {
    await this.k("jots").where({ id: jotId }).update({ til_offered: true });
    log.debug({ id: jotId }, "til offered");
  }
}
