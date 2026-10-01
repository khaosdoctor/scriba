import dns from "node:dns";
import { readFileSync } from "node:fs";
import http from "node:http";
import { logger } from "./lib/log.ts";
import { type Config, loadConfig } from "./models/config.ts";

const log = logger("main");

// The homelab network has no IPv6 route, so an AAAA answer is a dead end: try A first.
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
  // index.ts pulls in the config shim, which parses the environment on import, so it
  // loads only after the check above has had its say.
  const { createScriba } = await import("./index.ts");
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
