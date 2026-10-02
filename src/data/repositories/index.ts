import type { Knex } from "knex";
import { openDb } from "../connections/sqlite.ts";
import { JotRepository } from "./jots.ts";
import { LinkRuleRepository } from "./link-rules.ts";
import { RatingRepository } from "./ratings.ts";
import { SettingsRepository } from "./settings.ts";
import { TaskDraftRepository } from "./task-drafts.ts";

export class Repository {
  private constructor(
    private knex: Knex,
    readonly jots: JotRepository,
    readonly linkRules: LinkRuleRepository,
    readonly settings: SettingsRepository,
    readonly taskDrafts: TaskDraftRepository,
    readonly ratings: RatingRepository,
  ) {}

  static async open(dbPath: string): Promise<Repository> {
    const knex = await openDb(dbPath);
    return new Repository(
      knex,
      new JotRepository(knex),
      new LinkRuleRepository(knex),
      new SettingsRepository(knex),
      new TaskDraftRepository(knex),
      new RatingRepository(knex),
    );
  }

  async close(): Promise<void> {
    await this.knex.destroy();
  }
}
