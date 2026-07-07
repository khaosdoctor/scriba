import http from "node:http";
import { readFileSync } from "node:fs";
import { config } from "./config.ts";
import { logger } from "./log.ts";
import { Repository } from "./db.ts";
import { ObsidianClient } from "./obsidian.ts";
import { createTranscriber } from "./transcribe.ts";
import { Enricher } from "./enrich.ts";
import { LinkIndex } from "./index-links.ts";
import { JotProcessor } from "./processor.ts";
import { FlushQueue } from "./queue.ts";
import { ScribaBot } from "./bot.ts";
import { Scheduler } from "./scheduler.ts";

const log = logger("main");

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const sha = process.env.GIT_SHA ?? "unknown";

async function main(): Promise<void> {
  log.info({ version, sha }, "scriba boot");
  log.info({
    dbPath: config.dbPath, transcriber: config.transcription.mode,
    vaultIndex: config.vaultPath ?? "(none — REST fallback)", port: config.telegram.port,
    logLevel: process.env.LOG_LEVEL ?? "debug",
  }, "scriba starting");
  const repo = await Repository.open(config.dbPath);
  log.debug("repository open, migrations applied");
  const unstuck = await repo.resetProcessing(); // crash recovery: unstick jots claimed by a dead run
  log.info({ requeued: unstuck }, "crash recovery done");

  const obsidian = new ObsidianClient(config.obsidian);
  const transcriber = createTranscriber(config.transcription);
  const enricher = new Enricher();
  const links = new LinkIndex(config.vaultPath);
  links.start();

  const bot = new ScribaBot(repo, obsidian, enricher);
  const processor = new JotProcessor(repo, obsidian, transcriber, enricher, links, bot);
  const queue = new FlushQueue({
    idleMs: config.flush.idleMs,
    maxBatch: config.flush.maxBatch,
    maxWaitMs: config.flush.maxWaitMs,
    onFlush: (ids) => processor.processBatch(ids),
  });
  bot.setQueue(queue);

  const scheduler = new Scheduler(repo, processor, (t) => bot.notify(t), (d) => bot.promptRating(d));
  scheduler.start();

  void processor.retrySweep(); // pick up anything left over from a previous run

  // Long polling needs no inbound webhook; this server exists only for a health check.
  const server = http.createServer((req, res) => {
    if (req.url === "/health") { res.writeHead(200).end("ok"); return; }
    res.writeHead(404).end();
  });
  server.listen(config.telegram.port, () => log.info({ port: config.telegram.port }, "health endpoint listening"));

  await bot.start();
  log.info("scriba ready");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    await bot.stop();
    server.close();
    scheduler.stop();
    links.stop();
    await repo.close();
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
