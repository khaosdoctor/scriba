import { type Dispatcher, fetch } from "undici";
import { OPENCODE_BASE_URL } from "../data/connections/groq.ts";
import type { UpstreamStatus } from "../domain/health/structures.ts";
import { logger } from "../libs/log.ts";

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

/** Probes every upstream once, all at once, when asked: `/status` is the only caller,
 *  so nothing runs in the background and nothing is ever sent unprompted. */
export class HealthCheck {
  constructor(
    private targets: Upstream[],
    private timeoutMs = 5_000,
  ) {}

  async check(): Promise<UpstreamStatus[]> {
    log.info(
      { upstreams: this.targets.map((upstream) => upstream.name) },
      "health check",
    );
    return Promise.all(this.targets.map((upstream) => this.probe(upstream)));
  }

  private async probe(upstream: Upstream): Promise<UpstreamStatus> {
    const started = Date.now();
    try {
      const res = await fetch(upstream.url, {
        headers: upstream.headers,
        dispatcher: upstream.dispatcher,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await res.body?.cancel();
      if (upstream.requireOk && !res.ok) throw new Error(`HTTP ${res.status}`);
      const latencyMs = Date.now() - started;
      log.debug({ upstream: upstream.name, latencyMs }, "probe ok");
      return { name: upstream.name, up: true, latencyMs, error: null };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const error = describe(err);
      log.warn({ upstream: upstream.name, latencyMs, error }, "probe failed");
      return { name: upstream.name, up: false, latencyMs, error };
    }
  }
}
