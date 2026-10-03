import type { Knex } from "knex";

export class RatingRepository {
  constructor(private knex: Knex) {}

  /** Atomically claim a day's rating. Returns `recorded: false` with the existing value
   *  if the day is already rated, so a double-tap or a second prompt can't overwrite it. */
  async recordRating(
    date: string,
    rating: number,
  ): Promise<{ recorded: boolean; current: number }> {
    return this.knex.transaction(async (trx) => {
      const row = await trx("ratings").where({ date }).first();
      if (row) return { recorded: false, current: Number(row.rating) };
      await trx("ratings").insert({ date, rating, created_at: Date.now() });
      return { recorded: true, current: rating };
    });
  }
  /** Release a claimed rating so it can be retried (used when the vault write fails). */
  async clearRating(date: string): Promise<void> {
    await this.knex("ratings").where({ date }).del();
  }
}
