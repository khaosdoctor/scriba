/**
 * pino logger. One root, `logger(ns)` returns a child tagged with the component name.
 * Level via LOG_LEVEL (default `debug` — this bot is meant to be loud). Output is
 * human-readable pretty-printed by default; set LOG_JSON=1 for raw JSON (log shippers).
 *
 * Call style is pino-native: `log.info({ field: 1 }, "message")`. Errors go in the
 * merge object as `err` — pino's std serializer expands them: `log.error({ err }, "…")`.
 */
import pino from "pino";
import pretty from "pino-pretty";

// Pretty via the synchronous stream API, NOT the `transport` worker-thread option:
// the worker doesn't inherit the tsx loader and dies silently, so no logs appear.
// `sync: true` writes straight to fd 1 like console.log — async SonicBoom buffering
// gets swallowed in containers (Coolify/docker) and the logs never surface.
const level = process.env.LOG_LEVEL ?? "debug";
const root = process.env.LOG_JSON === "1"
  ? pino({ level }, pino.destination({ dest: 1, sync: true }))
  : pino({ level }, pretty({ sync: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname,ns", messageFormat: "[{ns}] {msg}" }));

export type Logger = pino.Logger;

export function logger(ns: string): Logger {
  return root.child({ ns });
}
