import { lookup } from "node:dns/promises";
import { Agent, type Dispatcher, fetch } from "undici";
import { htmlToText } from "../lib/text.ts";
import { logger } from "../log.ts";

const log = logger("web");

const MAX_TEXT_CHARS = 200_000;
const MAX_FETCH_BYTES = 4_000_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

/** Loopback, link-local, CGNAT and the RFC1918 ranges, v4 and v6. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, "");
  const parts = v4.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n))) {
    const [a = 0, b = 0] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      a >= 224 // multicast + reserved
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") || // unique local
    v6.startsWith("fe80") // link-local
  );
}

/**
 * Fetches a page as text for the `/command` agent. http(s) only, redirects re-checked at
 * every hop, and anything resolving to a private or loopback address is refused: the bot
 * runs inside a home LAN full of unauthenticated services, so "fetch a URL" must not
 * become a way to read them. No JS runs, the body is a string that gets tags stripped.
 */
export class WebService {
  constructor(
    // One dispatcher, so a slow page can't hold a socket forever.
    private dispatcher: Dispatcher = new Agent({
      connect: { timeout: 10_000 },
      headersTimeout: FETCH_TIMEOUT_MS,
      bodyTimeout: FETCH_TIMEOUT_MS,
    }),
  ) {}

  async fetchPage(url: string): Promise<string> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await this.assertPublicHttpUrl(current);
      const res = await fetch(current, {
        redirect: "manual",
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          // Some sites 403 an unknown agent; be honest about what this is.
          "user-agent":
            "scriba-bot/1.0 (+https://github.com/khaosdoctor/scriba)",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString();
        log.debug({ from: url, to: current }, "command: web_fetch redirect");
        continue;
      }
      if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
      const type = res.headers.get("content-type") ?? "";
      if (!/text\/|json|xml/i.test(type))
        throw new Error(`not a text page (content-type: ${type || "unknown"})`);
      const size = Number(res.headers.get("content-length") ?? 0);
      if (size > MAX_FETCH_BYTES)
        throw new Error(`page too large (${size} bytes)`);
      const body = (await res.text()).slice(0, MAX_FETCH_BYTES);
      const text = /html|xml/i.test(type) ? htmlToText(body) : body;
      log.info({ url: current, chars: text.length }, "command: web_fetch");
      return text.length > MAX_TEXT_CHARS
        ? `${text.slice(0, MAX_TEXT_CHARS)}\n… (truncated)`
        : text;
    }
    throw new Error("too many redirects");
  }

  /** http(s) only, and never an address on the local machine or the home network. */
  private async assertPublicHttpUrl(raw: string): Promise<void> {
    if (!URL.canParse(raw)) throw new Error(`not a URL: ${raw}`);
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:")
      throw new Error(`only http(s) URLs can be fetched, got ${u.protocol}`);
    const addrs = await lookup(u.hostname, { all: true }).catch(() => {
      throw new Error(`cannot resolve ${u.hostname}`);
    });
    for (const { address } of addrs)
      if (isPrivateAddress(address))
        throw new Error(
          `refusing to fetch ${u.hostname}: it resolves to a private address (${address})`,
        );
  }
}
