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

export const config = {
  telegram: {
    token: req("TELEGRAM_BOT_TOKEN"),
    webhookSecret: req("TELEGRAM_WEBHOOK_SECRET"),
    webhookUrl: req("WEBHOOK_URL"),
    allowedUserId: Number(req("ALLOWED_TELEGRAM_USER_ID")),
    port: num("PORT", 8080),
  },
  groq: { apiKey: req("GROQ_API_KEY") },
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

export type Config = typeof config;
