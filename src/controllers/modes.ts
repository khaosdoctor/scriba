import { logger } from "../lib/log.ts";
import type { Notifier } from "../models/ops.ts";

const log = logger("modes");

/** Sticky modes own the message stream, so one is open at a time. */
export type Mode = "task" | "command";

export type OpenOutcome = "opened" | "already" | "busy";

const TIMEOUT_NOTICE: Record<Mode, string> = {
  task: "📝 Task mode timed out — back to journaling.",
  command: "🧭 Command mode timed out — back to journaling.",
};

/** Idle time after which a mode closes itself, so it can't swallow the next thing meant
 *  for the journal. */
const IDLE_MS = 15 * 60_000;

export class Modes {
  private active?: { mode: Mode; onClose?: () => void };
  private timer?: NodeJS.Timeout;

  constructor(
    private notifier: Pick<Notifier, "notify">,
    private idleMs = IDLE_MS,
  ) {}

  current(): Mode | undefined {
    return this.active?.mode;
  }

  isOpen(mode: Mode): boolean {
    return this.active?.mode === mode;
  }

  /** `onClose` runs when the mode closes, by /done or by idling out. */
  open(mode: Mode, onClose?: () => void): OpenOutcome {
    if (this.active && this.active.mode !== mode) return "busy";
    if (this.active) {
      log.info(`${mode} mode already open`);
      return "already";
    }
    this.active = { mode, onClose };
    this.touch();
    log.info(`${mode} mode opened`);
    return "opened";
  }

  close(): void {
    const open = this.active;
    this.active = undefined;
    clearTimeout(this.timer);
    if (!open) return;
    log.info(`${open.mode} mode closed`);
    open.onClose?.();
  }

  /** Restart the idle countdown of the open mode. */
  touch(): void {
    clearTimeout(this.timer);
    const mode = this.active?.mode;
    if (!mode) return;
    this.timer = setTimeout(() => {
      log.info(`${mode} mode idle — closing`);
      this.close();
      void this.notifier.notify(TIMEOUT_NOTICE[mode]).catch(() => {});
    }, this.idleMs);
    this.timer.unref();
  }
}
