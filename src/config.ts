function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function opt(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

// Transcription backend: "remote" (Groq) or "local" (Parakeet sidecar).
// Validate up front so a misconfigured mode fails at boot, not on the first voice note.
const transcriberMode = opt("TRANSCRIBER", "remote");
if (transcriberMode !== "local" && transcriberMode !== "remote") {
  throw new Error(`TRANSCRIBER must be "local" or "remote", got: ${transcriberMode}`);
}

export const config = {
  telegram: {
    token: req("TELEGRAM_BOT_TOKEN"),
    webhookSecret: req("TELEGRAM_WEBHOOK_SECRET"),
    webhookUrl: req("WEBHOOK_URL"),
    allowedUserId: Number(req("ALLOWED_TELEGRAM_USER_ID")),
    port: num("PORT", 8080),
  },
  transcription: {
    mode: transcriberMode,
    // Each mode needs only its own config. Local defaults to the bundled sidecar.
    groqApiKey: transcriberMode === "remote" ? req("GROQ_API_KEY") : "",
    parakeetUrl: transcriberMode === "local"
      ? opt("PARAKEET_URL", "http://parakeet:5092/v1/audio/transcriptions")
      : "",
  },
  obsidian: {
    url: opt("OBSIDIAN_API_URL", "https://127.0.0.1:27124").replace(/\/$/, ""),
    key: req("OBSIDIAN_API_KEY"),
    dailyDir: opt("DAILY_NOTES_DIR", "notes/daily notes"),
    dailyTemplate: opt("DAILY_NOTE_TEMPLATE", "internal/templates/Daily Note"),
    journalHeading: opt("JOURNAL_HEADING", "Journal"),
    assetsDir: opt("ASSETS_DIR", "assets"),
  },
  vaultPath: process.env.VAULT_PATH || null,
  dbPath: opt("DB_PATH", "/data/scriba.db"),
  summaryTime: opt("SUMMARY_TIME", "23:30"),
  flush: {
    idleMs: num("FLUSH_IDLE_MS", 30_000),
    maxBatch: num("FLUSH_MAX_BATCH", 8),
    maxWaitMs: num("FLUSH_MAX_WAIT_MS", 120_000),
  },
} as const;
