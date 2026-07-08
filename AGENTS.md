# AGENTS.md

Operating manual for AI agents working on scriba. `CLAUDE.md` symlinks to this file.

## What this is

A Telegram → Obsidian journaling bot. Text/voice/image/video become enriched journal
lines in the Obsidian daily note. One Node/TS process, run via **tsx** (`node --import tsx`),
deployed on the homelab (Coolify). Single user.

## Ground rules

- **Persistence is boundaried.** ALL SQL/knex lives in `Repository` (`src/db.ts`). Do not
  write queries anywhere else — add a `Repository` method instead.
- **OOP.** Each system block is a class. Collaborators are
  injected via constructors; wiring happens only in `src/index.ts`.
- **Pure logic in `core.ts`.** Deterministic, token-free helpers (formatting, anchor
  replacement, candidate filtering, edit parsing) live there with tests in `core.test.ts`.
  No network or side effects in `core.ts`.
- **Admin commands are one-per-file in `src/commands/`.** Each exports a `Command`
  (`{ name, description, run }`); the registry in `src/commands/index.ts` is looped over in
  `bot.ts`. Command bodies stay thin: parse args, call `Repository`/services, and format via
  `core.ts`. Runtime settings that must survive a restart go in the `settings` key/value table.
- **No tokens for control flow.** Batch timing, retry classification, candidate filtering,
  language routing must not call the model. The agent is only for enrichment, translation,
  image captioning, and freeform edits.
- **Vault is English.** Voice is transcribed by the local Parakeet sidecar (default) or
  Groq (`TRANSCRIBER=remote`); non-English is translated in (Groq `/translations`, or the
  enricher for local voice + all text).
- **Four jot kinds.** `text`/`audio` carry enrichable text (audio is transcribed).
  `image`/`video` are attach-only (saved + embedded, caption as display); a captionless
  image gets a vision caption. Video is never transcribed.

## Data / flow

- 8-char hex jot `id`, also the Obsidian block anchor `^<id>`.
- A placeholder line is written the instant a jot arrives; ordering is fixed at arrival and
  never reshuffled. Processing replaces the line in place by its anchor.
- **Squash bursts.** A text/voice jot arriving within `SQUASH_WINDOW_MS` (default 15s,
  rolling gap from the previous still-pending text/voice jot in the same note) folds into
  that jot's line: it reuses the leader's `anchor`, writes no placeholder of its own, and
  the processor enriches the whole run into one line (leader + followers share an anchor).
  The rolling-gap decision is token-free (`withinSquashWindow` in `core.ts`). Attach-only
  kinds (image/video) never squash. `SQUASH_WINDOW_MS=0` disables it.
- Jot status: `pending → processing → done` (or `failed` → retry, or `abandoned` on
  give-up). `processing` is claimed atomically so flush + sweeps never double-process.
- Stopwords and learned link-rejections live in the DB, not in code.

## Conventions

- Conventional Commits. No gitmoji. No AI attribution in commits or PRs.
- Elastic License 2.0.
- Migrations are knex files under `migrations/`; the app runs `migrate.latest()` at boot.
- Run TypeScript via tsx — do NOT rely on Node's strip-only mode (it can't do parameter
  properties, which the classes use).
- **Log thoroughly.** Every command, handler, and side-effecting method logs via the
  `logger("<scope>")` from `src/log.ts` — no bare `console`. Log the entry point and each
  branch that matters: `info` for normal milestones (command invoked, action taken),
  `warn` for rejected/invalid input, `error` (with `{ err }`) for failures, `debug` for
  raw payloads. A new command or feature without logs on its happy path AND its rejection
  paths is incomplete. Secrets are stripped in pino core via `redact` in `src/log.ts`
  (`*.token`/`*.key`/`*.groqApiKey`); log config objects freely, but add a path there if
  you introduce a secret with a different field name.
- **Slash commands are discoverable.** Any new `bot.command(...)` also gets an entry in
  `setMyCommands` (in `ScribaBot.start`) so it shows in Telegram's `/` menu.

## Local checks

```sh
npm install       # under Node 24 (pinned via mise.toml) better-sqlite3's addon builds
npm test          # node --import tsx --test — full suite incl. the DB roundtrip
npm run typecheck # tsc --noEmit
```

> `mise.toml` pins Node 24 (the deploy runtime), so the native addon builds and the whole
> suite runs locally. If an `allow-scripts` gate blocks the addon during install, run
> `npm rebuild better-sqlite3` once. The DB roundtrip test still self-skips on any Node
> where the addon can't build (e.g. an un-pinned Node 26).
