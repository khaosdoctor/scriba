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

## Live verification (never run end-to-end)
- [ ] Long-polling bot connects and the single-user allowlist works.
- [ ] Obsidian Local REST API reachable from the container; daily-note create + journal
      append + asset upload + anchor replace all work against the VFB (`multivac:27124`).
- [ ] Agent enrichment returns valid JSON on real input; wikilink buttons round-trip.
- [ ] Voice transcription works in the chosen mode (Groq remote, or the Parakeet sidecar).

## Deferred (post-launch, not blocking)
- [ ] Bulk one-call enrichment (currently one agent call per jot).
- [ ] inotify watch-limit handling on a huge vault (periodic rebuild already covers correctness).
- [ ] Second bot / AI-brainz vault target; MetaMCP if the MCP-server count grows.
