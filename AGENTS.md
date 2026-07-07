# AGENTS.md

Operating manual for AI agents working on scriba. `CLAUDE.md` symlinks to this file.
For the full state-of-the-world writeup, read [HANDOFF.md](./HANDOFF.md).

## What this is

A Telegram → Obsidian journaling bot. Text/voice/image/video become enriched journal
lines in the Obsidian daily note. One Node/TS process, run via **tsx** (`node --import tsx`),
deployed on the homelab (Coolify). Single user.

## Ground rules

- **Persistence is boundaried.** ALL SQL/knex lives in `Repository` (`src/db.ts`). Do not
  write queries anywhere else — add a `Repository` method instead.
- **OOP.** Each system block is a class (see the table in HANDOFF.md). Collaborators are
  injected via constructors; wiring happens only in `src/index.ts`.
- **Pure logic in `core.ts`.** Deterministic, token-free helpers (formatting, anchor
  replacement, candidate filtering, edit parsing) live there with tests in `core.test.ts`.
  No network or side effects in `core.ts`.
- **No tokens for control flow.** Batch timing, retry classification, candidate filtering,
  language routing must not call the model. The agent is only for enrichment, translation,
  image captioning, and freeform edits.
- **Vault is English.** Voice is transcribed by the local Parakeet sidecar (default) or
  Groq (`TRANSCRIBER=remote`); non-English is translated in (Groq `/translations`, or the
  enricher for local voice + all text).
- **Four jot kinds.** `text`/`audio` carry enrichable text (audio is transcribed).
  `image`/`video` are attach-only (saved + embedded, caption as display); a captionless
  image gets a vision caption. Video is never transcribed.

## Data / flow (essentials — full detail in HANDOFF.md)

- 8-char hex jot `id`, also the Obsidian block anchor `^<id>`.
- A placeholder line is written the instant a jot arrives; ordering is fixed at arrival and
  never reshuffled. Processing replaces the line in place by its anchor.
- Jot status: `pending → processing → done` (or `failed` → retry, or `abandoned` on
  give-up). `processing` is claimed atomically so flush + sweeps never double-process.
- Stopwords and learned link-rejections live in the DB, not in code.

## Conventions

- Conventional Commits. No gitmoji. No AI attribution in commits or PRs.
- Elastic License 2.0.
- Migrations are knex files under `migrations/`; the app runs `migrate.latest()` at boot.
- Run TypeScript via tsx — do NOT rely on Node's strip-only mode (it can't do parameter
  properties, which the classes use).

## Local checks

```sh
npm install       # needs a Node where better-sqlite3 builds; the DB test self-skips otherwise
npm test          # node --import tsx --test
npm run typecheck # tsc --noEmit
```

> The maintainer's local Node (26) can't build better-sqlite3's native addon; the DB
> roundtrip test self-skips there and runs in Docker/Node 24. Everything else runs locally.
