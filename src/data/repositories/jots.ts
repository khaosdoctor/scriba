import type { Knex } from "knex";
import {
  JOT_KINDS,
  type Jot,
  type JotKind,
  type JotSection,
  type JotStatus,
  MAX_ATTEMPTS,
  REPROCESSABLE_STATUSES,
  SQUASHABLE_KINDS,
} from "../../domain/jot/entity.ts";
import { emptyStatusCounts } from "../../domain/jot/rules.ts";
import type { Stats, StatusCounts } from "../../domain/jot/structures.ts";
import { logger } from "../../libs/log.ts";

const log = logger("db");

export class JotRepository {
  constructor(private knex: Knex) {}

  async insertJot(jot: Jot): Promise<void> {
    await this.knex("jots").insert(jot);
    log.debug(
      { id: jot.id, kind: jot.kind, note: jot.note_path },
      "jot inserted",
    );
  }
  async getJot(id: string): Promise<Jot | undefined> {
    return this.knex<Jot>("jots").where({ id }).first();
  }
  async updateJot(id: string, patch: Partial<Jot>): Promise<void> {
    await this.knex("jots")
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
    const changed = await this.knex("jots")
      .where({ id })
      .whereIn("status", ["pending", "failed"])
      .update({ status: "processing", updated_at: Date.now() });
    const won = changed > 0;
    log.debug({ id, won }, "claim attempt");
    return won;
  }
  /** Crash recovery: any jot stuck in `processing` from a previous run goes back to pending. */
  async resetProcessing(): Promise<number> {
    return this.knex("jots")
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
    return this.knex<Jot>("jots")
      .where({ note_path: notePath, status: "pending", section })
      .whereIn("kind", [...SQUASHABLE_KINDS])
      .orderBy("received_at", "desc")
      .first();
  }
  /** Pull a squashed follower back out of its merge, the user's 🤝 opt-out. Atomic
   *  compare-and-swap like `claim()`: only sets `anchor` to the jot's own id (making it
   *  a standalone leader) while it's still `pending`. Returns false if the leader already
   *  folded it in (or it was never a follower), so the caller knows not to write a
   *  placeholder for a jot that's already merged into another line. */
  async unsquash(id: string): Promise<boolean> {
    const changed = await this.knex("jots")
      .where({ id, status: "pending" })
      .whereNot("anchor", id)
      .update({ anchor: id, updated_at: Date.now() });
    const won = changed > 0;
    log.debug({ id, won }, "unsquash attempt");
    return won;
  }
  async groupFollowers(leaderId: string): Promise<Jot[]> {
    return this.knex<Jot>("jots")
      .where({ anchor: leaderId })
      .whereNot({ id: leaderId })
      .whereNot({ status: "deleted" })
      .orderBy("received_at");
  }
  async pendingJots(): Promise<Jot[]> {
    return this.knex<Jot>("jots")
      .where({ status: "pending" })
      .orWhere((builder) =>
        builder
          .where({ status: "failed" })
          .andWhere("attempts", "<", MAX_ATTEMPTS),
      )
      .orderBy("received_at");
  }

  async mapMessage(tgMessageId: number, jotId: string): Promise<void> {
    await this.knex("msg_map")
      .insert({ tg_message_id: tgMessageId, jot_id: jotId })
      .onConflict("tg_message_id")
      .merge();
  }
  async jotForMessage(tgMessageId: number): Promise<string | undefined> {
    const row = await this.knex("msg_map")
      .where({ tg_message_id: tgMessageId })
      .first();
    return row?.jot_id;
  }
  async messageForJot(jotId: string): Promise<number | undefined> {
    const row = await this.knex("msg_map").where({ jot_id: jotId }).first();
    return row?.tg_message_id;
  }
  async unmapMessage(tgMessageId: number): Promise<void> {
    await this.knex("msg_map").where({ tg_message_id: tgMessageId }).delete();
  }

  async queueEdit(jotId: string, instruction: string): Promise<void> {
    await this.knex("queued_edits").insert({
      jot_id: jotId,
      instruction,
      created_at: Date.now(),
    });
  }
  /** Peek at queued edits without removing them, oldest first. The caller applies them
   *  and then calls clearQueuedEdits, so a failed apply doesn't lose the edits. */
  async queuedEdits(jotId: string): Promise<string[]> {
    const rows = await this.knex("queued_edits")
      .where({ jot_id: jotId })
      .orderBy("created_at");
    return rows.map((row) => row.instruction as string);
  }
  async clearQueuedEdits(jotId: string): Promise<void> {
    await this.knex("queued_edits").where({ jot_id: jotId }).del();
  }

  async windowStats(from: number, to: number): Promise<Stats> {
    const row = await this.knex("jots")
      .where("received_at", ">=", from)
      .andWhere("received_at", "<", to)
      .select(
        this.knex.raw("COUNT(*) as total"),
        ...JOT_KINDS.map((kind) =>
          this.knex.raw(
            `SUM(CASE WHEN kind='${kind}' THEN 1 ELSE 0 END) as ${kind}`,
          ),
        ),
        ...REPROCESSABLE_STATUSES.map((status) =>
          this.knex.raw(
            `SUM(CASE WHEN status='${status}' THEN 1 ELSE 0 END) as ${status}`,
          ),
        ),
        this.knex.raw(
          "SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) as inflight",
        ),
      )
      .first();
    const toNumber = (value: unknown) => Number(value ?? 0);
    return {
      total: toNumber(row?.total),
      ...(Object.fromEntries(
        JOT_KINDS.map((kind) => [kind, toNumber(row?.[kind])]),
      ) as Pick<Stats, JotKind>),
      ...(Object.fromEntries(
        REPROCESSABLE_STATUSES.map((status) => [
          status,
          toNumber(row?.[status]),
        ]),
      ) as Pick<Stats, (typeof REPROCESSABLE_STATUSES)[number]>),
      inflight: toNumber(row?.inflight),
    };
  }

  async statusCounts(): Promise<StatusCounts> {
    const rows = await this.knex("jots")
      .select("status")
      .count("* as n")
      .groupBy("status");
    const out = emptyStatusCounts();
    for (const row of rows) out[row.status as JotStatus] = Number(row.n);
    return out;
  }

  async failedJots(limit = 10): Promise<Jot[]> {
    return this.knex<Jot>("jots")
      .whereIn("status", ["failed", "abandoned"])
      .orderBy("updated_at", "desc")
      .limit(limit);
  }

  async recentJots(limit = 10): Promise<Jot[]> {
    return this.knex<Jot>("jots")
      .whereNot({ status: "deleted" })
      .orderBy("received_at", "desc")
      .limit(limit);
  }

  async jotsInRange(
    from: number,
    to: number,
  ): Promise<Pick<Jot, "id" | "anchor">[]> {
    return this.knex<Jot>("jots")
      .select("id", "anchor")
      .where("received_at", ">=", from)
      .andWhere("received_at", "<", to)
      .whereIn("status", [...REPROCESSABLE_STATUSES])
      .orderBy("received_at");
  }

  async jotsPage(offset: number, limit: number): Promise<Jot[]> {
    return this.knex<Jot>("jots")
      .whereIn("status", [...REPROCESSABLE_STATUSES])
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
    for (let start = 0; start < ids.length; start += JotRepository.ID_CHUNK) {
      const chunk = ids.slice(start, start + JotRepository.ID_CHUNK);
      const rows: { id: string }[] = await this.knex("jots")
        .whereIn("id", chunk)
        .whereIn("status", [...REPROCESSABLE_STATUSES])
        .update(this.pendingReset())
        .returning("id");
      reset.push(...rows.map((row) => row.id));
    }
    return reset;
  }

  async resetFailed(includeAbandoned: boolean): Promise<number> {
    const statuses = includeAbandoned ? ["failed", "abandoned"] : ["failed"];
    return this.knex("jots")
      .whereIn("status", statuses)
      .update(this.pendingReset());
  }

  private pendingReset() {
    return {
      status: "pending",
      attempts: 0,
      error: null,
      updated_at: Date.now(),
    };
  }

  /** Reset one jot to be retried from scratch (clears attempts + error), by the same
   *  compare-and-swap as `claim()`: a jot being processed right now, or a deleted one, is
   *  left alone, so a second tap or a tap racing the retry pass cannot send a processing
   *  jot back to pending. True when the row was reset. The caller re-queues it (the queue
   *  lives outside the persistence boundary). */
  async resetForRetry(id: string): Promise<boolean> {
    const changed = await this.knex("jots")
      .where({ id })
      .whereNotIn("status", ["processing", "deleted"])
      .update(this.pendingReset());
    const won = changed > 0;
    log.debug({ id, won }, "retry reset attempt");
    return won;
  }

  /** Terminal state for a jot whose journal line the user removed. Distinct from
   *  `abandoned` so /retry --abandoned never resurrects a deliberate deletion. */
  async markDeleted(id: string): Promise<void> {
    await this.updateJot(id, { status: "deleted" });
  }

  async tilOffered(jotId: string): Promise<boolean> {
    const row = await this.knex("jots")
      .where({ id: jotId })
      .first("til_offered");
    return Boolean(row?.til_offered);
  }

  async markTilOffered(jotId: string): Promise<void> {
    await this.knex("jots").where({ id: jotId }).update({ til_offered: true });
    log.debug({ id: jotId }, "til offered");
  }
}
