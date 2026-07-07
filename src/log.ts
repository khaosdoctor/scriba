/**
 * pino logger. One root, `logger(ns)` returns a child tagged with the component name.
 * Level via LOG_LEVEL (default `debug` — this bot is meant to be loud). Output is
 * human-readable pretty-printed by default; set LOG_JSON=1 for raw JSON (log shippers).
 *
 * Call style is pino-native: `log.info({ field: 1 }, "message")`. Errors go in the
 * merge object as `err` — pino's std serializer expands them: `log.error({ err }, "…")`.
 */
import pino from "pino";

const root = pino({
  level: process.env.LOG_LEVEL ?? "debug",
  ...(process.env.LOG_JSON === "1"
    ? {}
    : { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname,ns", messageFormat: "[{ns}] {msg}" } } }),
});

export type Logger = pino.Logger;

export function logger(ns: string): Logger {
  return root.child({ ns });
}
