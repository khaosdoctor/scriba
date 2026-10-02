import { loadConfig } from "../models/config.ts";

export const testConfig = loadConfig({
  TELEGRAM_BOT_TOKEN: "t",
  ALLOWED_TELEGRAM_USER_ID: "1",
  OBSIDIAN_API_KEY: "o",
});
