import { lookup as resolveHost } from "node:dns";
import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { Agent, type Dispatcher, fetch, type Response } from "undici";
import { logger } from "../../libs/log.ts";
import { htmlToText } from "../../libs/text.ts";

const log = logger("web");

const MAX_TEXT_CHARS = 200_000;
const MAX_FETCH_BYTES = 4_000_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

/** Loopback, link-local, CGNAT and the RFC1918 ranges, v4 and v6. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, "");
  const parts = v4.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part))) {
    const [first = 0, second = 0] = parts;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127) || // CGNAT
      first >= 224 // multicast + reserved
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") || // unique local
    /^fe[89ab]/.test(v6) // link-local, fe80::/10
  );
}

/** The address undici dials, checked when it dials: a host that answered the pre-flight
 *  lookup with a public address can't answer this one with a LAN address. */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  resolveHost(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
    if (blocked)
      return callback(
        new Error(
          `refusing to connect to ${hostname}: it resolves to a private address (${blocked.address})`,
        ),
        [],
      );
    if (options.all) return callback(null, addresses);
    const [first] = addresses;
    callback(null, first?.address ?? "", first?.family);
  });
};

/** The body as text, read no further than MAX_FETCH_BYTES whatever the headers claim. */
async function readCapped(res: Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= MAX_FETCH_BYTES) break;
  }
  return new TextDecoder().decode(
    Buffer.concat(chunks).subarray(0, MAX_FETCH_BYTES),
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
      connect: { timeout: 10_000, lookup: publicLookup },
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
      const body = await readCapped(res);
      const text = /html|xml/i.test(type) ? htmlToText(body) : body;
      log.info({ url: current, chars: text.length }, "command: web_fetch");
      return text.length > MAX_TEXT_CHARS
        ? `${text.slice(0, MAX_TEXT_CHARS)}\n… (truncated)`
        : text;
    }
    throw new Error("too many redirects");
  }

  private async assertPublicHttpUrl(raw: string): Promise<void> {
    if (!URL.canParse(raw)) throw new Error(`not a URL: ${raw}`);
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error(`only http(s) URLs can be fetched, got ${url.protocol}`);
    const addrs = await lookup(url.hostname, { all: true }).catch(() => {
      throw new Error(`cannot resolve ${url.hostname}`);
    });
    for (const { address } of addrs)
      if (isPrivateAddress(address))
        throw new Error(
          `refusing to fetch ${url.hostname}: it resolves to a private address (${address})`,
        );
  }
}
