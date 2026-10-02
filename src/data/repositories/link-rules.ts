import type { Knex } from "knex";
import type { LinkRule, PendingLink } from "../../domain/link-rule/entity.ts";

export class LinkRuleRepository {
  constructor(private k: Knex) {}

  async rejections(): Promise<Set<string>> {
    const rows = await this.rejectionList();
    return new Set(rows.map((r) => `${r.surface} ${r.note}`)); // surface stored lowercased
  }
  async reject(surface: string, note: string): Promise<void> {
    await this.k("rejections")
      .insert({ surface: surface.toLowerCase(), note, created_at: Date.now() })
      .onConflict(["surface", "note"])
      .ignore();
  }

  /** Stopwords as a deterministically ordered list, so the link-rules wizard can index
   *  into it by row position and re-derive the same order on the next tap. */
  async stopwordList(): Promise<string[]> {
    const rows = await this.k("stopwords").select("word").orderBy("word");
    return rows.map((r) => String(r.word));
  }
  async stopwords(): Promise<Set<string>> {
    const words = await this.stopwordList();
    return new Set(words.map((w) => w.toLowerCase()));
  }

  /** Registered links: user-curated surface->note pairs that always force a link (the
   *  opposite of a rejection). Read as a list, not a set, since forcedCandidates needs
   *  the note target per surface, not just membership. */
  async registeredLinks(): Promise<LinkRule[]> {
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
  async takePendingLink(id: string): Promise<PendingLink | undefined> {
    return this.k.transaction(async (trx) => {
      const row = await trx("pending_links").where({ id }).first();
      if (!row) return undefined;
      await trx("pending_links").where({ id }).del();
      return { jot_id: row.jot_id, surface: row.surface, note: row.note };
    });
  }

  async addStopword(word: string): Promise<void> {
    await this.k("stopwords")
      .insert({ word: word.toLowerCase() })
      .onConflict("word")
      .ignore();
  }
  async delStopword(word: string): Promise<number> {
    return this.k("stopwords").where({ word: word.toLowerCase() }).del();
  }

  async rejectionList(): Promise<LinkRule[]> {
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
}
