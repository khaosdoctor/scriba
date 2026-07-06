import http from "node:http";
import { config } from "./config.ts";
import { Repository } from "./db.ts";
import { ObsidianClient } from "./obsidian.ts";
import { Transcriber } from "./transcribe.ts";
import { Enricher } from "./enrich.ts";
import { LinkIndex } from "./index-links.ts";
import { JotProcessor } from "./processor.ts";
import { FlushQueue } from "./queue.ts";
import { ScribaBot } from "./bot.ts";
import { Scheduler } from "./scheduler.ts";

async function main(): Promise<void> {
  const repo = await Repository.open(config.dbPath);
  const obsidian = new ObsidianClient(config.obsidian);
  const transcriber = new Transcriber(config.groq.apiKey);
  const enricher = new Enricher();
  const links = new LinkIndex(config.vaultPath);
  links.startRefresh();

  const bot = new ScribaBot(repo, obsidian, enricher);
  const processor = new JotProcessor(repo, obsidian, transcriber, enricher, links, bot);
  const queue = new FlushQueue({
    idleMs: config.flush.idleMs,
    maxBatch: config.flush.maxBatch,
    maxWaitMs: config.flush.maxWaitMs,
    onFlush: (ids) => processor.processBatch(ids),
  });
  bot.setQueue(queue);

  const scheduler = new Scheduler(repo, processor, (t) => bot.notify(t));
  scheduler.start();

  // Crash recovery: pick up anything left pending/failed from a previous run.
  void processor.retrySweep();

  const webhook = bot.webhookHandler();
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/telegram") return void webhook(req, res);
    if (req.url === "/health") { res.writeHead(200).end("ok"); return; }
    res.writeHead(404).end();
  });
  server.listen(config.telegram.port, () => console.log(`scriba listening on :${config.telegram.port}`));

  await bot.start(); // registers the Telegram webhook
  console.log("scriba ready");

  const shutdown = async () => {
    server.close();
    scheduler.stop();
    links.stop();
    await repo.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
