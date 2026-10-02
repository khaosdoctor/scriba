import { type Dispatcher, fetch } from "undici";
import { logger } from "../libs/log.ts";
import { formatDuration } from "../libs/text.ts";
import { OPENCODE_BASE_URL } from "./enrich.ts";

const log = logger("health");

export interface UpstreamStatus {
  name: string;
  up: boolean;
  latencyMs: number | null;
  error: string | null;
  failures: number;
  since: number;
}

/** The model listing next to an OpenAI-style transcription endpoint:
 *  `.../v1/audio/transcriptions` → `.../v1/models`. A GET there generates nothing, which
 *  is why the health probe uses it instead of the endpoint itself. */
export function modelsUrlFor(transcriptionsUrl: string): string {
  const u = new URL(transcriptionsUrl);
  const base = u.pathname
    .replace(/\/audio\/transcriptions\/?$/, "")
    .replace(/\/$/, "");
  u.pathname = `${base}/models`;
  u.search = "";
  return u.toString();
}

/** One thing the bot depends on, probed with a plain GET. There is no method or body
 *  field on purpose: a probe must never be able to generate anything (and so never
 *  spend a token), which is why every URL is a bare host or a `/models` listing. */
export interface Upstream {
  name: string;
  url: string;
  headers?: Record<string, string>;
  /** Only a 2xx counts as up. Set where a key is sent: Groq answers a bad key with 401,
   *  so its probe also catches a revoked key; OpenCode's listing doesn't check the key,
   *  so there it only proves the host answers. Otherwise any HTTP answer counts. */
  requireOk?: boolean;
  dispatcher?: Dispatcher;
}

export interface HealthTargets {
  groqApiKey: string;
  opencodeApiKey: string;
  obsidianUrl: string;
  parakeetUrl: string;
}

export function upstreams(t: HealthTargets, obsidian: Dispatcher): Upstream[] {
  const list: Upstream[] = [
    { name: "anthropic", url: "https://api.anthropic.com" },
    { name: "telegram", url: "https://api.telegram.org" },
    { name: "obsidian", url: `${t.obsidianUrl}/`, dispatcher: obsidian },
    { name: "parakeet", url: modelsUrlFor(t.parakeetUrl) },
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
      url: `${OPENCODE_BASE_URL}/models`,
      headers: { Authorization: `Bearer ${t.opencodeApiKey}` },
      requireOk: true,
    });
  return list;
}

/** A fetch error's own message says only "fetch failed"; the cause says why. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // A dual-stack connect failure's cause is an AggregateError with an empty message;
  // its code (ECONNREFUSED…) is then the only reason there is.
  if (err.cause instanceof Error)
    return `${err.message}: ${err.cause.message || (err.cause as NodeJS.ErrnoException).code}`;
  return err.message;
}

export class HealthMonitor {
  private state = new Map<string, UpstreamStatus>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private targets: Upstream[],
    private notify: (text: string) => Promise<void>,
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

  snapshot(): UpstreamStatus[] {
    return [...this.state.values()].map((s) => ({ ...s }));
  }

  async check(): Promise<void> {
    await Promise.all(this.targets.map((u) => this.probe(u)));
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
    this.announce(name, `🔴 ${name} is unreachable: ${error}`);
  }

  /** Tell the owner. A failed send must not throw back into a probe round. */
  private announce(name: string, text: string): void {
    this.notify(text).catch((err) =>
      log.error({ err, upstream: name }, "health notice failed to send"),
    );
  }
}
