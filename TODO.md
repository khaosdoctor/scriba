# TODO

Code is feature-complete and green (typecheck clean, 27/28 tests, 1 native-sqlite skip),
pushed to `main`. Not yet verified live. Remaining before scriba runs in production:

## Deploy blockers
- [ ] Set env: `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_ID`, `OBSIDIAN_API_KEY`,
      `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`), and `GROQ_API_KEY` (remote mode only).
- [ ] Write the homelab deploy compose in the `homelab` repo (bookaneer pattern: coolify
      network, `64xxx:PORT`, DB volume, read-only vault mount for `VAULT_PATH`).
- [ ] Build the Docker image and confirm it boots (also the only place better-sqlite3 +
      the DB test actually run — Node 24, not the local Node 26).
- [ ] Publish `ghcr.io/khaosdoctor/scriba:latest` via CI — the homelab compose
      (`homelab/services/scriba/docker-compose.yaml`) references it by image tag.
- [ ] Confirm the container reaches the VFB Obsidian REST API on the host
      (`host.docker.internal:27124`, `extra_hosts: host-gateway`) and set `SCRIBA_VAULT_HOST_PATH`
      to the Default vault's path on multivac for the read-only link-index mount.

## Live verification (never run end-to-end)
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
