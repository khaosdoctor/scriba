# scriba

Telegram → Obsidian journaling. Send text or a voice note; scriba writes an enriched
entry into your daily note. Images and videos are saved and embedded.

- Placeholder written on arrival, filled in place — ordering never reshuffles.
- Non-English text/voice translated to English (agent for text, Groq for voice).
- Contextual `[[wikilinks]]`; ambiguous ones confirmed via buttons, a "no" is remembered.
- Reply to a jot to edit it (`s/old/new/`, `replace X with Y`, freeform, or `delete`);
  edits sent while a jot is still processing are queued and applied after.
- Failed jots retry (capped at 10; unrecoverable errors post the jot un-enriched and ping you).
- Nightly summary; silent on empty days.

## Flow

A jot is written to the note **twice**: an instant placeholder that fixes its order, then
the enriched version in place. Enrichment happens asynchronously after a batch flush.

```mermaid
sequenceDiagram
    actor U as You (Telegram)
    participant B as ScribaBot
    participant Q as FlushQueue
    participant P as JotProcessor
    participant T as Transcriber<br/>(Groq / Parakeet)
    participant E as Enricher<br/>(Claude Agent)
    participant O as Obsidian<br/>(Local REST API)

    U->>B: message (text / voice / image / video)
    B->>O: append placeholder "⏳ ^id" under ## Journal
    B->>Q: enqueue jot id
    Note over Q: flush on 30s idle · 8 msgs · 120s cap

    Q->>P: processBatch(ids)
    P->>P: claim jot (atomic: pending → processing)
    opt audio
        P->>T: transcribe → English
        T-->>P: text
    end
    opt has text (text / audio)
        P->>E: text + wikilink candidates
        E-->>P: enriched text + ambiguous links
    end
    P->>O: replace "^id" line with the final entry
    P->>B: onJotDone → apply any queued edits

    opt ambiguous link
        B->>U: "Link X → [[Note]]?" (Yes / No)
        U->>B: choice
        B->>O: apply link (Yes), or remember the "no" forever
    end

    Note over P,O: on failure: retry (transient, ≤10)<br/>else post un-enriched + 🔄 Retry button
```

Jot status machine:

```mermaid
flowchart LR
    pending -->|claim| processing
    processing -->|success| done
    processing -->|transient error, attempts &lt; 10| failed
    failed -->|retry sweep| processing
    processing -->|cap hit or unrecoverable| abandoned
    abandoned -->|🔄 Retry button| pending
```

## Stack

Node 24, TypeScript run via **tsx** (`node --import tsx`, no build step). grammy ·
better-sqlite3 + knex · groq-sdk · `@anthropic-ai/claude-agent-sdk`. One class per block,
wired in `src/index.ts`; all SQL lives in `Repository` (`db.ts`); pure logic in `core.ts`
(tested in `core.test.ts`).

## Auth

- `CLAUDE_CODE_OAUTH_TOKEN` — Claude subscription, no API key (`claude setup-token`).
- `OBSIDIAN_API_KEY` — Obsidian Local REST API.
- Transcription: `TRANSCRIBER=local` (Parakeet sidecar, `PARAKEET_URL` — default) or
  `remote` (Groq, `GROQ_API_KEY`). Text enrichment always uses Claude.

## Develop

```sh
npm install            # needs Node 24 (better-sqlite3 native addon)
cp .env.example .env    # fill in
npm run migrate         # apply schema
npm test                # core logic
npm run dev             # watch
```

## Deploy

`docker compose up -d` starts scriba plus the local Parakeet transcription sidecar
(the default). For remote transcription via Groq instead, set `TRANSCRIBER=remote` and
run just `docker compose up -d scriba`.

Provide the `.env.example` vars, a volume for `DB_PATH`, and (optional) a read-only vault
mount at `/vault` (host source `SCRIBA_VAULT_HOST_PATH`) for the link index. Migrations run at boot. The bot uses long
polling, so no public URL or webhook is needed — the exposed port is only for the health check.

## License

Elastic License 2.0 — see [LICENSE](./LICENSE).
