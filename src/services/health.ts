import { type Dispatcher, fetch } from "undici";
import { OPENCODE_BASE_URL } from "../data/connections/groq.ts";
import type { UpstreamStatus } from "../domain/health/structures.ts";
import { logger } from "../libs/log.ts";
import { formatDuration } from "../libs/text.ts";

const log = logger("health");

/** The model listing next to an OpenAI-style transcription endpoint:
 *  `.../v1/audio/transcriptions` → `.../v1/models`. A GET there generates nothing, which
 *  is why the health probe uses it instead of the endpoint itself. */
export function modelsUrlFor(transcriptionsUrl: string): string {
  const url = new URL(transcriptionsUrl);
  const base = url.pathname
    .replace(/\/audio\/transcriptions\/?$/, "")
    .replace(/\/$/, "");
  url.pathname = `${base}/models`;
  url.search = "";
  return url.toString();
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

interface HealthTargets {
  groqApiKey: string;
  opencodeApiKey: string;
  obsidianUrl: string;
  parakeetUrl: string;
}

export function upstreams(
  targets: HealthTargets,
  obsidian: Dispatcher,
): Upstream[] {
  const list: Upstream[] = [
    { name: "anthropic", url: "https://api.anthropic.com" },
    { name: "telegram", url: "https://api.telegram.org" },
    { name: "obsidian", url: `${targets.obsidianUrl}/`, dispatcher: obsidian },
    { name: "parakeet", url: modelsUrlFor(targets.parakeetUrl) },
  ];
  if (targets.groqApiKey)
    list.push({
      name: "groq",
      url: "https://api.groq.com/openai/v1/models",
      headers: { Authorization: `Bearer ${targets.groqApiKey}` },
      requireOk: true,
    });
  if (targets.opencodeApiKey)
    list.push({
      name: "opencode",
      url: `${OPENCODE_BASE_URL}/models`,
      headers: { Authorization: `Bearer ${targets.opencodeApiKey}` },
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
    for (const upstream of targets)
      this.state.set(upstream.name, {
        name: upstream.name,
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
        upstreams: this.targets.map((upstream) => upstream.name),
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
    return [...this.state.values()].map((status) => ({ ...status }));
  }

  async check(): Promise<void> {
    await Promise.all(this.targets.map((upstream) => this.probe(upstream)));
  }

  private async probe(upstream: Upstream): Promise<void> {
    const started = Date.now();
    try {
      const res = await fetch(upstream.url, {
        headers: upstream.headers,
        dispatcher: upstream.dispatcher,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await res.body?.cancel();
      if (upstream.requireOk && !res.ok) throw new Error(`HTTP ${res.status}`);
      this.record(upstream.name, Date.now() - started, null);
    } catch (err) {
      this.record(upstream.name, Date.now() - started, describe(err));
    }
  }

  private record(name: string, latencyMs: number, error: string | null): void {
    const status = this.state.get(name);
    if (!status) return;
    status.latencyMs = latencyMs;
    status.error = error;
    if (error === null) {
      log.debug({ upstream: name, latencyMs }, "probe ok");
      status.failures = 0;
      if (status.up) return;
      const downFor = Date.now() - status.since;
      status.up = true;
      status.since = Date.now();
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
    status.failures++;
    log.debug(
      { upstream: name, latencyMs, error, failures: status.failures },
      "probe failed",
    );
    if (!status.up || status.failures < 2) return;
    status.up = false;
    status.since = Date.now();
    log.warn(
      { upstream: name, latencyMs, error, failures: status.failures },
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
