import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Knex } from "knex";
import type { Jot } from "../models/domain.ts";
import { openDb } from "../repositories/db.ts";

export function sampleJot(id: string): Jot {
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
  };
}

export async function withDb(
  t: { skip: (why: string) => void },
  fn: (k: Knex) => Promise<void>,
): Promise<void> {
  const dbPath = join(
    tmpdir(),
    `scriba-test-${randomBytes(6).toString("hex")}.db`,
  );
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
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
  }
}
