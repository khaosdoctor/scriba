import type { Knex } from "knex";
import {
  type LinkRule,
  linkRuleKey,
  type PendingLink,
} from "../../domain/link-rule/entity.ts";

export class LinkRuleRepository {
  constructor(private knex: Knex) {}

  async rejections(): Promise<Set<string>> {
    const rows = await this.rejectionList();
    return new Set(rows.map((row) => linkRuleKey(row.surface, row.note))); // surface stored lowercased
  }
  async reject(surface: string, note: string): Promise<void> {
    await this.knex("rejections")
      .insert({ surface: surface.toLowerCase(), note, created_at: Date.now() })
      .onConflict(["surface", "note"])
      .ignore();
  }

  /** Stopwords as a deterministically ordered list, so the link-rules wizard can index
   *  into it by row position and re-derive the same order on the next tap. */
  async stopwordList(): Promise<string[]> {
    const rows = await this.knex("stopwords").select("word").orderBy("word");
    return rows.map((row) => String(row.word));
  }
  async stopwords(): Promise<Set<string>> {
    const words = await this.stopwordList();
    return new Set(words.map((word) => word.toLowerCase()));
  }

  async registeredLinks(): Promise<LinkRule[]> {
    // Ordered by (surface, note) so an interactive picker (mirroring /unreject's) can
    // index into this list by position and re-derive the same order on each tap.
    return this.knex("registered_links")
      .select("surface", "note")
      .orderBy(["surface", "note"]);
  }
  async addRegisteredLink(surface: string, note: string): Promise<void> {
    await this.knex("registered_links")
      .insert({
        surface: surface.trim().toLowerCase(),
        note: note.trim(),
        created_at: Date.now(),
      })
      .onConflict(["surface", "note"])
      .ignore();
  }
  async delRegisteredLink(surface: string, note: string): Promise<number> {
    return this.knex("registered_links")
      .where({ surface: surface.trim().toLowerCase(), note: note.trim() })
      .del();
  }

  async addPendingLink(
    id: string,
    jotId: string,
    surface: string,
    note: string,
  ): Promise<void> {
    await this.knex("pending_links").insert({
      id,
      jot_id: jotId,
      surface,
      note,
      created_at: Date.now(),
    });
  }
  /** Atomic take: only one of two fast button taps gets the row. */
  async takePendingLink(id: string): Promise<PendingLink | undefined> {
    return this.knex.transaction(async (trx) => {
      const row = await trx("pending_links").where({ id }).first();
      if (!row) return undefined;
      await trx("pending_links").where({ id }).del();
      return { jot_id: row.jot_id, surface: row.surface, note: row.note };
    });
  }

  async addStopword(word: string): Promise<void> {
    await this.knex("stopwords")
      .insert({ word: word.toLowerCase() })
      .onConflict("word")
      .ignore();
  }
  async delStopword(word: string): Promise<number> {
    return this.knex("stopwords").where({ word: word.toLowerCase() }).del();
  }

  async rejectionList(): Promise<LinkRule[]> {
    // Ordered by (surface, note) so the interactive /unreject menu can index into
    // this list by position and re-derive the same order on each button tap.
    return this.knex("rejections")
      .select("surface", "note")
      .orderBy(["surface", "note"]);
  }
  async unreject(surface: string, note: string): Promise<number> {
    return this.knex("rejections")
      .where({ surface: surface.toLowerCase(), note })
      .del();
  }
}
