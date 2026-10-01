import { logger } from "./lib/log.ts";
import { loadConfig } from "./models/config.ts";

export const config = loadConfig(process.env);

// Log resolved config once at boot; secrets stripped by the logger's redact paths.
logger("config").info(config, "config loaded");
