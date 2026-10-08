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
    original_transcript: null,
    parent_id: null,
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

type Skippable = { skip: (why: string) => void };
type Closable =
  | { close: () => Promise<void> }
  | { destroy: () => Promise<void> };

/**
 * Opens a native-sqlite handle (a Knex or a Repository) on a temp file, or skips the test
 * when the addon cannot load. `close` is for the caller to run once the test is over.
 */
export async function openNative<Handle extends Closable>(
  testContext: Skippable,
  open: (dbPath: string) => Promise<Handle>,
  { ignoreCloseErrors = false } = {},
) {
  const dbPath = tempDbPath();
  try {
    const handle = await open(dbPath);
    const close = async () => {
      try {
        const closing = "close" in handle ? handle.close() : handle.destroy();
        await (ignoreCloseErrors ? closing.catch(() => {}) : closing);
      } finally {
        await removeDb(dbPath);
      }
    };
    return { handle, dbPath, close };
  } catch (error) {
    await removeDb(dbPath);
    testContext.skip(
      `native sqlite unavailable: ${(error as Error).message.slice(0, 80)}`,
    );
    return null;
  }
}

export async function withNative<Handle extends Closable>(
  testContext: Skippable,
  open: (dbPath: string) => Promise<Handle>,
  fn: (handle: Handle, dbPath: string) => Promise<void>,
  options?: { ignoreCloseErrors?: boolean },
): Promise<void> {
  const native = await openNative(testContext, open, options);
  if (!native) return;
  try {
    await fn(native.handle, native.dbPath);
  } finally {
    await native.close();
  }
}

export const withDb = (
  testContext: Skippable,
  fn: (knex: Knex) => Promise<void>,
) => withNative(testContext, openDb, fn);
