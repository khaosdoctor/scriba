import knexLib, { type Knex } from "knex";

export type JotKind = "text" | "audio" | "image" | "video";
export type JotStatus = "pending" | "done" | "needs_input" | "failed";

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

export interface Metrics {
  agent_calls: number;
  agent_input_tokens: number;
  agent_output_tokens: number;
  groq_calls: number;
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
    await k.migrate.latest();
    return new Repository(k);
  }

  // --- jots ---
  async insertJot(j: Jot): Promise<void> {
    await this.k("jots").insert(j);
  }
  async getJot(id: string): Promise<Jot | undefined> {
    return this.k<Jot>("jots").where({ id }).first();
  }
  async updateJot(id: string, patch: Partial<Jot>): Promise<void> {
    await this.k("jots").where({ id }).update({ ...patch, updated_at: Date.now() });
  }
  /** Jots still needing work — awaiting first processing or a forever-retry. */
  async pendingJots(): Promise<Jot[]> {
    return this.k<Jot>("jots").whereIn("status", ["pending", "failed"]).orderBy("received_at");
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
  async takePendingLink(id: string): Promise<{ jot_id: string; surface: string; note: string } | undefined> {
    const row = await this.k("pending_links").where({ id }).first();
    if (row) await this.k("pending_links").where({ id }).del();
    return row ? { jot_id: row.jot_id, surface: row.surface, note: row.note } : undefined;
  }

  // --- daily metrics ---
  async bumpMetrics(day: string, patch: Partial<Metrics>): Promise<void> {
    await this.k("metrics").insert({ day }).onConflict("day").ignore();
    const inc: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(patch)) if (v) inc[key] = this.k.raw("?? + ?", [key, v]);
    if (Object.keys(inc).length) await this.k("metrics").where({ day }).update(inc);
  }
  async getMetrics(day: string): Promise<Metrics> {
    return (await this.k("metrics").where({ day }).first())
      ?? { agent_calls: 0, agent_input_tokens: 0, agent_output_tokens: 0, groq_calls: 0 };
  }
  /** Jot counts for the daily summary over a [from,to) epoch-ms window. */
  async dayStats(from: number, to: number): Promise<{ jots: number; audio: number; failed: number }> {
    const row = await this.k("jots")
      .where("received_at", ">=", from).andWhere("received_at", "<", to)
      .select(
        this.k.raw("COUNT(*) as jots"),
        this.k.raw("SUM(CASE WHEN kind='audio' THEN 1 ELSE 0 END) as audio"),
        this.k.raw("SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed"),
      ).first();
    return { jots: Number(row?.jots ?? 0), audio: Number(row?.audio ?? 0), failed: Number(row?.failed ?? 0) };
  }

  async close(): Promise<void> {
    await this.k.destroy();
  }
}
