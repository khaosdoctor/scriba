import type { Knex } from "knex";
import type { Jot, JotSection } from "../domain/jot/entity.ts";
import type { Stats, StatusCounts } from "../domain/jot/structures.ts";
import type { LinkRule, PendingLink } from "../domain/link-rule/entity.ts";
import type {
  SettingKey,
  SettingValue,
  SwitchKey,
} from "../domain/setting/entity.ts";
import type { TaskDraftRow } from "../domain/task/entity.ts";
import { openDb } from "./db.ts";
import { JotRepository } from "./jots.ts";
import { LinkRuleRepository } from "./link-rules.ts";
import { RatingRepository } from "./ratings.ts";
import { SettingsRepository } from "./settings.ts";
import { TaskDraftRepository } from "./task-drafts.ts";

export class Repository {
  private constructor(
    private k: Knex,
    private jots: JotRepository,
    private linkRules: LinkRuleRepository,
    private settings: SettingsRepository,
    private taskDrafts: TaskDraftRepository,
    private ratings: RatingRepository,
  ) {}

  static async open(dbPath: string): Promise<Repository> {
    const k = await openDb(dbPath);
    return new Repository(
      k,
      new JotRepository(k),
      new LinkRuleRepository(k),
      new SettingsRepository(k),
      new TaskDraftRepository(k),
      new RatingRepository(k),
    );
  }

  async insertJot(j: Jot): Promise<void> {
    return this.jots.insertJot(j);
  }
  async getJot(id: string): Promise<Jot | undefined> {
    return this.jots.getJot(id);
  }
  async updateJot(id: string, patch: Partial<Jot>): Promise<void> {
    return this.jots.updateJot(id, patch);
  }
  async claim(id: string): Promise<boolean> {
    return this.jots.claim(id);
  }
  async resetProcessing(): Promise<number> {
    return this.jots.resetProcessing();
  }
  async lastPendingEnrichableJot(
    notePath: string,
    section: JotSection,
  ): Promise<Jot | undefined> {
    return this.jots.lastPendingEnrichableJot(notePath, section);
  }
  async unsquash(id: string): Promise<boolean> {
    return this.jots.unsquash(id);
  }
  async groupFollowers(leaderId: string): Promise<Jot[]> {
    return this.jots.groupFollowers(leaderId);
  }
  async pendingJots(): Promise<Jot[]> {
    return this.jots.pendingJots();
  }
  async mapMessage(tgMessageId: number, jotId: string): Promise<void> {
    return this.jots.mapMessage(tgMessageId, jotId);
  }
  async jotForMessage(tgMessageId: number): Promise<string | undefined> {
    return this.jots.jotForMessage(tgMessageId);
  }
  async messageForJot(jotId: string): Promise<number | undefined> {
    return this.jots.messageForJot(jotId);
  }
  async unmapMessage(tgMessageId: number): Promise<void> {
    return this.jots.unmapMessage(tgMessageId);
  }
  async rejections(): Promise<Set<string>> {
    return this.linkRules.rejections();
  }
  async reject(surface: string, note: string): Promise<void> {
    return this.linkRules.reject(surface, note);
  }
  async stopwordList(): Promise<string[]> {
    return this.linkRules.stopwordList();
  }
  async stopwords(): Promise<Set<string>> {
    return this.linkRules.stopwords();
  }
  async registeredLinks(): Promise<LinkRule[]> {
    return this.linkRules.registeredLinks();
  }
  async addRegisteredLink(surface: string, note: string): Promise<void> {
    return this.linkRules.addRegisteredLink(surface, note);
  }
  async delRegisteredLink(surface: string, note: string): Promise<number> {
    return this.linkRules.delRegisteredLink(surface, note);
  }
  async addPendingLink(
    id: string,
    jotId: string,
    surface: string,
    note: string,
  ): Promise<void> {
    return this.linkRules.addPendingLink(id, jotId, surface, note);
  }
  async takePendingLink(id: string): Promise<PendingLink | undefined> {
    return this.linkRules.takePendingLink(id);
  }
  async queueEdit(jotId: string, instruction: string): Promise<void> {
    return this.jots.queueEdit(jotId, instruction);
  }
  async queuedEdits(jotId: string): Promise<string[]> {
    return this.jots.queuedEdits(jotId);
  }
  async clearQueuedEdits(jotId: string): Promise<void> {
    return this.jots.clearQueuedEdits(jotId);
  }
  async recordRating(
    date: string,
    rating: number,
  ): Promise<{ recorded: boolean; current: number }> {
    return this.ratings.recordRating(date, rating);
  }
  async clearRating(date: string): Promise<void> {
    return this.ratings.clearRating(date);
  }
  async windowStats(from: number, to: number): Promise<Stats> {
    return this.jots.windowStats(from, to);
  }
  async statusCounts(): Promise<StatusCounts> {
    return this.jots.statusCounts();
  }
  async failedJots(limit = 10): Promise<Jot[]> {
    return this.jots.failedJots(limit);
  }
  async recentJots(limit = 10): Promise<Jot[]> {
    return this.jots.recentJots(limit);
  }
  async jotsInRange(
    from: number,
    to: number,
  ): Promise<Pick<Jot, "id" | "anchor">[]> {
    return this.jots.jotsInRange(from, to);
  }
  async jotsPage(offset: number, limit: number): Promise<Jot[]> {
    return this.jots.jotsPage(offset, limit);
  }
  async resetForReprocess(ids: string[]): Promise<string[]> {
    return this.jots.resetForReprocess(ids);
  }
  async resetFailed(includeAbandoned: boolean): Promise<number> {
    return this.jots.resetFailed(includeAbandoned);
  }
  async resetForRetry(id: string): Promise<void> {
    return this.jots.resetForRetry(id);
  }
  async markDeleted(id: string): Promise<void> {
    return this.jots.markDeleted(id);
  }
  async addStopword(word: string): Promise<void> {
    return this.linkRules.addStopword(word);
  }
  async delStopword(word: string): Promise<number> {
    return this.linkRules.delStopword(word);
  }
  async rejectionList(): Promise<LinkRule[]> {
    return this.linkRules.rejectionList();
  }
  async unreject(surface: string, note: string): Promise<number> {
    return this.linkRules.unreject(surface, note);
  }
  async insertTaskDraft(d: TaskDraftRow): Promise<void> {
    return this.taskDrafts.insertTaskDraft(d);
  }
  async getTaskDraft(id: string): Promise<TaskDraftRow | undefined> {
    return this.taskDrafts.getTaskDraft(id);
  }
  async updateTaskDraft(
    id: string,
    patch: Partial<TaskDraftRow>,
  ): Promise<void> {
    return this.taskDrafts.updateTaskDraft(id, patch);
  }
  async claimTaskDraft(id: string): Promise<boolean> {
    return this.taskDrafts.claimTaskDraft(id);
  }
  async taskDraftsForJot(jotId: string): Promise<number> {
    return this.taskDrafts.taskDraftsForJot(jotId);
  }
  async tilOffered(jotId: string): Promise<boolean> {
    return this.jots.tilOffered(jotId);
  }
  async markTilOffered(jotId: string): Promise<void> {
    return this.jots.markTilOffered(jotId);
  }
  async getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    return this.settings.get(key);
  }
  async setSetting(key: SettingKey, value: string): Promise<void> {
    return this.settings.set(key, value);
  }
  async toggleSetting(key: SwitchKey): Promise<boolean> {
    return this.settings.toggle(key);
  }
  async seedSettings(
    defaults: Partial<Record<SettingKey, string>>,
  ): Promise<void> {
    return this.settings.seedDefaults(defaults);
  }
  async ratingTime(fallback: string): Promise<string> {
    return this.settings.ratingTime(fallback);
  }

  async close(): Promise<void> {
    await this.k.destroy();
  }
}
