import { type Dispatcher, fetch } from "undici";
import { formatDuration, modelsUrlFor, type UpstreamStatus } from "../core.ts";
import { logger } from "../log.ts";

const log = logger("health");

/** One thing the bot depends on, probed with a plain GET. There is no method or body
 *  field on purpose: a probe must never be able to generate anything (and so never
 *  spend a token), which is why every URL is a bare host or a `/models` listing. */
export interface Upstream {
  name: string;
  url: string;
  headers?: Record<string, string>;
  /** Only a 2xx counts as up. Set where a key is sent, since a rejected key means that
   *  fallback is as dead as an unreachable host. Otherwise any HTTP answer counts. */
  requireOk?: boolean;
  dispatcher?: Dispatcher;
}

export interface HealthTargets {
  groqApiKey: string;
  opencodeApiKey: string;
  obsidianUrl: string;
  parakeetUrl: string;
}

/** The upstreams worth probing for this config. Groq and OpenCode are skipped without a
 *  key: nothing calls them then. `obsidian` is the Obsidian client's own dispatcher, so
 *  a self-signed cert is trusted exactly when the client trusts it. */
export function upstreams(t: HealthTargets, obsidian: Dispatcher): Upstream[] {
  const list: Upstream[] = [
    { name: "anthropic", url: "https://api.anthropic.com" },
    { name: "telegram", url: "https://api.telegram.org" },
    { name: "obsidian", url: `${t.obsidianUrl}/`, dispatcher: obsidian },
  ];
  if (t.groqApiKey)
    list.push({
      name: "groq",
      url: "https://api.groq.com/openai/v1/models",
      headers: { Authorization: `Bearer ${t.groqApiKey}` },
      requireOk: true,
    });
  if (t.opencodeApiKey)
    list.push({
      name: "opencode",
      url: "https://opencode.ai/zen/go/v1/models",
      headers: { Authorization: `Bearer ${t.opencodeApiKey}` },
      requireOk: true,
    });
  if (t.parakeetUrl)
    list.push({ name: "parakeet", url: modelsUrlFor(t.parakeetUrl) });
  return list;
}

/** A fetch error's own message says only "fetch failed"; the cause says why. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.cause instanceof Error) return `${err.message}: ${err.cause.message}`;
  return err.message;
}

/** Probes every upstream on a timer and keeps the latest status of each. A down
 *  upstream takes 2 failed probes in a row (one blip is not an outage), a recovery takes
 *  one success. Each transition is told to the owner once and handed to `onChange`. */
export class HealthMonitor {
  private state = new Map<string, UpstreamStatus>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private targets: Upstream[],
    private notify: (text: string) => Promise<void>,
    private onChange?: (name: string, up: boolean) => void,
    private intervalMs = 60_000,
    private timeoutMs = 5_000,
  ) {
    const now = Date.now();
    for (const u of targets)
      this.state.set(u.name, {
        name: u.name,
        up: true,
        latencyMs: null,
        error: null,
        failures: 0,
        since: now,
      });
  }

  start(): void {
    log.info(
      {
        upstreams: this.targets.map((u) => u.name),
        intervalMs: this.intervalMs,
        timeoutMs: this.timeoutMs,
      },
      "health monitor started",
    );
    void this.check();
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    log.info("health monitor stopped");
  }

  /** An upstream nobody probes (not configured) reads as up: there is no evidence
   *  against it, and callers use this to decide whether to skip a step. */
  isUp(name: string): boolean {
    return this.state.get(name)?.up ?? true;
  }

  snapshot(): UpstreamStatus[] {
    return [...this.state.values()].map((s) => ({ ...s }));
  }

  /** One round: every upstream at once. A round still running when the next tick
   *  arrives makes that tick a no-op, so slow probes never pile up. Never throws. */
  async check(): Promise<void> {
    if (this.running) {
      log.debug("previous health round still running, skipping tick");
      return;
    }
    this.running = true;
    try {
      await Promise.all(this.targets.map((u) => this.probe(u)));
    } catch (err) {
      log.error({ err }, "health round failed");
    } finally {
      this.running = false;
    }
  }

  private async probe(u: Upstream): Promise<void> {
    const started = Date.now();
    try {
      const res = await fetch(u.url, {
        headers: u.headers,
        dispatcher: u.dispatcher,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await res.body?.cancel();
      if (u.requireOk && !res.ok) throw new Error(`HTTP ${res.status}`);
      this.record(u.name, Date.now() - started, null);
    } catch (err) {
      this.record(u.name, Date.now() - started, describe(err));
    }
  }

  private record(name: string, latencyMs: number, error: string | null): void {
    const s = this.state.get(name);
    if (!s) return;
    s.latencyMs = latencyMs;
    s.error = error;
    if (error === null) {
      log.debug({ upstream: name, latencyMs }, "probe ok");
      s.failures = 0;
      if (s.up) return;
      const downFor = Date.now() - s.since;
      s.up = true;
      s.since = Date.now();
      log.info(
        { upstream: name, latencyMs, downForMs: downFor },
        "upstream up",
      );
      this.announce(
        name,
        true,
        `🟢 ${name} is back (${latencyMs} ms) after ${formatDuration(downFor)} down.`,
      );
      return;
    }
    s.failures++;
    log.debug(
      { upstream: name, latencyMs, error, failures: s.failures },
      "probe failed",
    );
    if (!s.up || s.failures < 2) return;
    s.up = false;
    s.since = Date.now();
    log.warn(
      { upstream: name, latencyMs, error, failures: s.failures },
      "upstream down",
    );
    this.announce(name, false, `🔴 ${name} is unreachable: ${error}`);
  }

  /** Tell the owner and the listener. Neither may throw back into a probe round. */
  private announce(name: string, up: boolean, text: string): void {
    this.notify(text).catch((err) =>
      log.error({ err, upstream: name }, "health notice failed to send"),
    );
    try {
      this.onChange?.(name, up);
    } catch (err) {
      log.error({ err, upstream: name }, "health onChange listener threw");
    }
  }
}
