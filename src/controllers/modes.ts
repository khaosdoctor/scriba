import { logger } from "../lib/log.ts";
import type { Notifier } from "../models/ops.ts";

const log = logger("modes");

/** Sticky modes own the message stream, so one is open at a time. */
export type Mode = "task";

export type OpenOutcome = "opened" | "already" | "busy";

const TIMEOUT_NOTICE: Record<Mode, string> = {
  task: "📝 Task mode timed out — back to journaling.",
};

/** Idle time after which a mode closes itself, so it can't swallow the next thing meant
 *  for the journal. */
const IDLE_MS = 15 * 60_000;

export class Modes {
  private active?: Mode;
  private timer?: NodeJS.Timeout;

  constructor(
    private notifier: Pick<Notifier, "notify">,
    private commandOpen: () => boolean,
    private idleMs = IDLE_MS,
  ) {}

  isOpen(mode: Mode): boolean {
    return this.active === mode;
  }

  open(mode: Mode): OpenOutcome {
    if (this.commandOpen()) return "busy";
    if (this.active === mode) {
      log.info(`${mode} mode already open`);
      return "already";
    }
    this.active = mode;
    this.touch();
    log.info(`${mode} mode opened`);
    return "opened";
  }

  close(): void {
    if (this.active) log.info(`${this.active} mode closed`);
    this.active = undefined;
    clearTimeout(this.timer);
  }

  /** Restart the idle countdown of the open mode. */
  touch(): void {
    clearTimeout(this.timer);
    const mode = this.active;
    if (!mode) return;
    this.timer = setTimeout(() => {
      log.info(`${mode} mode idle — closing`);
      this.close();
      void this.notifier.notify(TIMEOUT_NOTICE[mode]).catch(() => {});
    }, this.idleMs);
    this.timer.unref();
  }
}
