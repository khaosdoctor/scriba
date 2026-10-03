import type { Knex } from "knex";
import type { TaskDraftRow } from "../../domain/task/entity.ts";
import { logger } from "../../libs/log.ts";

const log = logger("db");

export class TaskDraftRepository {
  constructor(private knex: Knex) {}

  async insertTaskDraft(draft: TaskDraftRow): Promise<void> {
    await this.knex("task_drafts").insert(draft);
    log.debug(
      { id: draft.id, source: draft.source, type: draft.type },
      "task draft inserted",
    );
  }
  async getTaskDraft(id: string): Promise<TaskDraftRow | undefined> {
    return this.knex<TaskDraftRow>("task_drafts").where({ id }).first();
  }
  async updateTaskDraft(
    id: string,
    patch: Partial<TaskDraftRow>,
  ): Promise<void> {
    await this.knex("task_drafts")
      .where({ id })
      .update({ ...patch, updated_at: Date.now() });
    log.debug({ id, ...patch }, "task draft updated");
  }
  /** Atomically claim a draft for creation, the same compare-and-swap `claim()` uses for
   *  jots. Only the tap that wins moves it `pending → created`, so a double-tapped ✅ can't
   *  write the same task into the note twice. Returns false when it was already settled. */
  async claimTaskDraft(id: string): Promise<boolean> {
    const changed = await this.knex("task_drafts")
      .where({ id, status: "pending" })
      .update({ status: "created", updated_at: Date.now() });
    const won = changed > 0;
    log.debug({ id, won }, "task draft claim attempt");
    return won;
  }

  /** How many drafts a jot has already produced. Non-zero means its tasks were proposed
   *  once and answered (created, or dismissed), so a later /reprocess of that jot must
   *  not ask about them all over again. */
  async taskDraftsForJot(jotId: string): Promise<number> {
    const row = await this.knex("task_drafts")
      .where({ jot_id: jotId })
      .count("* as n")
      .first();
    return Number(row!.n);
  }
}
