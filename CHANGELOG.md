# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Live per-jot status message in Telegram, edited in place as the jot moves through processing.

### Changed
- Slim the container image with an Alpine multi-stage Dockerfile.

## [1.4.0] - 2026-07-07

### Added
- Nightly habit review prompt that walks through each tracked habit one at a time.

### Security
- Redact secrets from log output via pino core redaction.

## [1.3.0] - 2026-07-07

### Added
- Telegram admin commands: `/stats`, `/status`, `/failed`, and `/jot` for observability; `/flush`, `/retry`, `/sweep`, and `/unstick` for queue control; `/stopword`, `/rejections`, and `/unreject` for managing learned link data; plus `/version` and `/help`.
- `/transcriber` to switch the transcription backend (local Parakeet or remote Groq) at runtime, with the chosen backend persisted across restarts.
- Registered the Telegram `/` command menu, starting with `/start` and `/rate`.

### Changed
- Log the `/rate` command's full lifecycle — invocation, rejected input, button taps, already-rated days, and frontmatter write failures.
- Documented logging and command-menu conventions for future commands.

## [1.2.0] - 2026-07-07

### Added
- Nightly prompt asking you to rate the day that just ended, sent automatically at `RATING_TIME` (default `00:00`).
- `/rate [YYYY-MM-DD]` command to rate any day on demand.
- Day ratings write to the daily note's `overallRating` frontmatter, locked write-once so a repeat tap or prompt can't overwrite an existing rating.

## [1.1.0] - 2026-07-07

### Added
- Typing indicator shown in Telegram while a jot is being processed.
- Done-preview message summarizing what was saved to the note once processing finishes.
- Distinct reactions for each stage of a jot's lifecycle: received, retrying, done, and failed.
- Reverse lookup from a jot to its Telegram message, enabling outcome reactions.
- Audio jots are now transcription-only — the recording produces text and is no longer saved or embedded as an attachment.

### Changed
- Standardized the vault path environment variable on `SCRIBA_VAULT_HOST_PATH`, replacing the separate `VAULT_PATH` used for both the container mount and app config.

## [1.0.1] - 2026-07-07

### Added
- Log the running version and commit SHA at boot.

## [1.0.0] - 2026-07-07

### Added
- Telegram messages become enriched Obsidian daily-note lines: text, voice, image, and video jots are captured, transcribed, enriched, and linked into the vault.
- Selectable transcription backend — local Parakeet sidecar (bundled via a compose profile) or remote Groq — defaulting to local Parakeet.
- Atomic jot claiming with capped retry and graceful give-up, queued edits, a note-create mutex, and a force-retry button to reprocess failed jots.
- Structured logging (pino) across all components.
- CI publishes container images to GHCR on main, tagged `latest`, by version, and by commit SHA.

### Changed
- Validate environment variables via a Zod schema, failing fast at boot with a readable error message.
- Simplify link suggestions to use only the local vault index, dropping the REST title-search fallback.

### Fixed
- Normalize Telegram `.oga` voice notes to `.ogg` before uploading to Groq for transcription.
- Mount the Obsidian vault correctly from `SCRIBA_VAULT_HOST_PATH`.
- Cut noisy link suggestions and fix journal line placement.
- Write logs synchronously, and stream pino-pretty directly instead of through a transport worker thread, so container logs are never lost.
- Target the journal heading by its full path, and acknowledge and surface errors back in Telegram.
- Fix edit-anchor safety, honest link acknowledgement, sweep reentrancy, and prompt fencing edge cases.

### Performance
- Watch the vault with native recursive `fs.watch` and refresh the link index on change.
- Build an incremental, mtime-based link index that only re-reads changed files.
