# scriba

Friction-free journaling. Send a text or voice note to a Telegram bot; scriba writes
an enriched entry into your Obsidian daily note.

- **Text, voice, images, video.** Type it or speak it; images and videos are saved to
  the vault and embedded (caption kept). Non-English text/voice is translated to English
  (Groq Whisper for voice, the agent for text) — the vault stays English.
- **Instant placeholder.** Every jot lands in the daily note immediately as a
  placeholder line, so ordering is fixed at arrival and never reshuffled.
- **Enrichment.** A Claude agent adds `[[wikilinks]]` for people/projects/topics that
  match your vault, judged in context — no blind alias matching.
- **You stay in control.** Ambiguous links are confirmed with Telegram buttons; a "no"
  is remembered forever. Reply to a jot to edit it (`s/old/new/`, "replace X with Y",
  freeform, or "delete").
- **Nightly summary** at a configured time; silent on empty days.

## Architecture

One process, wired in `src/index.ts`, each block a class:

| Class | File | Responsibility |
|---|---|---|
| `Repository` | `db.ts` | The only place SQL/knex lives. All persistence. |
| `ObsidianClient` | `obsidian.ts` | Local REST API: notes, journal append, assets. |
| `Transcriber` | `transcribe.ts` | Groq Whisper voice → English text. |
| `Enricher` | `enrich.ts` | Claude Agent SDK: translate + link + freeform edit. |
| `LinkIndex` | `index-links.ts` | Vault title/alias index for link candidates. |
| `FlushQueue` | `queue.ts` | Adaptive batching (idle / size / max-wait timers). |
| `JotProcessor` | `processor.ts` | Per-jot pipeline: media → enrich → write. |
| `ScribaBot` | `bot.ts` | All Telegram wiring (webhook, intake, edits, buttons). |
| `Scheduler` | `scheduler.ts` | Nightly summary + forever-retry sweep. |

Pure, token-free logic (line formatting, anchor replace, candidate filtering, edit
parsing) lives in `core.ts` and is unit-tested in `core.test.ts`.

## Auth

- **Claude Agent SDK** runs on your Claude subscription — no API key. Generate a token
  once with `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN`.
- **Groq** free tier for transcription (`GROQ_API_KEY`).
- **Obsidian** Local REST API key from the plugin settings (`OBSIDIAN_API_KEY`).

## Develop

```sh
npm install
cp .env.example .env   # fill it in
npm run migrate        # apply DB schema
npm test               # core logic
npm run dev            # watch mode
```

## Deploy

Build the image and run it on the homelab (Coolify). It needs the env vars from
`.env.example`, a persistent volume for `DB_PATH`, and — for the link index — a
read-only mount of the vault at `VAULT_PATH`. Migrations run automatically at boot.

## License

Elastic License 2.0 — see [LICENSE](./LICENSE).
