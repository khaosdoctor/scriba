# TODO

Code is feature-complete and green (typecheck clean; 28/28 tests pass in the Node 24
container, 27/28 locally with 1 native-sqlite self-skip). Not yet verified live.
Remaining before scriba runs in production:

## Session progress (2026-07-07)
- [x] CI to build + push the image — `.github/workflows/publish.yml`, on push to `main`
      + manual dispatch. Tags: `latest`, package.json `version`, and `sha-<short>`.
      Merged to `main` and **CI ran green (run 28866980458) — NO package-create 403**;
      `ghcr.io/khaosdoctor/scriba:latest` published. (Local verify blocked only by the gh
      token lacking `read:packages`; CI's build-push success is authoritative.)
- [x] Local Docker build — native better-sqlite3 addon compiles clean on Node 24.
- [x] Local boot — `scriba ready` + health on `:8080`; migrations run, native sqlite opens.
      Dies only at Telegram `deleteWebhook 401` on a fake token (expected; needs a real bot).
- [x] Full test suite green in the Node 24 container — 28/28, the DB roundtrip un-skipped.

## Next up (order agreed)
1. [DONE] CI merged to main + image published (no 403).
2. Create the Telegram bot(s); fill env from `.env.example` placeholders.
3. Live-verify (see below), then LAST: merge homelab PR #1 — that triggers the deploy.

   Note: package likely `private` by default. Coolify pull on multivac needs a ghcr
   pull token/secret, OR toggle package visibility to public. Confirm before deploy.

## Deploy blockers
- [ ] Set env: `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_ID`, `OBSIDIAN_API_KEY`,
      `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`), and `GROQ_API_KEY` (remote mode only).
      Lucas creates the bot(s); `.env.example` already holds the placeholder set.
- [ ] Merge the homelab compose PR — khaosdoctor/homelab#1 (`feat/add-scriba-service`).
      DO LAST — merging triggers the Coolify deploy.
- [ ] Publish `ghcr.io/khaosdoctor/scriba:latest` via CI — the homelab compose
      (`homelab/services/scriba/docker-compose.yaml`) references it by image tag.
      CI is written; needs the branch pushed/merged + package-visibility check.
- [ ] Confirm the container reaches the VFB Obsidian REST API on the host
      (`host.docker.internal:27124`, `extra_hosts: host-gateway`) and set `SCRIBA_VAULT_HOST_PATH`
      to the Default vault's path on multivac for the read-only link-index mount.

## Live verification (never run end-to-end)
Plan: bot+allowlist after bots exist; Obsidian REST via a busybox in multivac (or local
over tailscale); enrichment via a subagent smoke test; voice tested manually.
- [ ] Long-polling bot connects and the single-user allowlist works.
- [ ] Obsidian Local REST API reachable from the container; daily-note create + journal
      append + asset upload + anchor replace all work against the VFB (`multivac:27124`).
- [ ] Agent enrichment returns valid JSON on real input; wikilink buttons round-trip.
- [ ] Voice transcription works in the chosen mode (Groq remote, or the Parakeet sidecar).

## Future iterations (discussed, post-launch, not blocking)
- [ ] **Proactive journaling prompts** — beyond the 23:30 summary, have the bot ask
      questions to pull journaling out (e.g. an evening "how was your day?"), and be
      proactive about nudging. This was an original goal; v1 only ships the summary.
- [ ] **Externalized scheduler** — a separate service that reads a static JSON config
      (`[{name, cron, url, method, body}]`), fires HTTP calls, and tracks last-run/state.
      Dropped for v1 (folded into an in-bot timer); revisit when more scheduled actions or
      other homelab services need generic scheduling.
- [ ] **Multi-bot / community bots** — separate Telegram bot identities (notes bot, Claude
      Code bot, skills bot) sharing the brain + MCP pool. Design anticipated it (one process,
      multiple identities, routing by bot).
- [ ] **AI-brainz vault as a second target** — add another `ObsidianClient` + bot identity
      pointing at the AI Brainz vault's MCP/REST.
- [ ] **MetaMCP** (metamcp.com) — pool multiple MCP servers once the server count grows
      beyond the single Default-vault Obsidian MCP.
- [ ] **Interact with the persistent Claude Code session** on the homelab from the bot
      (original goal; not in v1).
- [ ] **Bulk one-call enrichment** — currently one agent call per jot; batch a flush into a
      single prompt and split results back per jot to save tokens.
- [ ] **inotify watch-limit handling** on the huge vault (periodic rebuild already covers
      correctness; only the live-freshness watcher degrades if `max_user_watches` is hit).
- [ ] **Local transcription upgrade path** — Parakeet sidecar is wired; revisit models
      (Handy uses Parakeet V3) if quality/latency on the N100 needs tuning.
