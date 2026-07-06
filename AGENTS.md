# AGENTS.md

Operating notes for AI agents working on scriba.

## What this is

A Telegram → Obsidian journaling bot. Text and voice notes become enriched journal
lines in the Obsidian daily note. Runs as one Node/TS process on the homelab (Coolify).

## Ground rules

- **Persistence is boundaried.** ALL SQL/knex lives in `Repository` (`src/db.ts`). Do
  not write queries anywhere else — add a method to `Repository` instead.
- **OOP.** Each system block is a class (see the table in `README.md`). Keep collaborators
  injected via constructors; wiring happens only in `src/index.ts`.
- **Pure logic in `core.ts`.** Anything deterministic and token-free (formatting, anchor
  replacement, candidate filtering, edit parsing) goes there and gets a test in
  `core.test.ts`. No network, no side effects in `core.ts`.
- **No tokens for control flow.** Batch timing, language routing, and candidate filtering
  must not call the model. The agent is only for enrichment/translation and freeform edits.
- **Vault is English.** Non-English text/voice is translated on the way in (Groq
  translations for voice, the enricher for text).
- **Four jot kinds.** `text` and `audio` carry enrichable text (audio is transcribed).
  `image` and `video` are attach-only: saved to the assets folder and embedded with the
  caption as display. An `image` with no caption gets one from vision; otherwise no
  agent call for attachments. Video is never transcribed.

## Data model

- Jots carry a fixed 8-char hex `id`, also used as the Obsidian block anchor (`^<id>`).
- A jot is written as a placeholder the instant it arrives, then replaced in place by its
  anchor once processed. Ordering is fixed at arrival — never reordered.
- Stopwords and learned link rejections live in the DB, not in code.

## Conventions

- Conventional Commits. No gitmoji. No AI attribution in commits or PRs.
- Elastic License 2.0.
- Migrations are knex files under `migrations/`; the app runs `migrate.latest()` at boot.

## Local checks

```sh
npm test          # core logic
npm run typecheck
```
