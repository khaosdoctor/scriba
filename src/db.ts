import knexLib, { type Knex } from "knex";
import { logger } from "./log.ts";

const log = logger("db");

export type JotKind = "text" | "audio" | "image" | "video";
export type JotStatus =
  | "pending"     // placeholder written, awaiting processing
  | "processing"  // claimed by a worker (atomic) — in flight
  | "done"        // enriched + written
  | "failed"      // last attempt failed; retried until attempts hit the cap
  | "abandoned";  // gave up (cap or unrecoverable); posted un-enriched

export const MAX_ATTEMPTS = 10;

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
    if (done.length) log.info({ batch, count: done.length }, "migrations applied");
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
    await this.k("jots").where({ id }).update({ ...patch, updated_at: Date.now() });
    log.debug({ id, ...patch }, "jot updated");
  }
  /**
   * Atomically claim a jot for processing. Returns true only for the caller that won
   * the transition pending|failed -> processing, so flush and retry sweeps can't
   * double-process the same jot.
   */
  async claim(id: string): Promise<boolean> {
    const n = await this.k("jots").where({ id }).whereIn("status", ["pending", "failed"])
      .update({ status: "processing", updated_at: Date.now() });
    const won = n > 0;
    log.debug({ id, won }, "claim attempt");
    return won;
  }
  /** Crash recovery: any jot stuck in `processing` from a previous run goes back to pending. */
  async resetProcessing(): Promise<number> {
    return this.k("jots").where({ status: "processing" })
      .update({ status: "pending", updated_at: Date.now() });
  }
  /** Jots eligible for (re)processing: fresh, or failed but under the retry cap. */
  async pendingJots(): Promise<Jot[]> {
    return this.k<Jot>("jots")
      .where({ status: "pending" })
      .orWhere((q) => q.where({ status: "failed" }).andWhere("attempts", "<", MAX_ATTEMPTS))
      .orderBy("received_at");
  }

  // --- telegram message → jot map (reply-to-edit) ---
  async mapMessage(tgMessageId: number, jotId: string): Promise<void> {
    await this.k("msg_map").insert({ tg_message_id: tgMessageId, jot_id: jotId })
      .onConflict("tg_message_id").merge();
  }
  async jotForMessage(tgMessageId: number): Promise<string | undefined> {
    const r = await this.k("msg_map").where({ tg_message_id: tgMessageId }).first();
    return r?.jot_id;
  }
  async messageForJot(jotId: string): Promise<number | undefined> {
    const r = await this.k("msg_map").where({ jot_id: jotId }).first();
    return r?.tg_message_id;
  }

  // --- learned link rejections ---
  async rejections(): Promise<Set<string>> {
    const rows = await this.k("rejections").select("surface", "note");
    return new Set(rows.map((r) => `${r.surface} ${r.note}`)); // surface stored lowercased
  }
  async reject(surface: string, note: string): Promise<void> {
    await this.k("rejections")
      .insert({ surface: surface.toLowerCase(), note, created_at: Date.now() })
      .onConflict(["surface", "note"]).ignore();
  }

  // --- stopwords (editable in DB) ---
  async stopwords(): Promise<Set<string>> {
    const rows = await this.k("stopwords").select("word");
    return new Set(rows.map((r) => String(r.word).toLowerCase()));
  }

  // --- pending ambiguous-link questions ---
  async addPendingLink(id: string, jotId: string, surface: string, note: string): Promise<void> {
    await this.k("pending_links").insert({ id, jot_id: jotId, surface, note, created_at: Date.now() });
  }
  /** Atomic take: only one of two fast button taps gets the row. */
  async takePendingLink(id: string): Promise<{ jot_id: string; surface: string; note: string } | undefined> {
    return this.k.transaction(async (trx) => {
      const row = await trx("pending_links").where({ id }).first();
      if (!row) return undefined;
      await trx("pending_links").where({ id }).del();
      return { jot_id: row.jot_id, surface: row.surface, note: row.note };
    });
  }

  // --- edits queued while a jot was still processing ---
  async queueEdit(jotId: string, instruction: string): Promise<void> {
    await this.k("queued_edits").insert({ jot_id: jotId, instruction, created_at: Date.now() });
  }
  async takeQueuedEdits(jotId: string): Promise<string[]> {
    return this.k.transaction(async (trx) => {
      const rows = await trx("queued_edits").where({ jot_id: jotId }).orderBy("created_at");
      if (rows.length) await trx("queued_edits").where({ jot_id: jotId }).del();
      return rows.map((r) => r.instruction as string);
    });
  }

  // --- daily ratings (write-once gate) ---
  /** Atomically claim a day's rating. Returns `recorded: false` with the existing value
   *  if the day is already rated, so a double-tap or a second prompt can't overwrite it. */
  async recordRating(date: string, rating: number): Promise<{ recorded: boolean; current: number }> {
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

  /** Jot counts for the daily summary over a [from,to) epoch-ms window. */
  async dayStats(from: number, to: number): Promise<{ jots: number; audio: number; failed: number }> {
    const row = await this.k("jots")
      .where("received_at", ">=", from).andWhere("received_at", "<", to)
      .select(
        this.k.raw("COUNT(*) as jots"),
        this.k.raw("SUM(CASE WHEN kind='audio' THEN 1 ELSE 0 END) as audio"),
        this.k.raw("SUM(CASE WHEN status IN ('failed','abandoned') THEN 1 ELSE 0 END) as failed"),
      ).first();
    return { jots: Number(row?.jots ?? 0), audio: Number(row?.audio ?? 0), failed: Number(row?.failed ?? 0) };
  }

  async close(): Promise<void> {
    await this.k.destroy();
  }
}
