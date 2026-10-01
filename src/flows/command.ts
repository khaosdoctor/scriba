import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { type Bot, InlineKeyboard } from "grammy";
import { config } from "../config.ts";
import {
  clipUpdate,
  escapeHtml,
  feedMessage,
  fitFeed,
  fitTelegram,
  formatToolCall,
  makeJotId,
  queuedNotice,
  silentNotice,
  thoughtIcon,
  toolIcon,
} from "../core.ts";
import { logger } from "../log.ts";
import { type AgentService, PromptStream } from "../services/agent.ts";

const log = logger("command");

export const COMMAND_NS = "cm";

/** How long a pending write/delete confirmation waits for a tap before it's refused. */
const CONFIRM_TTL_MS = 5 * 60_000;
/** A session with no message for this long closes itself, so `/command` can't be left open
 *  by accident and swallow the next thing you meant to jot. Any sign of life — a message,
 *  or the agent doing something — restarts the countdown, so a long run can't be cut off. */
const SESSION_TTL_MS = 15 * 60_000;
/** An interrupt normally ends the turn within a second or two. If the agent hasn't come
 *  back by this point, the query is torn down and rebuilt so the session isn't wedged. */
const STOP_GRACE_MS = 20_000;
/** Minimum gap between edits of a turn's status message. Telegram rate-limits edits, and
 *  the agent emits events far faster than a person reads them. */
const FEED_EDIT_MS = 1_200;
/** A running turn that produces nothing at all for this long is treated as dead. A query
 *  can stop yielding without ever ending — a CLI subprocess that dies without closing its
 *  stream, a call retrying forever — and without this the session wedges: `active` never
 *  clears, so every later prompt queues behind a turn that will never finish. */
const TURN_SILENCE_MS = 5 * 60_000;

const WORKING = "🧭 Working…";

/** What the tap on a confirmation resolves to. */
type Verdict = "allow" | "deny";

/** One prompt in flight. Its status message is also its answer: it starts as "Working…"
 *  (or "Queued") with a Stop button and is edited in place when the turn settles, so a
 *  reply always lands under the message that asked for it. Everything else the assistant
 *  says about the turn — reasoning, tool calls, confirmations — is a Telegram reply to
 *  `sourceId`, so several turns in flight stay in separate threads. */
type Turn = {
  id: string;
  prompt: string;
  /** The chat, and the owner's message that asked for this. */
  chatId: number;
  sourceId?: number;
  /** The status message, which carries the live feed and then becomes the answer. */
  messageId?: number;
  /** The tail of what the agent has done on this turn, newest last. */
  feed: string[];
  /** What that message currently shows, so an edit that changes nothing is skipped —
   *  Telegram rejects those outright. */
  rendered?: string;
  state: "queued" | "running" | "stopping";
};

/**
 * `/command` — a sticky agent session over the vault. Every message while it's open goes to
 * the agent instead of becoming a jot; `/done` closes it. Writes and deletes stop for a
 * Telegram confirmation before they touch the vault.
 *
 * Nothing here blocks on the agent. A message is accepted, given its own status message and
 * queued in the same breath; the agent runs in the background against a long-lived query and
 * relays what it's doing — reasoning, tool calls, prose written along the way — to the chat
 * as it happens. Each answer is edited into the status message of the prompt that asked for
 * it, so several in-flight messages stay legible.
 */
export class CommandSession {
  private open = false;
  private sessionId?: string;
  private idleTimer?: NodeJS.Timeout;
  private pending = new Map<
    string,
    { decide: (v: Verdict) => void; timer: NodeJS.Timeout }
  >();
  /** Prompts waiting their turn, oldest first. */
  private queue: Turn[] = [];
  /** The prompt the agent is answering right now, if any. */
  private active?: Turn;
  /** Assistant prose since the last relayed update — the answer-in-progress. */
  private text = "";
  private stream?: PromptStream;
  private agent?: Query;
  private runner?: Promise<void>;
  /** Identity of the query currently in charge. A query that was torn down still has an
   *  exit to report, and it must not touch state a newer one has already taken over. */
  private runToken?: object;
  /** Telegram sends are chained rather than awaited: the agent must never stall behind a
   *  slow API call, but the chat still has to read in the order things happened. */
  private sends: Promise<void> = Promise.resolve();
  /** The pending feed edit, and the earliest moment the one after it may go out. */
  private feedTimer?: NodeJS.Timeout;
  private feedAfter = 0;
  /** Fires when the running turn has been silent too long. */
  private turnTimer?: NodeJS.Timeout;
  /** Whether the other message-stream mode (task mode) is open — see setBusyCheck. */
  private otherModeOpen: () => boolean = () => false;

  constructor(
    private bot: Bot,
    private service: AgentService,
    /** Minimum gap between edits of the live status message. */
    private feedEditMs = FEED_EDIT_MS,
    /** How long a running turn may produce nothing before it's given up on. */
    private turnSilenceMs = TURN_SILENCE_MS,
  ) {}

  isOpen(): boolean {
    return this.open;
  }

  /** Task mode owns the message stream too, so the two never run at once. Late-wired:
   *  TaskController is built after this session (see ScribaBot). */
  setBusyCheck(fn: () => boolean): void {
    this.otherModeOpen = fn;
  }

  async start(ctx: any): Promise<void> {
    if (this.otherModeOpen()) {
      log.warn("command mode refused — task mode is open");
      return void ctx.reply(
        "📝 Task mode is open. Send /done to close it first, then /command.",
      );
    }
    if (!this.service.enabled) {
      log.warn("command mode unavailable — no vault path configured");
      return void ctx.reply(
        "⚠️ command mode needs SCRIBA_VAULT_HOST_PATH — the vault isn't mounted.",
      );
    }
    this.open = true;
    this.sessionId = undefined; // a fresh session each time /command is opened
    this.touch();
    log.info("command session opened");
    await ctx.reply(
      [
        "🧭 Command mode is on.",
        "",
        "Everything you send now goes to the vault assistant instead of your journal. It can create, refresh and delete notes, and research on the web first. I'll ask before anything is written or deleted.",
        "",
        "Keep talking while it works — every message is taken straight away and answered under itself, in the order they arrive. You'll see what the assistant is thinking and which tools it reaches for as it goes, and ⏹ Stop cuts a message off mid-thought.",
        "",
        "Send /done when you're finished.",
      ].join("\n"),
    );
  }

  /** Close the session. `/done` is registered by ScribaBot, which routes it to whichever
   *  mode is actually open. */
  async finish(ctx: any): Promise<void> {
    if (!this.open) return void ctx.reply("Command mode isn't open.");
    this.close();
    log.info("command session closed");
    await ctx.reply("🧭 Command mode off — back to journaling.");
  }

  private close(): void {
    this.open = false;
    this.sessionId = undefined;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.clearWatchdog();
    this.denyPending();
    // Whatever was still in flight is answered with the reason it never will be, so no
    // message is left sitting under a spinner.
    const stranded = [...this.queue];
    this.queue = [];
    const running = this.active;
    this.active = undefined;
    if (running)
      this.settle(running, "🧭 Command mode closed — this one stopped.");
    for (const t of stranded)
      this.settle(t, "🧭 Command mode closed — this one never ran.");
    this.teardown();
  }

  /** Drop the current query: close its input so the generator returns, interrupt whatever
   *  turn is mid-flight so the CLI doesn't keep working for nobody, and forget it — its
   *  eventual exit is bookkeeping the caller has already dealt with. */
  private teardown(): void {
    this.runToken = undefined;
    this.runner = undefined;
    this.text = "";
    const stream = this.stream;
    this.stream = undefined;
    const agent = this.agent;
    this.agent = undefined;
    stream?.end();
    void agent
      ?.interrupt()
      .catch((err) => log.debug({ err }, "command: interrupt on teardown"));
  }

  /** Refuse every outstanding write/delete confirmation. */
  private denyPending(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.decide("deny");
    }
    this.pending.clear();
  }

  /** Restart the idle countdown — the session shouldn't outlive your attention. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.open) return;
      log.info("command session idle — closing");
      this.close();
      void this.bot.api
        .sendMessage(
          config.telegram.allowedUserId,
          "🧭 Command mode timed out — back to journaling.",
        )
        .catch(() => {});
    }, SESSION_TTL_MS);
    this.idleTimer.unref?.();
  }

  /**
   * Take one message from the owner. Called by ScribaBot for text while the session is
   * open. Returns as soon as the status message is up — never waits on the agent, so the
   * next message is accepted while this one is still being answered.
   */
  async handle(ctx: any, prompt: string): Promise<void> {
    this.touch();
    const turn: Turn = {
      id: makeJotId(),
      prompt,
      state: "queued",
      feed: [],
      chatId: ctx.chat?.id ?? config.telegram.allowedUserId,
      sourceId: ctx.message?.message_id,
    };
    // Queued before the await, so two messages sent in quick succession keep their order
    // even though grammy runs their handlers concurrently.
    const ahead = this.queue.length + (this.active ? 1 : 0);
    this.queue.push(turn);
    log.info(
      { turn: turn.id, chars: prompt.length, ahead },
      "command: prompt accepted",
    );
    const head = ahead ? queuedNotice(ahead) : WORKING;
    const msg = await ctx
      .reply(head, {
        reply_markup: this.stopKeyboard(turn),
        ...replyParams(turn),
      })
      .catch((err: unknown) => {
        log.warn({ err, turn: turn.id }, "command: status message failed");
        return null;
      });
    if (msg) {
      turn.chatId = msg.chat.id;
      turn.messageId = msg.message_id;
      turn.rendered = head;
      // It may have been promoted while the send was in flight; say so.
      if (ahead && turn.state !== "queued") this.setStatus(turn, WORKING);
    }
    this.pump();
  }

  /** Hand the next queued prompt to the agent, if it's free. */
  private pump(): void {
    if (!this.open || this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    next.state = "running";
    this.text = "";
    this.ensureAgent();
    this.setStatus(next, WORKING);
    this.stream?.push(next.prompt);
    this.armWatchdog(next);
    log.info({ turn: next.id }, "command: prompt handed to the agent");
  }

  /**
   * Restart the silence timer for the running turn. Only the agent's own events count as
   * alive here — deliberately not the owner's messages, which `touch()` handles. A turn
   * that has died quietly must not be kept "alive" by the very messages piling up behind
   * it, which is exactly what the session's idle timer would otherwise do.
   */
  private armWatchdog(turn: Turn): void {
    this.clearWatchdog();
    this.turnTimer = setTimeout(() => {
      if (this.active !== turn) return;
      // Waiting on a ✅/❌ tap is the owner's move to make, not the agent's: the run is
      // paused on purpose, so the clock starts again rather than running out.
      if (this.pending.size) return this.armWatchdog(turn);
      log.error(
        { turn: turn.id, silentMs: this.turnSilenceMs },
        "command: turn produced nothing for too long — giving up on it",
      );
      this.abandon(turn, silentNotice(this.turnSilenceMs));
    }, this.turnSilenceMs);
    this.turnTimer.unref?.();
  }

  private clearWatchdog(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = undefined;
  }

  /** Give up on the running turn: drop the query, answer that turn, and let the queue
   *  move. The next prompt opens a fresh query with `resume`, so the conversation itself
   *  survives — only this turn is lost. */
  private abandon(turn: Turn, text: string): void {
    if (this.active !== turn) return;
    this.active = undefined;
    this.clearWatchdog();
    this.teardown();
    this.settle(turn, text);
    this.pump();
  }

  /** Start the long-lived query if there isn't one. It stays open for the whole session:
   *  the conversation lives inside it, and prompts are fed in as they come. */
  private ensureAgent(): void {
    if (this.runner) return;
    const stream = new PromptStream();
    const token = {};
    this.stream = stream;
    this.runToken = token;
    log.info(
      { resume: this.sessionId ?? null },
      "command: opening an agent query",
    );
    this.runner = (async () => {
      try {
        await this.consume(stream);
        this.afterRun(null, token);
      } catch (err) {
        log.error({ err }, "command: agent query failed");
        this.afterRun(err, token);
      }
    })();
  }

  /**
   * The query ended — interrupted, exhausted, or crashed. Settle whatever it was working
   * on and, if the session is still open with prompts waiting, open a fresh query: the
   * session id resumes the same conversation, so nothing is forgotten.
   */
  private afterRun(err: unknown, token: object): void {
    if (this.runToken !== token) {
      // Torn down and replaced already (a stop that timed out, or /done): whatever this
      // query was working on has been answered by whoever replaced it.
      log.info("command: a superseded query ended");
      return;
    }
    const stranded = this.active;
    this.active = undefined;
    this.clearWatchdog();
    this.runner = undefined;
    this.runToken = undefined;
    this.agent = undefined;
    this.stream = undefined;
    if (stranded) {
      const partial = this.text.trim();
      const reason =
        stranded.state === "stopping"
          ? "⏹ Stopped."
          : err
            ? `⚠️ ${err instanceof Error ? err.message : String(err)}`
            : "⚠️ the assistant stopped early.";
      this.settle(stranded, partial ? `${reason}\n\n${partial}` : reason);
    }
    this.text = "";
    log.info(
      { stranded: stranded?.id ?? null, waiting: this.queue.length },
      "command: agent query ended",
    );
    this.pump();
  }

  private async consume(stream: PromptStream): Promise<void> {
    const q = await this.service.startQuery({
      prompt: stream,
      resume: this.sessionId,
      confirm: ({ kind, path, content }) =>
        this.confirm(
          `${kind === "delete" ? "🗑 Delete" : "✏️ Write"} <code>${escapeHtml(path)}</code>?`,
          content,
        ),
    });
    this.agent = q;
    for await (const msg of q as AsyncIterable<any>) this.onMessage(msg);
  }

  /** One message off the agent's stream. Everything the agent does becomes a line in the
   *  chat as it happens; the prose it writes is held back, because that's the answer. */
  private onMessage(msg: any): void {
    this.touch(); // a working agent is a live session, however quiet the owner is
    if (this.active) this.armWatchdog(this.active); // …and it's visibly still working
    if (msg.type === "assistant") {
      for (const b of msg.message?.content ?? []) {
        if (b.type === "text") this.text += b.text;
        else if (b.type === "thinking" || b.type === "redacted_thinking") {
          this.flushText();
          const thought = b.thinking ?? "(thinking)";
          this.update(`${thoughtIcon(thought)} ${thought}`);
        } else if (b.type === "tool_use") {
          this.flushText();
          this.update(
            `${toolIcon(b.name)} ${formatToolCall(b.name, b.input ?? {})}`,
          );
        }
      }
      return;
    }
    // Tool results are the agent's own reading material — only a failure is worth a line,
    // since that's what explains a sudden change of plan.
    if (msg.type === "user") {
      for (const b of msg.message?.content ?? [])
        if (b.type === "tool_result" && b.is_error)
          this.update(`⚠️ ${blockText(b.content)}`);
      return;
    }
    if (msg.type === "result") this.onResult(msg);
  }

  /** A turn finished. Its text becomes the answer on the prompt that asked for it, and the
   *  next queued prompt goes in. */
  private onResult(msg: any): void {
    if (msg.session_id) this.sessionId = msg.session_id; // continue the thread
    const turn = this.active;
    this.active = undefined;
    this.clearWatchdog();
    const text =
      this.text.trim() || (typeof msg.result === "string" ? msg.result : "");
    this.text = "";
    if (turn) {
      const stopped = turn.state === "stopping";
      const gaveUp = msg.subtype && msg.subtype !== "success" && !text;
      const body = stopped
        ? text
          ? `⏹ Stopped.\n\n${text}`
          : "⏹ Stopped."
        : gaveUp
          ? `⚠️ the assistant gave up (${msg.subtype})`
          : text || "(no reply)";
      log.info(
        { turn: turn.id, chars: body.length, stopped, subtype: msg.subtype },
        "command: turn answered",
      );
      this.settle(turn, body);
    }
    this.pump();
  }

  /** Prose the agent wrote before doing something else is an aside, not the answer: relay
   *  it and clear, so what's left at the end is only the closing reply. */
  private flushText(): void {
    const text = this.text.trim();
    this.text = "";
    if (text) this.update(`${thoughtIcon(text)} ${text}`);
  }

  /** Relay one live line to the chat, hung off the message that prompted it. Silent — this
   *  is a running commentary, not a notification per thought. */
  private update(raw: string): void {
    const line = clipUpdate(raw);
    const turn = this.active;
    if (!line || !turn) return;
    log.debug({ line, turn: turn.id }, "command: agent update");
    turn.feed.push(line);
    // A live view, not a transcript: once the message would go past what Telegram
    // accepts, the oldest lines come off the front until it fits again.
    turn.feed = fitFeed(WORKING, turn.feed);
    this.scheduleFeed(turn);
  }

  /**
   * Show the feed on the turn's status message, at most one edit per `feedEditMs`. The
   * agent can emit several events a second and Telegram rate-limits edits, so updates are
   * coalesced: whatever the feed says when the timer fires is what goes out, and a later
   * line just rides the next edit. The last line always renders, because every line
   * schedules a timer if none is pending.
   */
  private scheduleFeed(turn: Turn): void {
    if (this.feedTimer) return; // already queued — it will pick up this line too
    const wait = Math.max(0, this.feedAfter - Date.now());
    this.feedTimer = setTimeout(() => {
      this.feedTimer = undefined;
      this.feedAfter = Date.now() + this.feedEditMs;
      // The turn may have settled while this waited; its answer is on that message now
      // and must not be overwritten by a stale feed.
      if (this.active === turn)
        this.setStatus(turn, feedMessage(WORKING, turn.feed));
    }, wait);
    this.feedTimer.unref?.();
  }

  /** Rewrite a turn's status message, keeping its Stop button. */
  private setStatus(turn: Turn, raw: string): void {
    if (!turn.chatId || !turn.messageId) return;
    const text = fitTelegram(raw);
    if (turn.rendered === text) return; // Telegram rejects an edit that changes nothing
    turn.rendered = text;
    const { chatId, messageId } = turn;
    this.send(() =>
      this.bot.api.editMessageText(chatId, messageId, text, {
        reply_markup: this.stopKeyboard(turn),
      }),
    );
  }

  /** Final word on a turn: its status message becomes the answer and loses its button. If
   *  that message is gone, the answer is sent fresh — still as a reply to the prompt, so
   *  it can't end up orphaned at the bottom of the chat. */
  private settle(turn: Turn, text: string): void {
    const body = fitTelegram(text);
    const { chatId, messageId } = turn;
    const fresh = () =>
      this.bot.api.sendMessage(chatId, body, replyParams(turn));
    this.send(async () => {
      if (messageId)
        await this.bot.api
          .editMessageText(chatId, messageId, body, {
            reply_markup: new InlineKeyboard(),
          })
          .catch(fresh);
      else await fresh();
    });
  }

  /** Chain a Telegram call behind the ones before it: ordered, but never awaited by the
   *  agent loop. A failed send is logged and dropped — it must not break the chain. */
  private send(fn: () => Promise<unknown>): void {
    this.sends = this.sends.then(fn).then(
      () => {},
      (err) => log.warn({ err }, "command: telegram send failed"),
    );
  }

  private stopKeyboard(turn: Turn): InlineKeyboard {
    return new InlineKeyboard().text("⏹ Stop", `${COMMAND_NS}:s:${turn.id}`);
  }

  /** Ask in Telegram and wait for the tap. Times out into a refusal. Asked as a reply to
   *  the prompt that led here, so it's obvious which request wants the change. */
  private confirm(question: string, preview: string): Promise<boolean> {
    const turn = this.active;
    return new Promise<boolean>((resolvePromise) => {
      const id = makeJotId();
      const kb = new InlineKeyboard()
        .text("✅ Do it", `${COMMAND_NS}:y:${id}`)
        .text("❌ No", `${COMMAND_NS}:n:${id}`);
      const body = preview
        ? `${question}\n<blockquote>${escapeHtml(preview.slice(0, 600))}${preview.length > 600 ? "\n…" : ""}</blockquote>`
        : question;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        log.warn({ id }, "command: confirmation timed out");
        resolvePromise(false);
      }, CONFIRM_TTL_MS);
      timer.unref?.();
      this.pending.set(id, {
        decide: (v) => resolvePromise(v === "allow"),
        timer,
      });
      void this.bot.api
        .sendMessage(
          turn?.chatId ?? config.telegram.allowedUserId,
          fitTelegram(body),
          { parse_mode: "HTML", reply_markup: kb, ...replyParams(turn) },
        )
        .catch((err) => {
          log.error({ err }, "command: could not ask for confirmation");
          clearTimeout(timer);
          this.pending.delete(id);
          resolvePromise(false);
        });
    });
  }

  /** `cm:y|n:<id>` for a change confirmation, `cm:s:<turnId>` for a Stop button — routed in
   *  from views/callbacks. */
  async handleTap(ctx: any, rest: string[]): Promise<void> {
    const [verdict, id] = rest;
    if (verdict === "s") return this.handleStop(ctx, id);
    const entry = id === undefined ? undefined : this.pending.get(id);
    if (entry === undefined || id === undefined)
      return void ctx.answerCallbackQuery({ text: "expired" });
    clearTimeout(entry.timer);
    this.pending.delete(id);
    const allowed = verdict === "y";
    await ctx.answerCallbackQuery({ text: allowed ? "doing it" : "skipped" });
    await ctx
      .editMessageText(
        `${ctx.callbackQuery.message?.text ?? ""}\n${allowed ? "✅ approved" : "❌ declined"}`,
        { reply_markup: new InlineKeyboard() },
      )
      .catch(() => {});
    entry.decide(allowed ? "allow" : "deny");
  }

  /**
   * ⏹ Stop on a turn's status message. The one being answered is interrupted mid-thought
   * (and any confirmation it was waiting on is refused, since nothing will read the
   * answer); one still in the queue is simply dropped before it ever runs.
   */
  private async handleStop(ctx: any, id?: string): Promise<void> {
    const turn =
      id === undefined
        ? undefined
        : this.active?.id === id
          ? this.active
          : this.queue.find((t) => t.id === id);
    if (!turn) {
      log.warn({ turn: id ?? null }, "command: stop for an unknown turn");
      return void ctx.answerCallbackQuery({ text: "nothing to stop" });
    }
    if (turn !== this.active) {
      this.queue = this.queue.filter((t) => t !== turn);
      log.info({ turn: turn.id }, "command: queued prompt dropped");
      await ctx.answerCallbackQuery({ text: "dropped" });
      return this.settle(turn, "⏹ Dropped before it started.");
    }
    turn.state = "stopping";
    log.info({ turn: turn.id }, "command: stopping the agent");
    await ctx.answerCallbackQuery({ text: "stopping…" });
    this.denyPending(); // a confirmation nobody is waiting on any more
    const agent = this.agent;
    await agent
      ?.interrupt()
      .catch((err) => log.warn({ err }, "command: interrupt failed"));
    // The interrupt normally comes back as a result and settles the turn there. If it
    // doesn't, drop the query outright: the next prompt opens a new one and resumes the
    // same conversation, which beats a session wedged on a turn nobody wants.
    const guard = setTimeout(() => {
      if (this.active !== turn) return;
      log.warn({ turn: turn.id }, "command: interrupt timed out — restarting");
      this.abandon(turn, "⏹ Stopped.");
    }, STOP_GRACE_MS);
    guard.unref?.();
  }
}

/**
 * Hang a message off the one that prompted it. Everything the assistant says about a turn —
 * its status message, its reasoning, its tool calls, its confirmations, its answer — replies
 * to the owner's own message, so a chat with several turns in flight reads as threads rather
 * than one interleaved stream. `allow_sending_without_reply` keeps the message going out
 * even if the original was deleted meanwhile: losing the thread beats losing the message.
 */
function replyParams(turn: Turn | undefined) {
  return turn?.sourceId
    ? {
        reply_parameters: {
          message_id: turn.sourceId,
          allow_sending_without_reply: true,
        },
      }
    : {};
}

/** A tool result's content is either a string or the usual array of blocks. */
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "tool failed";
  return (
    content
      .map((b: any) => (typeof b?.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join(" ") || "tool failed"
  );
}
