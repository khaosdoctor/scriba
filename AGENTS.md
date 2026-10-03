# AGENTS.md

Operating manual for AI agents working on scriba. `CLAUDE.md` symlinks to this file.

## What this is

A Telegram → Obsidian journaling bot. Text/voice/image/video become enriched journal
lines in the Obsidian daily note, and tasks become checklist bullets in the vault's two
task notes. One Node/TS process, run via **tsx** (`node --import tsx`),
deployed on the homelab (Coolify). Single user.

## Layout

```
src/
  index.ts                 entrypoint: loads the config, starts the app, serves /health
  app.ts                   createScriba: builds every class and wires them together
  config.ts                the env schema (zod) and loadConfig
  presentation/telegram/   everything that talks to Telegram, one folder per feature:
                           admin/ command/ habits/ journal/ rating/ reprocess/
                           settings/ tasks/ til/
  services/                business logic, one class per feature plus the shared ones
  data/connections/        clients for external sources, with no operations of their own
  data/repositories/       operations over those clients: SQL tables and the vault
  domain/<entity>/         an entity's types and the pure rules of that one entity:
                           habit/ jot/ link-rule/ rating/ setting/ task/
  libs/                    helpers shared across entities, any layer may use
  test/                    shared fakes and harnesses for the tests
```

Layers call downward only: presentation calls services, services call data. `domain/` and
`libs/` are columns any layer may import, and they import only each other.

## Ground rules

- **Presentation is everything that talks to Telegram.** `src/presentation/telegram/` is
  the only code besides `app.ts` that imports grammy. A view turns an update into a service
  call and renders the result. It imports services, `domain/` and `libs/`, never `data/`.
  `registerViews` (`presentation/telegram/index.ts`) registers every view in the order an
  update is tried.
- **Services hold the business logic.** One class per feature in `src/services/`
  (`JotService`, `EditService`, `ProcessingService`, `TaskService`, `RatingService`,
  `HabitService`, `CommandService`, `SettingsService`, `AdminService`) and the shared ones
  the features consume (`MediaService`, `FallbackTranscriber`, `VoiceService`, `Enricher`).
  A service may call repositories, connections, other services, `domain/` and `libs/`,
  never presentation, and it stays free of grammy: whatever a service says on its own goes
  through `Notifier` (`services/notifier.ts`), which `Chat` (`presentation/telegram/chat.ts`)
  implements.
- **Persistence lives in `data/repositories/`.** All SQL/knex is there, one repository per
  table group (`JotRepository`, `LinkRuleRepository`, `SettingsRepository`,
  `TaskDraftRepository`, `RatingRepository`), opened together by `Repository`
  (`data/repositories/index.ts`), and each service takes the repositories it needs. Do not
  write queries anywhere else: add a method to the repository. Vault operations
  live here too: `ObsidianClient` (`notes.ts`, the note operations and the per-note lock,
  over `ObsidianConnection`), `TaskNoteRepository` (`task-notes.ts`, the two task notes) and `VaultRepository` (`vault.ts`,
  the read-only mount and the link index).
- **External clients live in `data/connections/`.** One client per source, with no business
  operations: `openDb` (`sqlite.ts`, knex and migrations), `GroqTranscriber` and `groqChat`
  (`groq.ts`), `ObsidianConnection` (`obsidian.ts`, the REST API and its TLS dispatcher),
  `ParakeetTranscriber` (`parakeet.ts`), `WebService` (`web.ts`),
  `GithubReleases` (`github.ts`), `TelegramFiles` (`telegram-files.ts`, `getFile` and the
  download URL that carries the bot token) and `sdkQuery` (`anthropic.ts`, the Agent SDK's
  `query`, which also re-exports `createSdkMcpServer`, `tool` and the SDK types). A service
  takes its connection through the constructor: `Enricher` and `AgentService` get
  `sdkQuery`, `MediaService` gets `TelegramFiles`, and `FallbackTranscriber` gets its
  backend list from `buildTranscriber` in `app.ts`. A new API gets its client here. Still
  to move: `HealthMonitor` probes the upstreams itself. Don't add more of those.
- **Pure helpers in `libs/` and `domain/`.** Deterministic, token-free helpers (formatting,
  anchor replacement, candidate filtering, edit parsing) live in `libs/<topic>.ts`, each with
  its `<topic>.test.ts`. No network, vault or database access there; the only side effects
  are infrastructure: the logger (`log.ts`) and the timers of `Scheduler` (`scheduler.ts`)
  and `FlushQueue` (`queue.ts`). `domain/<entity>/entity.ts` holds the entity types, the
  constants that belong to them (`JOT_STATUSES`, `MAX_ATTEMPTS`, the `SETTINGS` table) and
  the pure rules of that one entity (`followupQuestions` and `ratingDay` in
  `domain/rating/entity.ts`, `parseEntrySize` in `domain/setting/entity.ts`, `linkRuleKey`
  and `notesFor` in `domain/link-rule/entity.ts`), in a sibling `rules.ts` when they would
  make `entity.ts` long (`domain/jot/rules.ts`: `isFollower`, `sourceField`, the journal
  line format, the TIL prefix; `domain/habit/rules.ts`: `parseHabits`, `completeHabitLine`).
  A reply-ref marker keeps its builder and parser together in `libs/` (`parseHabitRef` in
  `libs/habits.ts`, `followupRef`/`parseFollowupRef` in `libs/followup.ts`,
  `taskRef`/`parseTaskRef` in `libs/tasks.ts`), since services build it and views parse it. `structures.ts`
  holds the shapes passed between layers (`IntakeInput`, `DetectedTask`). A rule that spans
  entities, or has no entity, goes in `libs/`.
- **Wiring happens only in `src/app.ts`.** Each system block is a class, with its
  collaborators injected through the constructor (usually one `deps` object typed with
  `Pick<...>`). `createScriba` builds and wires all of them and registers the scheduled
  jobs; its `ExternalServices` argument lets a test swap any outside collaborator.
  `src/index.ts` only loads the config, calls `createScriba`, serves `/health` and handles
  shutdown signals.
- **Slash commands live in their feature's folder.** Each is a `CommandView`
  (`{ command, description, admin?, run }`, `presentation/telegram/commands.ts`), such as
  `journal/delete.ts`, `tasks/add.ts` or `admin/flush.ts`, and is listed in `COMMANDS` in
  that same `commands.ts`, which `registerViews` loops over. Admin commands that answer with
  one text are built with `textCommand` (`admin/text-command.ts`) over `AdminService`. A
  view stays thin: it parses the args and hands them to a service. Runtime settings that
  must survive a restart go in the `settings` key/value table, with the key declared in
  `SETTINGS` (`domain/setting/entity.ts`).
- **No tokens for control flow.** Batch timing, retry classification, candidate filtering,
  language routing must not call the model. The agent is only for enrichment, translation,
  image captioning, and freeform edits.
- **Vault is English.** Voice is transcribed by Groq when `GROQ_API_KEY` is set, and by
  the always-on Parakeet sidecar when Groq fails or there is no key
  (`FallbackTranscriber`); non-English is translated in (Groq `/translations`, or the
  enricher for Parakeet voice + all text).
- **Every model call falls back remote → local.** Enrichment tries the chosen Claude
  model (haiku by default), then `ENRICH_BACKUP_MODEL` (sonnet), then the Groq model, then
  OpenCode Go when `OPENCODE_GO_API_KEY` is set, and posts the jot un-enriched when all
  fail. The user is told once per change of step, not per jot, with the error that moved
  it. Vision has no Groq step.
- **No model call waits forever, and a dead step is skipped.** Each call is capped at
  `ENRICH_TIMEOUT_MS` (15s): the SDK gets an `AbortController` and the answer is raced
  against it, the chat fallbacks get the same cap with SDK retries off (the next step is
  the retry). SDK calls run with extended thinking off (`thinking: { type: "disabled" }`):
  linking a line needs none, and haiku's default thinking took 6-7s of a ~9-15s call. Each
  step has a `CircuitBreaker` (`libs/model.ts`, token-free): three transient
  failures in a row (`isRecoverable`: timeouts, 5xx, 429, network) and the step is skipped
  for two minutes, then one trial call decides. An unusable answer or a rejected key still
  moves down the chain but never trips a breaker, so it can't hold jots behind a failure no
  cooldown fixes; those jots end the usual way, posted un-enriched. Voice fix is
  best-effort: when it fails the original transcript goes on to enrichment. When every
  step is open, `run` throws `ModelsDownError` and the user is told once; the processor
  then **holds** jots — no claim, no retry charged, `heldNotice` on the status message,
  the placeholder keeps its place — and the retry sweep brings them back once a cooldown
  lets a trial through. Only the SDK path gets `outputFormat`; the "reply with one JSON
  object" instruction goes to the chat fallbacks alone, because given to the SDK it fights
  the StructuredOutput tool (haiku answers in text and runs out of turns, sonnet nests the
  JSON inside `text`).
- **Four jot kinds.** `text`/`audio` carry enrichable text (audio is transcribed).
  An **image's caption is the entry text**, enriched and wikilinked like any other jot —
  what you type alongside the photo is the jot, not the embed's alt (Telegram's Bot API
  exposes no alt-text field, so `assetEmbed` writes a bare `![[asset]]` for images); a
  captionless image gets a vision caption, which becomes that text. `video` stays
  attach-only: saved + embedded with its caption as the embed's display text, never
  transcribed.

## Adding a feature

- `src/presentation/telegram/<feature>/`: one file per event. A slash command is a
  `CommandView` (often `command.ts`) added to `COMMANDS`; a button namespace (often
  `tap.ts`) is built with `namespace()` (`presentation/telegram/namespace.ts`) and added to
  `callbackViews` (`callbacks.ts`); an answer to a prompt (often `reply.ts`) is routed by a
  marker in the prompt text and added to `promptReplies` (`replies.ts`).
- `src/services/<feature>.ts`: the class with the logic. Add it to `ViewDeps`
  (`presentation/telegram/index.ts`) when a view needs it.
- `src/data/repositories/<name>.ts` for a new table, with a knex migration under
  `migrations/`, opened in `Repository`. `src/data/connections/<name>.ts`
  for a new external client.
- `src/domain/<entity>/entity.ts` for a new entity's types. A new setting is a key in
  `SETTINGS`.
- `src/libs/<topic>.ts` for the deterministic helpers the feature needs.
- `src/app.ts` to construct the new classes and wire them in. A scheduled job is a
  `scheduler.daily` or `scheduler.every` call there.
- A `<name>.test.ts` next to each new source file.

## Data / flow

- 8-char hex jot `id`, also the Obsidian block anchor `^<id>`.
- A placeholder line is written the instant a jot arrives; ordering is fixed at arrival and
  never reshuffled. Processing replaces the line in place by its anchor.
- **Squash bursts.** A text/voice jot arriving within `SQUASH_WINDOW_MS` (default 15s,
  rolling gap from the previous still-pending text/voice jot in the same note) folds into
  that jot's line: it reuses the leader's `anchor`, writes no placeholder of its own, and
  the processor enriches the whole run into one line (leader + followers share an anchor).
  The rolling-gap decision is token-free (`withinSquashWindow` in `domain/jot/rules.ts`). Attach-only
  kinds (image/video) never squash. `SQUASH_WINDOW_MS=0` disables it. A squashed follower's
  message gets a 🤝 reaction in place of ✍ (Telegram bots can only set one reaction per
  message), marking it for merge; reacting with 🤝 yourself is the opt-out — it pulls that
  jot back into its own line (`JotRepository.unsquash`, a claim()-style compare-and-swap).
  Too late once the batch has already flushed and folded it into the leader.
- **TIL section.** A text jot starting with `TIL` (`stripTilPrefix` in `domain/jot/rules.ts`, token-free)
  is stored with the prefix removed and `section = "til"` (`jots.section`, default
  `"journal"`). Every write that has to append a line (placeholder, unsquash, anchor-missing
  fallback) passes `jot.section` to `ObsidianClient.appendJournalLine`, which picks
  `TIL_HEADING` or `JOURNAL_HEADING`. The line keeps the usual `- _time ::_ text ^anchor`
  shape, so replace/edit/undo/reprocess find it by anchor anywhere. A missing heading falls
  back to appending at the end of the note, like Journal. A TIL jot only squashes with
  another TIL jot, and split pieces inherit the section.
- Jot status: `pending → processing → done` (or `failed` → retry, or `abandoned` on
  give-up). `processing` is claimed atomically so flush + sweeps never double-process.
- Stopwords, learned link-rejections and registered (always-link) pairs live in the DB,
  not in code. All three are edited from the **link-rules wizard** in
  `presentation/telegram/settings/links.ts` (`/menu` → 🔗 Link rules): step 1 picks the rule kind, step 2 the word, step 3 the note
  or the removal. No state is held between taps — rows index into deterministically
  ordered lists re-derived on every callback, and a stale index answers "expired". Adding
  a rule needs free text, so those leaves send a force-reply prompt and route the answer
  back by the marker in the prompt text (`parseWizardRef` in `libs/wizard.ts`). The note side can
  also be typed by hand ("✍️ Type a note that doesn't exist yet"), since the vault index
  only knows notes that already exist and forced pairs never consult it.
- **A jot that's too long splits into several jots.** `splitEntry` (`libs/text.ts`) caps
  one entry at `entryMaxChars` characters: a tweet (280) by default, changed from `/menu` →
  ✂️ Entry size (presets or a typed number; the value lives in the `settings` table under
  `entryMaxChars`, `0` turns splitting off). The split happens once, right after enrichment,
  in `ProcessingService.processJot`: the jot keeps the first piece and each remaining
  piece becomes a **new jot** (`pieceJot` — fresh id, own anchor, `kind: "text"`, inserted
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
- **Relative-date phrases become daily-note links.** `linkDateWords` (`libs/links.ts`) runs on
  the composed line after enrichment, resolving phrases like "yesterday", "three weeks
  ago", or "next Friday" — via `chrono-node`, token-free — against the jot's own day (not
  processing time) and rewriting them to `[[YYYY-MM-DD|phrase]]`. The target daily note
  doesn't need to exist yet. A `for <duration>` span ("for a week now") is a length of
  time, and chrono would resolve it to a day that far ahead, so it stays unlinked.
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
  idle). While it's open, the text view (`textView`, `presentation/telegram/journal/text.ts`)
  routes every message to `CommandService.handle` instead of intake, so a prompt never ends
  up in the journal as a jot.
  **Its limits are the tool list, not the prompt.** It gets no built-in tool that can reach
  the host — `Bash`, `Read`, `Write`, `Glob`, `Grep`, `Task` and friends are all in
  `disallowedTools`, and `canUseTool` denies anything not on the allowlist regardless.
  What it has is six custom in-process tools (`createSdkMcpServer` + `tool()` from the agent
  SDK) in `AgentService` (`services/agent.ts`): `vault_list`/`vault_read`/`vault_search` off
  the read-only mount, `vault_write`/`vault_delete` through Obsidian's REST API (the mount
  can't be written), both through `VaultRepository` (`data/repositories/vault.ts`), and
  `web_fetch` through `WebService` (`data/connections/web.ts`), plus the SDK's `WebSearch`
  for research. Every path goes through `VaultRepository.safePath`: string containment
  (`isInsideRoot`) **and** a realpath check, so
  neither `../` nor a symlink inside the vault gets out. `web_fetch` is http(s) only,
  re-checks every redirect hop, and refuses anything resolving to a private address: the bot
  sits inside a LAN of unauthenticated services, so fetching must not become a way to read
  them. Writes and deletes stop for a Telegram ✅/❌ confirmation (`canUseTool` awaits the
  tap, 5-minute timeout defaulting to refusal). `COMMAND_MODEL` (default `claude-sonnet-5`)
  is separate from `AGENT_MODEL` — enrichment is a haiku-sized job, writing a note in the
  owner's voice is not. Style guidance lives in the system prompt, but the vault outranks
  it: the agent is told to read neighbouring notes first and to follow `internal/voice.md`
  if the vault has one.
- **Command mode never blocks on the agent.** `CommandService.handle` takes a message, gives it its own
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
  is flattened and cut to 330 chars (`clipUpdate` in `libs/text.ts`), then the message is re-rendered as
  `feedMessage(header, turn.feed)`. **Every line is prefixed with an emoji for what it is**
  — `toolIcon` per tool (📖 read, 🔍 search, ✍️ write, 🗑 delete, 🌐 fetch, 🔧 unknown) and
  `thoughtIcon` for the agent's own words, a keyword lookup so a glance says which part of
  the job it's on. Both are tables in `libs/feed.ts`: display must not cost a token or a round
  trip. When the feed would push the message past Telegram's cap, `fitFeed` drops lines off
  the **front** until it fits, and the trimmed tail is what's kept — a live view, not a
  transcript. Edits are throttled to one per `FEED_EDIT_MS` (1.2s, injectable for tests):
  the agent emits events far faster than a person reads and Telegram rate-limits edits, so
  updates coalesce, and the render is skipped when it would change nothing (Telegram
  rejects those). A pending edit checks `this.active === turn` before it lands, so a stale
  feed can never overwrite an answer that arrived first. Prose is held back until something
  follows it: what's left when the turn ends is the answer, which replaces the feed.
- **Everything about a turn is a Telegram reply to the message that prompted it** — its
  status message (feed and answer alike) and the ✅/❌ change confirmation, via the `replyTo`
  send option (`Chat` turns it into `reply_parameters`, with `allow_sending_without_reply`
  so a deleted prompt can't take its own answer down). With several turns in flight the
  chat reads as threads instead of one interleaved stream, so `Turn` carries the owner's
  `sourceId`. Every
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
  idle timer (`Modes.touch()`) does. On expiry `abandon` interrupts, tears the query down, answers
  that turn with `silentNotice`, and pumps the queue; the stop-grace path goes through the
  same `abandon`. A turn parked on a ✅/❌ confirmation is exempt (`pending.size`): it's
  waiting on the owner by design, so the timer re-arms instead of firing.
- **Tasks live in two vault notes, never in the DB.** A task is a checklist bullet under
  one heading per note — `## Other Tasks` in the work note, `## Things to do` in the
  personal one — tagged (`#type/todo/work`, `#type/todo`) and carrying `[start:: date]`
  (planned start, optional to say — a task given only a deadline starts on it, so both
  fields are always written) and `[due:: date]` (the deadline, mandatory), with
  `[completion:: date]` stamped on done. Paths, headings, tags and which end a new task
  goes on (work runs newest-first, personal is appended to) are all config. Only the two
  notes are the truth: created tasks are never mirrored into sqlite, so a task edited in
  Obsidian is still the task scriba lists and ticks. `domain/task/line.ts` is the pure
  half and is deliberately tolerant of what is really in those notes: the older
  `✅ 2026-03-02` done marker beside `[completion:: ]`, cancelled `- [-]` rows, a typo'd
  `[start::6-03-01]`, an empty description, and `[id:: ]`/`[dependsOn:: ]` fields it must
  leave untouched. `TaskNoteRepository` (`data/repositories/task-notes.ts`) is the I/O half:
  read-modify-write under the note lock (`ObsidianClient.updateNote`), bumping the note's `updatedAt` frontmatter.
- **A message never becomes a task directly.** Task mode (`/task`, closed by `/done` or 15
  minutes idle) turns each message into a *draft*, shown on a confirmation card whose
  buttons change the description, either date or the type; only ✅ Create writes the note,
  and it refuses a draft with no deadline and asks for one instead. Those questions are
  messages you reply to, and **only a question you opened by tapping a button gets a
  `force_reply`**. That flag points the compose box at the question the moment it arrives,
  which is fine right after a tap (you can't have been mid-message) and is how a jot gets
  sent as a date when the question arrived on its own — so a task suggested from a jot, a
  `/taskadd` line with no timing, and the nightly habit review ask without it, while the
  card's own buttons, the link wizard, the entry-size prompt and the menu's jot edit keep
  it. The habit review follows the same rule mid-flow: the question after a Yes/No tap
  grabs the compose box, the one after a typed answer doesn't. Each one is
  **deleted once its answer lands** — a question is
  scaffolding, not conversation, and the card already shows the answer. One that couldn't
  be read stays put (there would be nothing left to reply to), and settling a card clears
  whatever it still had open. The ids are held in memory (`TaskService`), like `JotService`'s status-message
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
  category, and the type button is one tap. That default holds for the model-read paths too:
  `/taskadd` and the jot suggestions may only push a task *towards* work, and anything else
  they answer — including nothing — lands on what the text itself says.
- **`/taskadd <line>` is the one-message version**, for when opening a mode is more
  ceremony than the task is worth. The line goes to the enricher rather than the cue-word
  parser (`Enricher.extractTask`): it reads messy phrasing, languages chrono has no rules
  for, and the seam between a description and its timing far better than word lookups can.
  The model still never does date arithmetic — it reports the author's own words and chrono
  resolves them, the same contract the jot suggestions follow — and a failed call falls back
  to `parseTaskDraft`, since a rougher split beats no task. What comes back is the same
  confirmation card, so a fast add is still nothing written until you tap ✅. Bare
  `/taskadd` asks for the line, and that question deletes itself once answered.
- **Task mode and command mode never run at once.** Both own the whole message stream, so
  neither opens over the other (`Modes`, `services/modes.ts`), and the single `/done` (its
  own view, `presentation/telegram/command/done.ts`, owned by neither mode) closes
  whichever is open.
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
  scheduler calls `TaskService.dailySummary`, which renders the `day` view (due today, still
  due from before, or starting today) through the same `TaskService.list` the lists use, so its
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
- **A jot that reads like a TIL gets a card, from the same enrichment call.** The enricher's
  JSON carries a `til` boolean beside `tasks` (optional coming back in, for the same Groq
  reason). `ProcessingService.tilWanted` applies the guards: the switch (`tilDetection` in
  `settings`, toggled from the task menu next to task spotting), a jot that is already in
  the TIL section (`jot.section === "til"`, which the `TIL` prefix sets at intake), and
  `JotRepository.tilOffered`, since each jot is asked once (`jots.til_offered`) and
  `/reprocess` must not raise the card again. The flag is set only after the card was sent,
  so a failed send can be offered again. The card comes after the entry is written, like a
  task card. `JotService.askTil` sends it and `tilView` (`presentation/telegram/til/tap.ts`,
  callbacks `ti:y|n:<jotId>`) answers it through `JotService.answerTil`; neither holds a
  draft: the jot id is all they need. ✅ calls `ObsidianClient.moveToTil`, which runs `moveAnchorLine` under
  the note lock: the line is cut out and inserted under `TIL_HEADING` untouched, so its
  `^anchor` still resolves for edit, undo and reprocess. A note with no TIL heading is not
  touched (the helper reports `heading` missing rather than appending at the end) and the
  card says so. A vault write that throws is logged and answered with an alert; the card
  keeps its buttons, since a reprocess never asks again and another tap is the retry. The
  quoted jot is cut to 600 characters (`clipUpdate`) so the card always fits Telegram. After a move the leader's and every squashed follower's `section` becomes
  `til`, so the re-append fallbacks write the line back under TIL, not Journal.
- **Undo is a button on the finished status message.** A jot that reaches `done` (and any
  later edit that leaves it there) carries an ↩️ Undo button: `un:<jotId>`, handled by
  `removeView` in `presentation/telegram/journal/remove.ts`, which calls
  `EditService.undo` (the same teardown as `/delete`) and then
  re-renders the status without a keyboard. Deleting a squashed leader marks its followers
  deleted too: they share the one anchor line that just went away.
  Both buttons stay tappable on old messages, so the jot's current state decides: Undo
  removes the line only while it is in the note (`done` or `abandoned`); on a jot sent back
  for processing since, the tap is answered with no toast and the message is re-rendered
  without its Undo button (any other button, such as Embed, stays). Delete acts now on a
  `done`, `abandoned` or `failed` jot and is queued like a `/delete` reply while the jot is
  `pending` or `processing`. A tap on a squashed follower resolves to its leader, since the
  two share one line.
- **Embeddable links are a choice, one tap either way.** When a finished line holds a URL
  Obsidian renders with `![](url)` (YouTube, tweets, external images; any other page needs
  an iframe, so it stays a link), its status message gets **🖼 Embed** next to Undo
  (`em:<jotId>:1`). The tap rewrites those URLs in the line to `![](url)` (a `[text](url)`
  keeps its text as alt), folds the change back into the source like any edit, and the
  button becomes **🔗 Plain link** (`em:<jotId>:0`) to reverse it. Plain is the default,
  so nothing waits on the answer. An edit re-reads the line and offers whichever toggle
  now applies (`EditService.embedFor`), since it can add, remove or embed a URL. Detection
  and rewrite are `embedOffer`/`setEmbeds` in
  `libs/jot.ts`, token-free; the enricher is told to leave URLs untouched so they survive.
- **Every failure is a decision, so it carries both buttons.** Any jot that fails gets
  **🔄 Retry** (`rt:<jotId>`, `retryView` calling `JotService.retry`: `resetForRetry` +
  requeue now) and **🗑 Delete** (`dl:<jotId>`, the same `removeView` as Undo, via
  `EditService.discard`) side by side, whether it is transient (still in the retry cycle),
  given up on, or thrown during intake (`bot.catch`, which is `errorHandler` in
  `presentation/telegram/errors.ts`). The pair is built by `statusKeyboard` (`libs/jot.ts`)
  from the `StatusButtons` flags `JotService.status()` takes. The transient case used to
  say nothing at all and leave the message on "✨ Weaving it into your journal…" until the
  sweep came round, which reads as stuck rather than waiting; it now posts `retryNotice`
  (`libs/jot.ts`) naming the attempt and how many are left. Giving up posts `gaveUpMessage`.
  Both quote the error escaped and capped, since an error can be a whole stack trace, and
  both go out through `ProcessingService.say`, which swallows a Telegram failure so a
  hiccup in the failure path can't throw out of `fail()` and abandon the rest of the
  batch. The two buttons guard each other: Retry refuses a jot that's already `deleted`,
  and Delete answers "already deleted" rather than tearing down twice. Retry also refuses a
  jot that is `processing` right now and answers "still processing": `resetForRetry` is a
  compare-and-swap like `claim()`, so a second tap, or one racing the retry pass, can't
  queue it twice. Like Delete, a Retry tap on a squashed follower acts on its leader.
  `/failed` lists the same pair per row.
- **Edits fold back into the source, so reprocess doesn't undo them.** Correcting a jot's
  line (reply `s/old/new/`, a freeform reply instruction, or Telegram's native message-edit)
  also writes the corrected text into the jot's own `transcript` (audio) or `raw_text`
  (text) field, not just the journal line — otherwise `/reprocess` re-transcribes/re-reads
  the original source and silently reverts the fix. Scoped to a standalone jot
  (`EditService.syncEditedSource`, `services/edits.ts`): a squashed leader/follower is skipped, since a
  squashed line is several jots' sources combined into one and there's no single field to
  fold the edit back into.
- **Rating a day opens a follow-up for what's still empty.** After a rating is saved,
  `RatingService` (`services/rating.ts`, with its views in `presentation/telegram/rating/`)
  asks "One line for the day?" when the `JOURNAL_HEADING`
  section has no content, then "Learned anything today?" when the `TIL_HEADING` section
  has none. `followupQuestions` (`domain/rating/entity.ts`) and `sectionHasContent`
  (`libs/note.ts`) decide, token-free, by
  reading the note: blank lines, empty bullets (`-`, `- [ ]`), rules and HTML comments are
  template scaffolding, and the frontmatter rating is never looked at. A day with no note
  asks both. No state is held: the prompt's text carries `(fu:j|t:<date>)` and a reply is
  routed by it (`parseFollowupRef` in `libs/followup.ts`),
  while the note says what is still empty, so an
  answer works after a restart and an unanswered question costs nothing. Each question has
  a ⏭ Skip button (`fu:<j|t>:<date>`) and, since an inline keyboard and `force_reply` can't
  share a message, no force-reply: you swipe-reply, and any message that isn't a reply is a
  normal jot. Answered or skipped, the prompt is deleted and the next one is asked. Both
  answers go through `JotService.intake` as text jots, filed under the rated day (`day`:
  that day's last second when it isn't today), so they enrich, edit and undo like any jot.
  The `day` override moves only the date, time and note path: a jot carrying it never
  squashes, since every answer to one day shares that last-second stamp and would otherwise
  fold into the one before. The TIL answer is sent as `TIL: <text>`, which `stripTilPrefix`
  turns into a jot in the TIL section at intake, so it lands under `TIL_HEADING`. A journal
  answer that itself starts with "til" is routed the same way.
- **The nightly rating and its follow-up have their own switches and a runtime time.** Three
  `settings` rows, changed from `/menu` (root screen): `nightlyRating` and `nightlyFollowup`
  (`on`/`off`, unset is on, the `switch` entries of `SETTINGS` in `domain/setting/entity.ts`)
  and `ratingTime` (`HH:MM`, unset falls back to `RATING_TIME`, `SettingsRepository.ratingTime`).
  The time is typed after a force-reply prompt
  (`WIZARD_RATING_TIME_REF`) and checked by `parseClockTime`, which takes 24-hour `H:MM` or
  `HH:MM` and answers anything else with a message. `Scheduler` reads the rating job's time
  from that row: `SettingsService.setRatingTime` calls `Scheduler.rearm("rating")`, which
  moves the timer at once when running, and the job (`RatingService.nightly`)
  reads the `nightlyRating` row each time it fires, skipping when it is off. The next night
  is armed before the prompt runs (`armBeforeRun`), so a prompt that hangs or throws can't
  stop later ones. A Skip tap is claimed in memory by message id (`RatingService.claimSkip`)
  before its first await, so a double
  tap asks the next question once, and a tap whose message is gone is only acknowledged.
  The menu toggles keep their setting when the ack or the redraw fails.
  `ratingDay` picks the day to rate: before 12:00 the firing is just after midnight, so
  yesterday, otherwise today. The follow-up reads its own row in
  `RatingService.startFollowup`, so a
  rating that is off never reaches it. The switches govern the nightly prompt only: `/rate`
  and the menu's Rate today still ask, and their follow-up follows its own switch.
- **Connection health never spends a token.** `HealthMonitor` (`services/health.ts`) probes
  every upstream once a minute, all at once, with a 5s timeout each: Anthropic and
  Telegram at their bare host, Groq and OpenCode at `/models` with their key (skipped when
  there is no key), Obsidian at its REST root through the client's own TLS dispatcher, and
  Parakeet at the `/models` listing next to its transcription URL (`modelsUrlFor`). A
  probe is a GET with no body, and `upstreams()` is the only place the URLs are built, so
  `health.test.ts` fails if one of them ever points at a completions, messages or audio
  endpoint. Two failed probes in a row mark an upstream down, one success brings it back,
  and each transition is one Telegram notice. An upstream probed with a key needs a 2xx:
  Groq answers a bad key with 401, while OpenCode's listing doesn't check the key, so
  there a 2xx only proves the host answers. The rest count any HTTP answer. `/status`
  lists the snapshot through `formatHealth` (`libs/admin.ts`).

## Conventions

- Conventional Commits. No gitmoji. No AI attribution in commits or PRs.
- Elastic License 2.0.
- Migrations are knex files under `migrations/`; the app runs `migrate.latest()` at boot
  (`openDb`, `data/connections/sqlite.ts`).
- Run TypeScript via tsx. Do NOT rely on Node's strip-only mode (it can't do parameter
  properties, which the classes use).
- **Log thoroughly.** Every command, handler, and side-effecting method logs via
  `logger("<scope>")` from `src/libs/log.ts`, never a bare `console`. Log the entry point and
  each branch that matters: `info` for normal milestones (command invoked, action taken),
  `warn` for rejected/invalid input, `error` (with `{ err }`) for failures, `debug` for
  raw payloads. A new command or feature without logs on its happy path AND its rejection
  paths is incomplete. Secrets are stripped in pino core via `redact` in `src/libs/log.ts`
  (`*.token`/`*.key`/`*.groqApiKey`/`*.opencodeApiKey`); log config objects freely, but
  add a path there if you introduce a secret with a different field name. A secret inside
  a string (a failed Telegram request's error carries the `bot<token>` URL) is out of
  `redact`'s reach, so the `streamWrite` hook there scrubs the Telegram token from every
  finished line; a new secret that can end up in an error message needs a pattern there.
- **Slash commands are discoverable.** A new command goes into `COMMANDS`
  (`presentation/telegram/commands.ts`). `publishCommands` sends that list to
  `setMyCommands` at start, so it shows in Telegram's `/` menu, and `/help` lists the ones
  marked `admin`.
- **Tests sit next to the source** as `<name>.test.ts`, one per file. Exceptions:
  - The slash commands share `src/presentation/telegram/commands.test.ts`: they're one file
    each but one surface (the `COMMANDS` registry `registerViews` loops over), so the
    registry's shape and the admin views are checked together.
  - Tests that drive the whole bot sit at `src/`: `bot.routing.test.ts`,
    `bot.callbacks.test.ts` and `ack-ledger.test.ts` run updates through the app
    `createScriba` builds, via `botHarness` (`src/test/bot-harness.ts`). `app.test.ts`,
    `index.test.ts`, `config.test.ts` and `migrations.test.ts` sit there too.
- **Shared test helpers live in `src/test/`**: `fakes.ts` (`FakeSettings`, `recordingApi`),
  `sqlite.ts` (`withDb`, `tempDbPath`, `sampleJot`), `config.ts` (`testConfig`),
  `note-ops.ts` and `bot-harness.ts`. Reuse them before writing a new fake. Prefer a real
  collaborator over a mock where one is cheap: `data/repositories/notes.test.ts` runs
  `ObsidianClient` against a loopback HTTP server rather than stubbing `fetch`, which is
  what lets it test the write-lock and the daily-note dedupe; `libs/log.test.ts` reads
  redaction back out of a child process, since pino writes to fd 1.
- **Coverage only goes up.** CI (`.github/workflows/ci.yml`) runs `npm run test:coverage`,
  which fails below 98% lines or 92% branches, leaving out `src/index.ts`, `src/test/**`
  and the test files. Those floors in `package.json` are a ratchet: when a change raises
  coverage, raise them, and never lower them to get a change through.

## Local checks

Node comes from mise: `mise.toml` pins Node 24 (the deploy runtime), so run the commands
inside `mise exec --` (or a shell with mise activated).

```sh
npm install              # under Node 24 better-sqlite3's addon builds
npm test                 # node --import tsx --test, the full suite incl. the DB roundtrip
npm run test:coverage    # the same suite with the coverage floors CI enforces
npm run typecheck        # tsc --noEmit
npx @biomejs/biome ci .  # lint + format check, no writes (what CI runs)
npm run check            # biome check --write, the fix-up version
npm run dev              # run the bot in watch mode (reads process.env, not .env)
```

> With Node 24 the native addon builds and the whole suite runs locally. If an
> `allow-scripts` gate blocks the addon during install, run `npm rebuild better-sqlite3`
> once. The DB roundtrip test (`data/repositories/index.test.ts`) still self-skips on any
> Node where the addon can't build (e.g. an un-pinned Node 26). lefthook runs
> `biome check --write` on staged files before each commit.
