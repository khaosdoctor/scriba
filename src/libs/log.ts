import pino from "pino";
import pretty from "pino-pretty";

// Pretty via the synchronous stream API, NOT the `transport` worker-thread option:
// the worker doesn't inherit the tsx loader and dies silently, so no logs appear.
// `sync: true` writes straight to fd 1 like console.log, async SonicBoom buffering
// gets swallowed in containers (Coolify/docker) and the logs never appear.
const level = process.env.LOG_LEVEL ?? "debug";
// Secrets stripped in pino core so they never reach any stream, any call site. Wildcards
// match the config secrets (telegram.token, obsidian.key, transcription.groqApiKey).
const redact = {
  paths: ["*.token", "*.key", "*.groqApiKey", "*.opencodeApiKey"],
  censor: "***",
};
const stream =
  process.env.LOG_JSON === "1"
    ? pino.destination({ dest: 1, sync: true })
    : pretty({
        sync: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname,ns",
        messageFormat: "[{ns}] {msg}",
      });
const root = pino({ level, redact }, stream);

export type Logger = pino.Logger;

export function logger(ns: string): Logger {
  return root.child({ ns });
}
