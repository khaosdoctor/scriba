# scriba — Handoff

Everything an agent (or human) needs to pick up scriba cold. Pair with [AGENTS.md](./AGENTS.md)
(operating rules) and [README.md](./README.md) (user-facing overview).

---

## 1. Status

- **Working, typechecked, tested, pushed** to `github.com/khaosdoctor/scriba` (private).
- **Not yet deployed.** No live bot token / vault credentials wired.
- 28 tests (`npm test`), 27 pass + 1 self-skip (DB roundtrip skips where better-sqlite3
  can't build — e.g. Node 26; it runs on Node 24/Docker).
- Pending before production: env values (below), a deploy compose in the homelab repo, and
  a smoke test against a real bot + vault.

---

## 2. Run it

```sh
npm install                 # Node ≥24 recommended (better-sqlite3 native addon)
cp .env.example .env         # fill in (see §7)
npm run migrate              # apply DB schema (knex)
npm run dev                  # node --watch --import tsx src/index.ts
npm test                     # node --import tsx --test 'src/*.test.ts'
npm run typecheck            # tsc --noEmit (type-check only; app runs via tsx, no build)
```

Runtime is **tsx** (`node --import tsx src/index.ts`). We do NOT use Node's built-in
strip-only TS mode: it rejects parameter properties (`constructor(private x)`), which the
classes rely on, and Node removed the transform mode. Docker `CMD` uses tsx too.

---

## 3. Architecture

One process. Each block is a class; wiring is only in `src/index.ts`.

| Class | File | Responsibility |
|---|---|---|
| `Repository` | `db.ts` | The ONLY place SQL/knex lives. All persistence. |
| `ObsidianClient` | `obsidian.ts` | Local REST API: daily note create, journal append, note read/write, asset upload. |
| `Transcriber` (interface) | `transcribe.ts` | Voice → English text. `GroqTranscriber` (remote) / `ParakeetTranscriber` (local); `createTranscriber()` picks by config. |
| `Enricher` | `enrich.ts` | Claude Agent SDK: enrich+link+translate, vision image caption, freeform edit. |
| `LinkIndex` | `index-links.ts` | Vault title/alias index; incremental (mtime) + native fs.watch + periodic backstop. |
| `FlushQueue` | `queue.ts` | Adaptive batching (idle / size / max-wait timers). |
| `JotProcessor` | `processor.ts` | Per-jot pipeline: claim → media → enrich → write; retry/give-up. |
| `ScribaBot` | `bot.ts` | ALL Telegram wiring (long polling, intake, edits, buttons). Implements `BotServices`. |
| `Scheduler` | `scheduler.ts` | Nightly summary + capped retry sweep. |
| `core.ts` | `core.ts` | Pure, token-free helpers. Tested in `core.test.ts`. |

**Wiring order (index.ts)** — there's a deliberate cycle broken by a setter:
`Repository.open` → `resetProcessing()` → build `ObsidianClient`/`Transcriber`/`Enricher`/`LinkIndex` →
`ScribaBot` (needs repo/obsidian/enricher) → `JotProcessor` (needs the bot as `BotServices`) →
`FlushQueue` (onFlush = `processor.processBatch`) → `bot.setQueue(queue)` → `Scheduler.start()` →
`processor.retrySweep()` (recover leftovers) → health HTTP server → `bot.start()` (long polling).

`BotServices` (in `processor.ts`) is the interface the processor uses to reach the bot:
`notify`, `askLink`, `askRetry`, `downloadFile`, `onJotDone`.

---

## 4. Data model (SQLite via knex, WAL)

Migration: `migrations/20260706000000_init.js` (schema builder; `migrate.latest()` at boot).

- **jots** — `id`(8-char hex, PK, = anchor), `kind`(text|audio|image|video), `note_path`,
  `anchor`, `time`(HH:MM:SS), `raw_text`, `transcript`, `asset_path`, `file_id`, `status`,
  `attempts`, `error`, `received_at`, `updated_at`.
- **msg_map** — `tg_message_id → jot_id` (reply-to-edit resolution).
- **rejections** — `(surface, note)` links the user said "no" to; surface stored lowercased.
- **stopwords** — seeded EN+PT words; editable in DB (candidate filter reads them).
- **pending_links** — ambiguous link questions awaiting a button answer.
- **queued_edits** — edits that arrived while a jot was still processing.

**Jot status machine:**
```
pending ──claim──▶ processing ──success──▶ done
   ▲                    │
   │                    ├─recoverable err & attempts<10─▶ failed ──(retry sweep re-claims)
   └──resetProcessing───┘                                    │
      (boot recovery)                                         └─attempts=10 or unrecoverable─▶ abandoned
                                                                 (post un-enriched + Retry button)
```

`MAX_ATTEMPTS = 10` (in `db.ts`). `pendingJots()` = `pending` OR (`failed` AND attempts<10).

---

## 5. Control flow

**Intake (bot.ts `intake`)** — on any message: make id, resolve daily note (`ensureDailyNote`,
per-date mutex), append placeholder `- _HH:MM:SS ::_ ⏳ ^id` under `## Journal`, insert jot
(`pending`), map the Telegram message id, `queue.add(id)`.

**Adaptive flush (queue.ts)** — pure timers, no tokens. Flush when ANY fires: 30s idle since
last message, 8 queued, or 120s since the oldest. `onFlush → processor.processBatch`.

**Process (processor.ts `processJot`)** —
1. `repo.claim(id)` — atomic `UPDATE … WHERE status IN (pending,failed)`. Only the winner
   proceeds → flush and retry sweeps can't double-process.
2. `ensureMedia` — download file (audio/image/video); save asset; transcribe (audio only);
   vision-caption a captionless image.
3. Source text = transcript (audio) / raw_text (text) / "" (image,video attach-only).
4. If there's text: build link candidates (`core.candidates` with DB stopwords+rejections),
   call `enricher.enrich`, apply confident links inline, ask about ambiguous ones (buttons).
5. `composeLine` (text + `![[asset]]` / `![[asset|caption]]`) → `writeLine` replaces the
   placeholder by anchor (live read-modify-write; appends if the anchor is gone).
6. status `done`, then `bot.onJotDone(id)` applies any edits queued during processing.

**Failure (processor.ts `fail`)** — recoverable (timeout/network/429/5xx) & attempts<10 →
`failed` (retry later). Else give up: post the jot **un-enriched** (best-effort text/embed),
status `abandoned`, flush queued edits, send a message with a `🔄 Retry` button.

**Retry sweep (scheduler.ts)** — every 5 min, reentrancy-guarded, `processor.retrySweep()`
re-processes `pendingJots()`. Crash recovery: `resetProcessing()` at boot flips any stuck
`processing` back to `pending`.

**Edits (bot.ts)** — reply to a jot's message (or the bot's) → resolve via `msg_map`.
- If the line exists yet (`done`/`abandoned`) → apply now; else queue (`queued_edits`),
  applied by `onJotDone` after processing.
- `applyEdits` merges a batch: literal `s/old/new/` and `replace X with Y` swaps applied
  deterministically (free); all freeform instructions merged into ONE `editText` agent call;
  single write. `delete` removes the line. Never touches the time prefix or `^anchor`.

**Ambiguous links** — `enrich` returns confident links inline + an `ambiguous` list. Each
becomes a `pending_link` + a Yes/No Telegram button (`lk:y|n:<pid>`). "No" → stored in
`rejections` (never proposed again). "Yes" → insert the link into the line. Tokens: candidate
filtering is free; only the enrich call costs tokens.

**Link index (index-links.ts)** — reads the vault from a read-only FS mount (`SCRIBA_VAULT_HOST_PATH`).
`rebuild()` walks the tree but re-reads only files whose `mtime` changed (incremental).
`start()` also sets a native recursive `fs.watch` (inotify on Linux; verified working on
Node 26) → debounced rebuild on `.md` changes (ignores dotdirs/non-md), plus a 30-min
periodic rebuild as a backstop for dropped events. Empty if `SCRIBA_VAULT_HOST_PATH` unset.

**Transcription (transcribe.ts)** — `TRANSCRIBER=local` (default) → `ParakeetTranscriber`
POSTs multipart `file` to an OpenAI-compatible endpoint (default the bundled sidecar
`http://parakeet:5092/v1/audio/transcriptions`); transcribes in the source language and the
enricher translates downstream. `TRANSCRIBER=remote` → Groq `whisper-large-v3`
`/translations` (any language → English). Text enrichment always uses Claude regardless.

**Enrichment (enrich.ts)** — Claude Agent SDK `query()` on **subscription auth**
(`CLAUDE_CODE_OAUTH_TOKEN`, no API key), `maxTurns:1`, `allowedTools:[]` (prompt injection
can't reach tools). Asks for a JSON object; `extractJson` parses directly, tolerating a
```json fence, falling back to the outermost `{…}` span.

**Daily summary (scheduler.ts)** — at `SUMMARY_TIME` (default 23:30 local, via `time.ts`
`msUntilNext`), send jot count + voice count + failed/abandoned count. Silent on empty days.

---

## 6. Time

`time.ts` prefers the global `Temporal` API, falls back to `Date`; both honour `process.env.TZ`.
`plainDate`/`plainTime`/`msUntilNext`.

---

## 7. Config / env (`config.ts`, validated at boot)

| Var | Required | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | |
| `ALLOWED_TELEGRAM_USER_ID` | yes | single-user allowlist; everyone else ignored |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes (env, read by the SDK) | `claude setup-token` |
| `OBSIDIAN_API_KEY` | yes | Local REST API key |
| `OBSIDIAN_API_URL` | no | default `https://127.0.0.1:27124` (self-signed; TLS verify skipped) |
| `TRANSCRIBER` | no | `local` (default, Parakeet sidecar) or `remote` (Groq) — validated |
| `GROQ_API_KEY` | if remote | |
| `PARAKEET_URL` | no | local default → bundled sidecar |
| `SCRIBA_VAULT_HOST_PATH` | no | host vault path, mounted read-only at `/vault` for the link index; empty ⇒ no link proposals |
| `DB_PATH` | no | default `/data/scriba.db` |
| `DAILY_NOTES_DIR` / `DAILY_NOTE_TEMPLATE` / `JOURNAL_HEADING` / `ASSETS_DIR` | no | vault layout (defaults match the Default vault) |
| `SUMMARY_TIME` | no | default `23:30` |
| `FLUSH_IDLE_MS` / `FLUSH_MAX_BATCH` / `FLUSH_MAX_WAIT_MS` | no | 30000 / 8 / 120000 |
| `AGENT_MODEL` | no | override enrichment model |
| `PORT` | no | health endpoint only (long polling needs no inbound webhook) |
| `TZ` | no | local wall-clock for dates/summary |

---

## 8. Deploy

- **Long polling** — no public URL / webhook. The exposed `PORT` serves only `/health`.
- `docker-compose.yaml`: `scriba` (build .) always; `parakeet` sidecar under the `local`
  profile.
  - Remote transcription: `docker compose up -d` (+ `TRANSCRIBER=remote`).
  - Local transcription: `docker compose --profile local up -d` (+ `TRANSCRIBER=local`).
- Volumes: persist `DB_PATH` (`./data`); mount the vault read-only at `/vault` (host source
  `SCRIBA_VAULT_HOST_PATH`) for the link index.
- Dockerfile runs `node --import tsx src/index.ts`; migrations run at boot.
- Homelab pattern (see the `homelab` repo, bookaneer): Coolify, external `coolify` network,
  `64xxx:PORT` mapping, `restart: unless-stopped`, healthcheck. A homelab deploy compose is
  still TODO.

---

## 9. Key decisions & rationale

- **Placeholder-first, replace-by-anchor.** A jot lands as a placeholder line the instant it
  arrives, fixing its order; processing swaps the line in place via `^id`. No reordering ever.
- **English vault, translate-in.** Vault is English; Portuguese (etc.) is translated on the
  way in — Groq `/translations` for voice, the enricher for text. Detection is not needed.
- **Media = attachments.** Image/video are saved + embedded, not transcribed. A captionless
  image gets a vision caption; otherwise no agent call for attachments (token-cheap).
- **Agent-judged links, not string matching.** A cheap DB-stopword/length filter proposes
  candidates; the agent decides in context; ambiguous ones are confirmed by the user and a
  "no" is remembered forever. Fixes the "no"→Norway / "We"→book alias problem.
- **Atomic claim + capped retry.** No double-processing; poison jots stop after 10 tries (or
  immediately on unrecoverable errors), posting un-enriched with a manual retry button.
- **Long polling** (chosen over webhook) — no domain/secret to manage for a single user.
- **knex** (chosen; kept despite being heavier than raw better-sqlite3) — maintainer wants a
  query builder + migrations.
- **tsx** runtime — full TS (parameter properties) with no build step.
- **Subscription auth** for the agent — no API key; usage draws from the Claude subscription.

---

## 10. Known limitations / deferred

- **Enrichment is one agent call per jot.** Batching only coalesces arrivals/retries; a true
  bulk-in-one-prompt enrichment is a future token optimisation (`processor.ts` ponytail note).
- **inotify watch limits.** On a very large vault the recursive watch can exhaust
  `max_user_watches`; the 30-min periodic rebuild still keeps the index correct.
- **Self-signed TLS skipped** on the Obsidian client (`rejectUnauthorized:false`) — fine on
  loopback; pin a cert if `OBSIDIAN_API_URL` ever points off-box.
- **Parakeet sidecar is unauthenticated** on the compose network — fine on a private host.
- **Single user only.** The allowlist is one id; multi-user would need per-user vaults/queues.
- **`extractJson` fallback.** If the model ever emits truly malformed JSON, the jot fails and
  retries (no data loss).
- **mtime resolution.** The incremental index trusts `mtimeMs`; two writes within the same ms
  to the same file (very unlikely) could be missed until the periodic rebuild.

---

## 11. Gotchas for the next agent

- **Local Node 26 can't build better-sqlite3** (native addon predates it). The DB test
  self-skips; use Node 24 or Docker to exercise it. Everything else runs locally via tsx.
- **Don't add queries outside `Repository`.** Don't add TS parameter properties expecting
  Node's strip-only mode to run them — we run via tsx precisely because of that.
- **Commits:** Conventional Commits, single `-m`, no AI attribution, branch before pushing to
  a shared repo (this repo's `main` is the working line for now).
- **Secrets:** never log tokens; errors surfaced to the user carry status codes/bodies only.

---

## 12. How to extend

- **Swap transcription backend:** implement the `Transcriber` interface, wire in
  `createTranscriber`. (Parakeet local is already there; a self-hosted whisper.cpp would be
  another impl.)
- **Second bot / other vault (AI-brainz):** the design anticipated multiple bots and a second
  Obsidian MCP/REST target; add another `ObsidianClient` + bot identity. MetaMCP was
  considered for pooling many MCP servers but is NOT needed yet (deferred).
- **Bulk enrichment:** change `processBatch` to build one prompt for the whole batch and split
  results back per jot.

---

## 13. Commit trail (high level)

scaffold → transcriber choice (remote/local) → parakeet sidecar → tests + tsx runtime →
review quick-wins → atomic claim / capped retry / queued edits / note mutex / drop metrics /
long polling → force-retry button + edit merge + robust JSON → incremental link index →
native fs.watch. See `git log` for specifics.
