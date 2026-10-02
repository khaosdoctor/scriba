import dns from "node:dns";
import { readFileSync } from "node:fs";
import http from "node:http";
import { type Config, loadConfig } from "./config.ts";
import { createScriba } from "./index.ts";
import { logger } from "./libs/log.ts";

const log = logger("main");

dns.setDefaultResultOrder("ipv4first");

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const sha = process.env.GIT_SHA ?? "unknown";

function readConfig(): Config {
  try {
    return loadConfig(process.env);
  } catch (err) {
    logger("config").error(
      { issues: err instanceof Error ? err.message : String(err) },
      "invalid config",
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  log.info({ version, sha }, "scriba boot");
  log.info(
    {
      dbPath: config.dbPath,
      vaultIndex: config.vaultPath ?? "(none, REST fallback)",
      port: config.telegram.port,
      logLevel: process.env.LOG_LEVEL ?? "debug",
    },
    "scriba starting",
  );
  const app = await createScriba(config, { version, sha });

  // Long polling needs no inbound webhook; this server exists only for a health check.
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(config.telegram.port, () =>
    log.info({ port: config.telegram.port }, "health endpoint listening"),
  );

  await app.start();

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    await app.stop();
    server.close();
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exit(1);
});
