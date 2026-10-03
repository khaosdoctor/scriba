import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Knex } from "knex";
import { openDb } from "../data/connections/sqlite.ts";
import type { Jot } from "../domain/jot/entity.ts";
import type { TaskDraftRow } from "../domain/task/entity.ts";

export function sampleJot(id: string, over: Partial<Jot> = {}): Jot {
  const now = Date.now();
  return {
    id,
    kind: "text",
    note_path: "notes/daily notes/2026-07-06.md",
    anchor: id,
    time: "10:00:00",
    raw_text: "hi",
    transcript: null,
    proposed_text: null,
    section: "journal",
    asset_path: null,
    file_id: null,
    status: "pending",
    attempts: 0,
    error: null,
    received_at: now,
    updated_at: now,
    ...over,
  };
}

export function sampleTaskDraft(
  id: string,
  over: Partial<TaskDraftRow> = {},
): TaskDraftRow {
  const now = Date.now();
  return {
    id,
    source: "mode",
    jot_id: null,
    type: "personal",
    description: "Buy cat sand",
    start: null,
    due: "2026-09-02",
    source_date: "2026-08-16",
    status: "pending",
    chat_id: 1,
    message_id: 50,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

export const tempDbPath = () =>
  join(tmpdir(), `scriba-test-${randomBytes(6).toString("hex")}.db`);

export async function removeDb(dbPath: string): Promise<void> {
  for (const suffix of ["", "-shm", "-wal"])
    await rm(`${dbPath}${suffix}`, { force: true });
}

export async function withDb(
  t: { skip: (why: string) => void },
  fn: (k: Knex) => Promise<void>,
): Promise<void> {
  const dbPath = tempDbPath();
  let k: Knex;
  try {
    k = await openDb(dbPath);
  } catch (e) {
    return t.skip(
      `native sqlite unavailable: ${(e as Error).message.slice(0, 80)}`,
    );
  }
  try {
    await fn(k);
  } finally {
    await k.destroy();
    await removeDb(dbPath);
  }
}
