import { z } from "zod";
import { logger } from "./log.ts";

const log = logger("config");

// Whole environment is one schema: coercion, defaults, and cross-field checks
// all live here so a misconfigured deploy fails at boot with a readable message.
const envSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    ALLOWED_TELEGRAM_USER_ID: z.coerce.number(),
    PORT: z.coerce.number().default(8080), // health endpoint only (long polling needs no inbound webhook)

    TRANSCRIBER: z.enum(["local", "remote"]).default("local"),
    GROQ_API_KEY: z.string().optional(),
    PARAKEET_URL: z
      .string()
      .default("http://parakeet:5092/v1/audio/transcriptions"),

    OBSIDIAN_API_URL: z
      .string()
      .default("https://127.0.0.1:27124")
      .transform((s) => s.replace(/\/$/, "")),
    OBSIDIAN_API_KEY: z.string().min(1),
    DAILY_NOTES_DIR: z.string().default("notes/daily notes"),
    DAILY_NOTE_TEMPLATE: z.string().default("internal/templates/Daily Note"),
    JOURNAL_HEADING: z.string().default("Journal"),
    ASSETS_DIR: z.string().default("internal/assets/journal"),

    // Where the app READS the vault. Set SCRIBA_VAULT_HOST_PATH to point at a real
    // vault dir (local run); unset ⇒ /vault, the containerized bind-mount. Empty ⇒
    // link index disabled.
    SCRIBA_VAULT_HOST_PATH: z.string().default("/vault"),
    DB_PATH: z.string().default("/data/scriba.db"),
    SUMMARY_TIME: z.string().default("23:30"),
    RATING_TIME: z.string().default("00:00"), // nightly "how was your day?" 1–10 prompt

    FLUSH_IDLE_MS: z.coerce.number().default(30_000),
    FLUSH_MAX_BATCH: z.coerce.number().default(8),
    FLUSH_MAX_WAIT_MS: z.coerce.number().default(120_000),
  })
  // Remote transcription needs a Groq key; local needs none.
  .refine((e) => e.TRANSCRIBER !== "remote" || !!e.GROQ_API_KEY, {
    message: 'GROQ_API_KEY is required when TRANSCRIBER="remote"',
    path: ["GROQ_API_KEY"],
  });

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  log.error({ issues: z.prettifyError(parsed.error) }, "invalid config");
  throw new Error("Invalid configuration, see logs above");
}
const env = parsed.data;

export const config = {
  telegram: {
    token: env.TELEGRAM_BOT_TOKEN,
    allowedUserId: env.ALLOWED_TELEGRAM_USER_ID,
    port: env.PORT,
  },
  transcription: {
    mode: env.TRANSCRIBER,
    // Each mode carries only its own config.
    groqApiKey: env.TRANSCRIBER === "remote" ? env.GROQ_API_KEY! : "",
    parakeetUrl: env.TRANSCRIBER === "local" ? env.PARAKEET_URL : "",
  },
  obsidian: {
    url: env.OBSIDIAN_API_URL,
    key: env.OBSIDIAN_API_KEY,
    dailyDir: env.DAILY_NOTES_DIR,
    dailyTemplate: env.DAILY_NOTE_TEMPLATE,
    journalHeading: env.JOURNAL_HEADING,
    assetsDir: env.ASSETS_DIR,
  },
  vaultPath: env.SCRIBA_VAULT_HOST_PATH,
  dbPath: env.DB_PATH,
  summaryTime: env.SUMMARY_TIME,
  ratingTime: env.RATING_TIME,
  flush: {
    idleMs: env.FLUSH_IDLE_MS,
    maxBatch: env.FLUSH_MAX_BATCH,
    maxWaitMs: env.FLUSH_MAX_WAIT_MS,
  },
} as const;

// Log resolved config once at boot; secrets redacted.
log.info(
  {
    ...config,
    telegram: { ...config.telegram, token: "***" },
    obsidian: { ...config.obsidian, key: "***" },
    transcription: {
      ...config.transcription,
      groqApiKey: config.transcription.groqApiKey ? "***" : "",
    },
  },
  "config loaded",
);
