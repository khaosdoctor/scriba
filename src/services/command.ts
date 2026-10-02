import type { Query } from "../data/connections/anthropic.ts";
import {
  clipUpdate,
  feedMessage,
  fitFeed,
  formatToolCall,
  queuedNotice,
  silentNotice,
  thoughtIcon,
  toolIcon,
} from "../libs/feed.ts";
import { makeJotId } from "../libs/jot.ts";
import { logger } from "../libs/log.ts";
import { escapeHtml, fitTelegram } from "../libs/text.ts";
import { type AgentService, PromptStream } from "./agent.ts";
import type { Modes } from "./modes.ts";
import type { MessageOptions, Notifier } from "./notifier.ts";

const log = logger("command");

export const COMMAND_NS = "cm";

const CONFIRM_TTL_MS = 5 * 60_000;
/** An interrupt normally ends the turn within a second or two. If the agent hasn't come
 *  back by this point, the query is torn down and rebuilt so the session isn't wedged. */
const STOP_GRACE_MS = 20_000;
/** Minimum interval between edits of a turn's status message. Telegram rate-limits edits,
 *  and the agent emits events far faster than a person reads them. */
const FEED_EDIT_MS = 1_200;
/** A running turn that produces nothing at all for this long is treated as dead. A query
 *  can stop yielding without ever ending (a CLI subprocess that dies without closing its
 *  stream, a call retrying forever), and without this the session wedges: `active` never
 *  clears, so every later prompt queues behind a turn that will never finish. */
const TURN_SILENCE_MS = 5 * 60_000;

const WORKING = "🧭 Working…";
const NO_BUTTONS: MessageOptions["keyboard"] = { inline_keyboard: [] };

export type CommandOpen = "opened" | "already" | "busy" | "noVault";
export type Decision = (allow: boolean) => void;

export interface CommandDeps {
  service: Pick<AgentService, "enabled" | "startQuery">;
  notifier: Pick<Notifier, "send" | "edit">;
  modes: Modes;
}

type Turn = {
  id: string;
  prompt: string;
  sourceId?: number;
  messageId?: number;
  feed: string[];
  /** What that message currently shows, so an edit that changes nothing is skipped:
   *  Telegram rejects those outright. */
  rendered?: string;
  state: "queued" | "running" | "stopping";
};

export class CommandService {
  private sessionId?: string;
  private pending = new Map<
    string,
    { decide: Decision; timer: NodeJS.Timeout }
  >();
  private queue: Turn[] = [];
  private active?: Turn;
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
  private feedTimer?: NodeJS.Timeout;
  private feedAfter = 0;
  private turnTimer?: NodeJS.Timeout;

  constructor(
    private deps: CommandDeps,
    private feedEditMs = FEED_EDIT_MS,
    private turnSilenceMs = TURN_SILENCE_MS,
  ) {}

  isOpen(): boolean {
    return this.deps.modes.isOpen("command");
  }

  open(): CommandOpen {
    const { modes, service } = this.deps;
    if (modes.isOpen("task")) {
      log.warn("command mode refused — task mode is open");
      return "busy";
    }
    if (!service.enabled) {
      log.warn("command mode unavailable — no vault path configured");
      return "noVault";
    }
    if (modes.open("command", () => this.close()) === "already")
      return "already";
    return "opened";
  }

  private close(): void {
    this.sessionId = undefined;
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

  private denyPending(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.decide(false);
    }
    this.pending.clear();
  }

  async handle(prompt: string, sourceId?: number): Promise<void> {
    this.deps.modes.touch();
    const turn: Turn = {
      id: makeJotId(),
      prompt,
      state: "queued",
      feed: [],
      sourceId,
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
    const messageId = await this.deps.notifier
      .send(head, { keyboard: this.stopKeyboard(turn), replyTo: sourceId })
      .catch((err: unknown) => {
        log.warn({ err, turn: turn.id }, "command: status message failed");
        return undefined;
      });
    if (messageId !== undefined) {
      turn.messageId = messageId;
      turn.rendered = head;
      // It may have been promoted while the send was in flight; say so.
      if (ahead && turn.state !== "queued") this.setStatus(turn, WORKING);
    }
    this.pump();
  }

  private pump(): void {
    if (!this.isOpen() || this.active) return;
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
   * alive here, deliberately excluding the owner's messages, which the mode's idle timer
   * handles. A turn that has died quietly must not be kept "alive" by the very messages
   * piling up behind it, which is exactly what the idle timer would otherwise do.
   */
  private armWatchdog(turn: Turn): void {
    this.clearWatchdog();
    this.turnTimer = setTimeout(() => {
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

  private abandon(turn: Turn, text: string): void {
    if (this.active !== turn) return;
    this.active = undefined;
    this.clearWatchdog();
    this.teardown();
    this.settle(turn, text);
    this.pump();
  }

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
    const q = await this.deps.service.startQuery({
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

  private onMessage(msg: any): void {
    // A working agent is a live session, however quiet the owner is…
    if (this.isOpen()) this.deps.modes.touch();
    if (this.active) this.armWatchdog(this.active); // …and it's visibly still working
    if (msg.type === "assistant") {
      for (const b of msg.message?.content ?? []) {
        if (b.type === "text") {
          this.text += b.text;
          continue;
        }
        if (b.type === "thinking" || b.type === "redacted_thinking") {
          this.flushText();
          const thought = b.thinking ?? "(thinking)";
          this.update(`${thoughtIcon(thought)} ${thought}`);
          continue;
        }
        if (b.type === "tool_use") {
          this.flushText();
          this.update(
            `${toolIcon(b.name)} ${formatToolCall(b.name, b.input ?? {})}`,
          );
        }
      }
      return;
    }
    if (msg.type === "user") {
      for (const b of msg.message?.content ?? [])
        if (b.type === "tool_result" && b.is_error)
          this.update(`⚠️ ${blockText(b.content)}`);
      return;
    }
    if (msg.type === "result") this.onResult(msg);
  }

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

  private flushText(): void {
    const text = this.text.trim();
    this.text = "";
    if (text) this.update(`${thoughtIcon(text)} ${text}`);
  }

  private update(raw: string): void {
    const line = clipUpdate(raw);
    const turn = this.active;
    if (!line || !turn) return;
    log.debug({ line, turn: turn.id }, "command: agent update");
    turn.feed.push(line);
    turn.feed = fitFeed(WORKING, turn.feed);
    this.scheduleFeed(turn);
  }

  private scheduleFeed(turn: Turn): void {
    if (this.feedTimer) return; // already queued, and it will pick up this line too
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

  private setStatus(turn: Turn, raw: string): void {
    if (!turn.messageId) return;
    const text = fitTelegram(raw);
    if (turn.rendered === text) return; // Telegram rejects an edit that changes nothing
    turn.rendered = text;
    const { messageId } = turn;
    this.send(() =>
      this.deps.notifier.edit(messageId, text, {
        keyboard: this.stopKeyboard(turn),
      }),
    );
  }

  private settle(turn: Turn, text: string): void {
    const body = fitTelegram(text);
    const { messageId, sourceId } = turn;
    const fresh = () => this.deps.notifier.send(body, { replyTo: sourceId });
    this.send(async () => {
      if (!messageId) return fresh();
      await this.deps.notifier
        .edit(messageId, body, { keyboard: NO_BUTTONS })
        .catch(fresh);
    });
  }

  /** Chain a Telegram call behind the ones before it: ordered, but never awaited by the
   *  agent loop. A failed send is logged and dropped; it must not break the chain. */
  private send(fn: () => Promise<unknown>): void {
    this.sends = this.sends.then(fn).then(
      () => {},
      (err) => log.warn({ err }, "command: telegram send failed"),
    );
  }

  private stopKeyboard(turn: Turn): MessageOptions["keyboard"] {
    return {
      inline_keyboard: [
        [{ text: "⏹ Stop", callback_data: `${COMMAND_NS}:s:${turn.id}` }],
      ],
    };
  }

  private confirm(question: string, preview: string): Promise<boolean> {
    const turn = this.active;
    return new Promise<boolean>((resolvePromise) => {
      const id = makeJotId();
      const keyboard: MessageOptions["keyboard"] = {
        inline_keyboard: [
          [
            { text: "✅ Do it", callback_data: `${COMMAND_NS}:y:${id}` },
            { text: "❌ No", callback_data: `${COMMAND_NS}:n:${id}` },
          ],
        ],
      };
      const body = preview
        ? `${question}\n<blockquote>${escapeHtml(preview.slice(0, 600))}${preview.length > 600 ? "\n…" : ""}</blockquote>`
        : question;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        log.warn({ id }, "command: confirmation timed out");
        resolvePromise(false);
      }, CONFIRM_TTL_MS);
      timer.unref?.();
      this.pending.set(id, { decide: resolvePromise, timer });
      void this.deps.notifier
        .send(fitTelegram(body), {
          html: true,
          keyboard,
          replyTo: turn?.sourceId,
        })
        .catch((err) => {
          log.error({ err }, "command: could not ask for confirmation");
          clearTimeout(timer);
          this.pending.delete(id);
          resolvePromise(false);
        });
    });
  }

  takeConfirmation(id?: string): Decision | undefined {
    const entry = id === undefined ? undefined : this.pending.get(id);
    if (entry === undefined || id === undefined) return undefined;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    return entry.decide;
  }

  async stop(
    id: string | undefined,
    ack: (toast: string) => Promise<void>,
  ): Promise<void> {
    const turn =
      this.active?.id === id
        ? this.active
        : this.queue.find((queued) => queued.id === id);
    if (!turn) {
      log.warn({ turn: id ?? null }, "command: stop for an unknown turn");
      return void ack("nothing to stop");
    }
    if (turn !== this.active) {
      this.queue = this.queue.filter((t) => t !== turn);
      log.info({ turn: turn.id }, "command: queued prompt dropped");
      await ack("dropped");
      return this.settle(turn, "⏹ Dropped before it started.");
    }
    turn.state = "stopping";
    log.info({ turn: turn.id }, "command: stopping the agent");
    await ack("stopping…");
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
