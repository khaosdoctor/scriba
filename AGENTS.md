# AGENTS.md

Operating manual for AI agents working on scriba. `CLAUDE.md` symlinks to this file.

## What this is

A Telegram → Obsidian journaling bot. Text/voice/image/video become enriched journal
lines in the Obsidian daily note, and tasks become checklist bullets in the vault's two
task notes. One Node/TS process, run via **tsx** (`node --import tsx`),
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
  An **image's caption is the entry text**, enriched and wikilinked like any other jot —
  what you type alongside the photo is the jot, not the embed's alt (Telegram's Bot API
  exposes no alt-text field, so `assetEmbed` writes a bare `![[asset]]` for images); a
  captionless image gets a vision caption, which becomes that text. `video` stays
  attach-only: saved + embedded with its caption as the embed's display text, never
  transcribed.

## Data / flow

- 8-char hex jot `id`, also the Obsidian block anchor `^<id>`.
- A placeholder line is written the instant a jot arrives; ordering is fixed at arrival and
  never reshuffled. Processing replaces the line in place by its anchor.
- **Squash bursts.** A text/voice jot arriving within `SQUASH_WINDOW_MS` (default 15s,
  rolling gap from the previous still-pending text/voice jot in the same note) folds into
  that jot's line: it reuses the leader's `anchor`, writes no placeholder of its own, and
  the processor enriches the whole run into one line (leader + followers share an anchor).
  The rolling-gap decision is token-free (`withinSquashWindow` in `core.ts`). Attach-only
  kinds (image/video) never squash. `SQUASH_WINDOW_MS=0` disables it. A squashed follower's
  message gets a 🤝 reaction in place of ✍ (Telegram bots can only set one reaction per
  message), marking it for merge; reacting with 🤝 yourself is the opt-out — it pulls that
  jot back into its own line (`Repository.unsquash`, a claim()-style compare-and-swap).
  Too late once the batch has already flushed and folded it into the leader.
- Jot status: `pending → processing → done` (or `failed` → retry, or `abandoned` on
  give-up). `processing` is claimed atomically so flush + sweeps never double-process.
- Stopwords, learned link-rejections and registered (always-link) pairs live in the DB,
  not in code. All three are edited from the **link-rules wizard** in `flows/menu.ts`
  (`/menu` → 🔗 Link rules): step 1 picks the rule kind, step 2 the word, step 3 the note
  or the removal. No state is held between taps — rows index into deterministically
  ordered lists re-derived on every callback, and a stale index answers "expired". Adding
  a rule needs free text, so those leaves send a force-reply prompt and route the answer
  back by the marker in the prompt text (`parseWizardRef` in `core.ts`). The note side can
  also be typed by hand ("✍️ Type a note that doesn't exist yet"), since the vault index
  only knows notes that already exist and forced pairs never consult it.
- **A jot that's too long splits into several jots.** `splitEntry` (`core.ts`) caps one
  entry at `entryMaxChars` characters — a tweet (280) by default, changed from `/menu` →
  ✂️ Entry size (presets or a typed number; the value lives in the `settings` table under
  `entryMaxChars`, `0` turns splitting off). The split happens once, right after enrichment,
  in `JotProcessor.processJot`: the jot keeps the first piece and each remaining piece
  becomes a **new jot** (`pieceJot` — fresh id, own anchor, `kind: "text"`, inserted
  already `done`) with its own journal line and its own Telegram status message, so it is
  edited, undone and reprocessed on its own. All the lines go in as ONE
  `replaceAnchorLine` over the placeholder, so they land together and in order. Rows are
  inserted after that write, never before — a failed write retries the whole jot, and rows
  written first would be duplicated. The parent's own `raw_text`/`transcript` is folded down
  to the piece it kept (skipped for a squashed leader, which has no single source field), so
  a later `/reprocess` re-enriches that piece instead of splitting all over again. The split
  itself is token-free: blank lines are topic boundaries and sentences pack greedily inside a
  topic, so a sentence is never cut in half — one longer than the cap goes out whole. The
  model's only part is being told, when the text is over the cap, to put blank lines between
  topics so the seams land on a change of subject; it may add nothing else. The give-up path
  (`fail`) never splits — getting the text into the note at all is the point there.
- **Relative-date phrases become daily-note links.** `linkDateWords` (`core.ts`) runs on
  the composed line after enrichment, resolving phrases like "yesterday", "three weeks
  ago", or "next Friday" — via `chrono-node`, token-free — against the jot's own day (not
  processing time) and rewriting them to `[[YYYY-MM-DD|phrase]]`. The target daily note
  doesn't need to exist yet.
- **Years are linked by the enricher, not by a regex.** The vault keeps a note per year
  under `maps of content/years`, so every year an entry mentions is linked — `[[1918]]`,
  and `[[146 BCE]]` before the common era (always BCE, never BC/AD). This is the enricher's
  job precisely because it needs context: nothing but the sentence separates "1500 metres"
  from "in 1500 the city fell", and no amount of regex supplies that. Years are linked even
  though they never appear in the candidate list; decades, clock times, versions and
  already-linked dates are not. `/command` carries the same rule for the notes it writes,
  plus: a year with no note yet is created from the year template in `internal/templates`
  (the template holds the placeholders — a neighbouring year note doesn't), written before
  the note that links to it. Its prompt also bars question-word headings — "Why it matters"
  → "Importance", "Where it started" → "Origins": a heading is a label, not a question.
- **`/command` is a sticky agent session over the vault**, closed by `/done` (or 15 minutes
  idle). While it's open, `ScribaBot`'s text handler routes every message to
  `CommandSession` instead of intake, so a prompt never lands in the journal as a jot.
  **Its limits are the tool list, not the prompt.** It gets no built-in tool that can reach
  the host — `Bash`, `Read`, `Write`, `Glob`, `Grep`, `Task` and friends are all in
  `disallowedTools`, and `canUseTool` denies anything not on the allowlist regardless.
  What it has is six custom in-process tools (`createSdkMcpServer` + `tool()` from the agent
  SDK) in `services/vault.ts`: `vault_list`/`vault_read`/`vault_search` off the read-only
  mount, `vault_write`/`vault_delete` through Obsidian's REST API (the mount can't be
  written), and `web_fetch`, plus the SDK's `WebSearch` for research. Every path goes
  through `safePath` — string containment (`isInsideRoot`) **and** a realpath check, so
  neither `../` nor a symlink inside the vault gets out. `web_fetch` is http(s) only,
  re-checks every redirect hop, and refuses anything resolving to a private address: the bot
  sits inside a LAN of unauthenticated services, so fetching must not become a way to read
  them. Writes and deletes stop for a Telegram ✅/❌ confirmation (`canUseTool` awaits the
  tap, 5-minute timeout defaulting to refusal). `COMMAND_MODEL` (default `claude-sonnet-5`)
  is separate from `AGENT_MODEL` — enrichment is a haiku-sized job, writing a note in the
  owner's voice is not. Style guidance lives in the system prompt, but the vault outranks
  it: the agent is told to read neighbouring notes first and to follow `internal/voice.md`
  if the vault has one.
- **Command mode never blocks on the agent.** `handle` takes a message, gives it its own
  status message and returns; the agent runs against one long-lived query, opened on the
  first prompt and kept alive for the whole session (the SDK's **streaming-input mode** —
  `PromptStream`, an async iterable of user messages — which is also what makes `interrupt()`
  available). Prompts are fed in one at a time and each `result` settles the oldest, so a
  turn and its answer can never be mismatched: a message sent mid-run is acknowledged as
  🕐 Queued straight away and its own status message is later edited into its answer.
- **A turn is one message, rewritten — not a stream of them.** Everything the agent does
  while it works goes into that turn's status message: reasoning
  (`COMMAND_THINKING_TOKENS`, default 4000; `0` turns thinking and those lines off), tool
  calls, ⚠️ failed tool results, and prose it writes before doing something else. Each line
  is flattened and cut to 330 chars (`clipUpdate`), then the message is re-rendered as
  `feedMessage(header, turn.feed)`. **Every line is prefixed with an emoji for what it is**
  — `toolIcon` per tool (📖 read, 🔍 search, ✍️ write, 🗑 delete, 🌐 fetch, 🔧 unknown) and
  `thoughtIcon` for the agent's own words, a keyword lookup so a glance says which part of
  the job it's on. Both are tables in `core.ts`: display must not cost a token or a round
  trip. When the feed would push the message past Telegram's cap, `fitFeed` drops lines off
  the **front** until it fits, and the trimmed tail is what's kept — a live view, not a
  transcript. Edits are throttled to one per `FEED_EDIT_MS` (1.2s, injectable for tests):
  the agent emits events far faster than a person reads and Telegram rate-limits edits, so
  updates coalesce, and the render is skipped when it would change nothing (Telegram
  rejects those). A pending edit checks `this.active === turn` before it lands, so a stale
  feed can never overwrite an answer that arrived first. Prose is held back until something
  follows it: what's left when the turn ends is the answer, which replaces the feed.
- **Everything about a turn is a Telegram reply to the message that prompted it** — its
  status message (feed and answer alike) and the ✅/❌ change confirmation — via `replyParams`
  (`reply_parameters`, with `allow_sending_without_reply` so a deleted prompt can't take its
  own answer down). With several turns in flight the chat reads as threads instead of one
  interleaved stream, so `Turn` carries the owner's `chatId`/`sourceId` from `ctx`. Every
  status message carries **⏹ Stop** (`cm:s:<turnId>`) — on the running turn it calls
  `interrupt()` (and refuses any confirmation it was waiting on), on a queued one it drops
  it before it runs. Telegram sends are chained through `send()` rather than awaited, so the
  chat stays in order without the agent loop ever waiting on the API. A query that dies is
  rebuilt on the next prompt with `resume: sessionId`, so the conversation survives.
- **A turn that goes quiet is given up on.** A query can stop yielding without ever ending
  (a CLI subprocess that dies without closing its stream, a call retrying forever), and
  nothing else catches that: `active` never clears, so every later prompt queues behind a
  turn that will never finish. `armWatchdog` restarts a `TURN_SILENCE_MS` timer (5 min,
  injectable) on **agent events only** — pointedly not on the owner's messages, or the
  replies piling up behind a dead turn would keep it alive, which is what the session's own
  `touch()` idle timer does. On expiry `abandon` interrupts, tears the query down, answers
  that turn with `silentNotice`, and pumps the queue; the stop-grace path goes through the
  same `abandon`. A turn parked on a ✅/❌ confirmation is exempt (`pending.size`): it's
  waiting on the owner by design, so the timer re-arms instead of firing.
- **Tasks live in two vault notes, never in the DB.** A task is a checklist bullet under
  one heading per note — `## Other Tasks` in the work note, `## Things to do` in the
  personal one — tagged (`#type/todo/work`, `#type/todo`) and carrying `[start:: date]`
  (planned start, optional) and `[due:: date]` (the deadline, mandatory), with
  `[completion:: date]` stamped on done. Paths, headings, tags and which end a new task
  goes on (work runs newest-first, personal is appended to) are all config. Only the two
  notes are the truth: created tasks are never mirrored into sqlite, so a task edited in
  Obsidian is still the task scriba lists and ticks. `flows/tasks/parse.ts` is the pure
  half and is deliberately tolerant of what is really in those notes — the older
  `✅ 2026-03-02` done marker beside `[completion:: ]`, cancelled `- [-]` rows, a typo'd
  `[start::6-03-01]`, an empty description, and `[id:: ]`/`[dependsOn:: ]` fields it must
  leave untouched. `services/tasks.ts` is the I/O half: read-modify-write under
  `withNoteLock`, bumping the note's `updatedAt` frontmatter.
- **A message never becomes a task directly.** Task mode (`/task`, closed by `/done` or 15
  minutes idle) turns each message into a *draft*, shown on a confirmation card whose
  buttons change the description, either date or the type; only ✅ Create writes the note,
  and it refuses a draft with no deadline and asks for one instead. Those questions are
  plain messages you reply to — deliberately **not** `force_reply`, which points the compose
  box at the question the moment it arrives and so sends whatever you were already typing as
  the answer to something you hadn't read (the same reason the habit value questions, the
  link wizard, the entry-size prompt and the menu's jot edit dropped it too). Each one is
  **deleted once its answer lands** — a question is
  scaffolding, not conversation, and the card already shows the answer. One that couldn't
  be read stays put (there would be nothing left to reply to), and settling a card clears
  whatever it still had open. The ids are held in memory, like `ScribaBot`'s status-message
  map: a restart forgets at most one unanswered prompt. Drafts live in the
  `task_drafts` table rather than in memory: a description can't ride in Telegram's 64
  bytes of callback data, and a card whose buttons go dead on a restart is worse than one
  that survives it. The split itself is token-free — `chrono-node` finds the date spans and
  the cue word in front of each ("by", "due", "starts", "from") says which date it is; one
  date is the deadline, since that is the mandatory one. chrono is tried in **en, then pt,
  then sv**, first locale with a real hit winning: the vault is English, but a task is typed
  in whatever language it came to mind in, and a task whose date isn't read is a task that
  stops to ask. The cue and filler word matching uses Unicode lookarounds rather than `\b`,
  which is ASCII-only in JS and so never closes a word ending in "é" or "å". Personal unless the text plainly
  says work (`for work`, `at work`, `@work`), because a bare "work" is a verb as often as a
  category, and the type button is one tap.
- **Task mode and command mode never run at once.** Both own the whole message stream, so
  neither opens over the other, and the single `/done` — registered by `ScribaBot`, not by
  either flow — closes whichever is open.
- **A menu screen is scaffolding, so it cleans itself up.** Every screen `/menu`,
  `/reprocess` and the task lists render carries one **✖ Close** that deletes the message
  outright (falling back to clearing its buttons when Telegram won't delete a message older
  than 48 hours), including the confirmations a wizard branch ends on. `/menu`'s own screens
  also self-destruct after a minute of no taps; task lists don't — you read those, and the
  morning summary has to survive until you have worked through it — so Close is how they go.
- **The task lists are the vault's own Tasks-plugin queries.** Open, overdue, due today,
  this week, the next fortnight, and done by completion date. Every row is a button:
  tapping an open task ticks it in the note, tapping a done one reopens it, and the list
  re-renders in place. A row's callback carries the digest of the line it was drawn from,
  so a tap that lands after the note changed underneath is refused rather than ticking
  whatever has since moved into that position. Telegram's own checklists (`sendChecklist`)
  are business-account-only, so buttons are as close as a normal bot gets.
- **The morning summary is the one message that interrupts.** At `TASKS_TIME` (09:00) the
  scheduler calls `TasksFlow.dailySummary`, which renders the `day` view — due today, still
  due from before, or starting today — through the same `viewMessage` the lists use, so its
  rows tick straight through to the vault. It is sent with `disable_notification: false`
  rather than inheriting a default — this is the one message meant to interrupt — but a day
  with nothing due sends nothing at all, the same way the nightly journal summary keeps
  quiet on a day with no jots. A failure still speaks up, so a silent morning only ever
  means an empty day. A chat muted in Telegram itself stays muted — no bot can override
  that, there is no API for it.
- **Tasks spotted in a jot come out of the enrichment call, not a second one.** The
  enricher already reads every entry, so its JSON carries a `tasks` array beside the
  wikilinks; each one becomes the same confirmation card, with 🚫 Not a task in place of
  Cancel. The model reports the author's own words for the timing ("next friday") and never
  does date arithmetic — chrono resolves them against the **jot's own day**. Two guards:
  the feature switches off from the task menu (a `settings` row), and a jot that already
  produced drafts is never asked about again, so `/reprocess` can't re-propose tasks that
  were created or dismissed weeks ago. `tasks` is optional coming back in, since the Groq
  fallback has no structured output to enforce the shape.
- **Undo is a button on the finished status message.** A jot that reaches `done` (and any
  later edit that leaves it there) carries an ↩️ Undo button — `un:<jotId>`, handled by
  `ScribaBot.handleRemove`, which runs the same `deleteJot` teardown as `/delete` and then
  re-renders the status without a keyboard. Deleting a squashed leader marks its followers
  deleted too: they share the one anchor line that just went away.
- **Every failure is a decision, so it carries both buttons.** Any jot that fails —
  transient (still in the retry cycle), given up on, or thrown during intake in `bot.catch`
  — gets **🔄 Retry** (`rt:<jotId>`, `handleRetry`: `resetForRetry` + requeue now) and
  **🗑 Delete** (`dl:<jotId>`, the same `handleRemove` as Undo) side by side, built by
  `jotButtons` from the `StatusButtons` flags `status()` takes. The transient case used to
  say nothing at all and leave the message on "✨ Weaving it into your journal…" until the
  sweep came round, which reads as stuck rather than waiting; it now posts `retryNotice`
  (`core.ts`) naming the attempt and how many are left. Giving up posts `gaveUpMessage`.
  Both quote the error escaped and capped, since an error can be a whole stack trace, and
  both go out through `JotProcessor.say`, which swallows a Telegram failure so a hiccup in
  the failure path can't throw out of `fail()` and abandon the rest of the batch. The two
  buttons guard each other: Retry refuses a jot that's already `deleted`, and Delete answers
  "already deleted" rather than tearing down twice. `/failed` lists the same pair per row.
- **Edits fold back into the source, so reprocess doesn't undo them.** Correcting a jot's
  line (reply `s/old/new/`, a freeform reply instruction, or Telegram's native message-edit)
  also writes the corrected text into the jot's own `transcript` (audio) or `raw_text`
  (text) field, not just the journal line — otherwise `/reprocess` re-transcribes/re-reads
  the original source and silently reverts the fix. Scoped to a standalone jot
  (`ScribaBot.syncEditedSource`, `bot.ts`): a squashed leader/follower is skipped, since a
  squashed line is several jots' sources combined into one and there's no single field to
  fold the edit back into.

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
- **Tests sit next to the source** as `<name>.test.ts`, one per file — except the admin
  commands, which share `src/commands/commands.test.ts`: they're one file each but one
  surface (the registry `bot.ts` loops over), so the registry's shape and each command's
  argument branching are checked together. Prefer a real collaborator over a mock where one
  is cheap: `obsidian.test.ts` runs the client against a loopback HTTP server rather than
  stubbing `fetch`, which is what lets it test the write-lock and the daily-note dedupe;
  `log.test.ts` reads redaction back out of a child process, since pino writes to fd 1.

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
