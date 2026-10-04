import type { GithubReleases } from "../data/connections/github.ts";
import type { JotRepository } from "../data/repositories/jots.ts";
import type { LinkRuleRepository } from "../data/repositories/link-rules.ts";
import type { SettingsRepository } from "../data/repositories/settings.ts";
import type { VaultRepository } from "../data/repositories/vault.ts";
import type { Jot } from "../domain/jot/entity.ts";
import { isReprocessable, reprocessTargets } from "../domain/jot/rules.ts";
import { notesFor } from "../domain/link-rule/entity.ts";
import {
  formatDeployNotice,
  formatHealth,
  formatListPage,
  formatReleaseList,
  formatReleaseNote,
  formatStats,
  formatStatus,
} from "../libs/admin.ts";
import { formatJotDetail } from "../libs/jot.ts";
import { distinctSurfaces } from "../libs/links.ts";
import { type Logger, logger } from "../libs/log.ts";
import type { PageView } from "../libs/page.ts";
import type { FlushQueue } from "../libs/queue.ts";
import { pluralize } from "../libs/text.ts";
import { dayBounds, plainDate, startOfToday } from "../libs/time.ts";
import type { HealthMonitor } from "./health.ts";
import type { JotService } from "./jots.ts";
import type { Notifier } from "./notifier.ts";
import type { ProcessingService } from "./processing.ts";
import type { FallbackTranscriber } from "./transcriber.ts";

// One logger per command keeps today's logger names in the log stream.
const log = {
  version: logger("version"),
  changelog: logger("changelog"),
  stats: logger("stats"),
  status: logger("status"),
  failed: logger("failed"),
  jot: logger("jot"),
  flush: logger("flush"),
  retry: logger("retry"),
  sweep: logger("sweep"),
  unstick: logger("unstick"),
  stopword: logger("stopword"),
  rejections: logger("rejections"),
  unreject: logger("unreject"),
  reprocess: logger("reprocess"),
  main: logger("main"),
};

const DAY = 86_400_000;

// A page is sized so its text stays under Telegram's 4096-character cap: one line per
// rejection, comma-joined stopwords.
const REJECTIONS_PAGE = 40;
const STOPWORDS_PAGE = 60;

// Telegram rejects an oversized reply_markup outright.
const UNREJECT_ROWS = 30;

const REPROCESS_PAGE = 8;

export type ReprocessScope =
  | { lo: string; hi: string; day: boolean }
  | { jot: string };

export interface AdminDeps {
  repo: JotRepository;
  linkRules: LinkRuleRepository;
  settings: SettingsRepository;
  queue: Pick<FlushQueue, "add" | "depth" | "flush">;
  processing: Pick<ProcessingService, "retryPass">;
  transcriber: Pick<FallbackTranscriber, "chain">;
  links: Pick<VaultRepository, "stats">;
  github: Pick<GithubReleases, "byVersion" | "latest" | "recent">;
  health: Pick<HealthMonitor, "snapshot">;
  notifier: Pick<Notifier, "notify">;
  jots: Pick<JotService, "retry">;
  build: { version: string; sha: string };
  startedAt: number;
}

type StatsRange = "today" | "week" | "all";

const WINDOWS: Record<
  StatsRange,
  { label: string; from(now: number): number }
> = {
  all: { label: "all time", from: () => 0 },
  week: { label: "last 7 days", from: (now) => now - 7 * DAY },
  today: { label: "today", from: () => startOfToday() },
};

const isStatsRange = (range: string): range is StatsRange =>
  Object.hasOwn(WINDOWS, range);

interface RejectedWord {
  surface: string;
  notes: string[];
}

export class AdminService {
  constructor(private deps: AdminDeps) {}

  version(): string {
    const { version, sha } = this.deps.build;
    log.version.info({ version, sha }, "/version command");
    return `scriba ${version} (${sha.slice(0, 7)})`;
  }

  async changelog(args: string): Promise<string> {
    const arg = args.trim();
    const { github } = this.deps;

    if (/^\d+$/.test(arg)) {
      const count = Math.min(20, Math.max(1, Number(arg)));
      log.changelog.info({ n: count }, "/changelog: listing recent releases");
      const notes = await github.recent(count);
      if (!notes.length) {
        log.changelog.warn("/changelog: recent releases lookup failed");
        return "⚠️ couldn't reach GitHub for release history";
      }
      return formatReleaseList(notes);
    }

    if (arg) {
      log.changelog.info({ version: arg }, "/changelog: looking up version");
      const note = await github.byVersion(arg);
      if (!note) {
        log.changelog.warn({ version: arg }, "/changelog: version not found");
        return `no release found for ${arg}`;
      }
      return formatReleaseNote(note);
    }

    log.changelog.info("/changelog: latest release");
    const note = await github.latest();
    if (!note) {
      log.changelog.warn("/changelog: latest release lookup failed");
      return "⚠️ couldn't reach GitHub for the latest release";
    }
    return formatReleaseNote(note);
  }

  async stats(args: string): Promise<string> {
    const range = args.trim().toLowerCase() || "today";
    if (!isStatsRange(range)) {
      log.stats.warn({ range }, "/stats rejected: bad range");
      return "usage: /stats [today|week|all]";
    }
    log.stats.info({ range }, "/stats command");
    const now = Date.now();
    const { label, from } = WINDOWS[range];
    return formatStats(
      label,
      await this.deps.repo.windowStats(from(now), now + 1000),
    );
  }

  async status(): Promise<string> {
    const { repo, queue, transcriber, links, health, build, startedAt } =
      this.deps;
    log.status.info("/status command");
    const snapshot = formatStatus({
      counts: await repo.statusCounts(),
      queueDepth: queue.depth,
      transcriber: transcriber.chain,
      links: links.stats(),
      version: build.version,
      sha: build.sha,
      uptimeMs: Date.now() - startedAt,
    });
    return `${snapshot}\n\n${formatHealth(health.snapshot(), Date.now())}`;
  }

  async failed(): Promise<{ text: string; ids: string[] }> {
    const jots = await this.deps.repo.failedJots(10);
    log.failed.info({ count: jots.length }, "/failed command");
    if (!jots.length) return { text: "✅ nothing failed.", ids: [] };
    const lines = jots.map(
      (jot) =>
        `${jot.id} [${jot.kind}] ${jot.status} ×${jot.attempts} — ${(jot.error ?? "").slice(0, 60)}`,
    );
    return {
      text: `⚠️ ${jots.length} failed:\n${lines.join("\n")}`,
      ids: jots.map((jot) => jot.id),
    };
  }

  async jotDetail(args: string): Promise<string> {
    const id = args.trim();
    if (!id) {
      log.jot.warn("/jot rejected: no id given");
      return "usage: /jot <id>";
    }
    const jot = await this.deps.repo.getJot(id);
    if (!jot) {
      log.jot.warn({ id }, "/jot: no such jot");
      return `no jot ${id}`;
    }
    log.jot.info({ id }, "/jot command");
    return formatJotDetail(jot);
  }

  async flush(): Promise<string> {
    const depth = this.deps.queue.depth;
    log.flush.info({ depth }, "/flush command");
    this.background(this.deps.queue.flush(), log.flush, "/flush");
    return `⚡ flushing (${depth} queued)`;
  }

  async retryPass(): Promise<string> {
    log.sweep.info("/sweep command");
    this.background(this.deps.processing.retryPass(), log.sweep, "/sweep");
    return "🧹 sweep started";
  }

  /** Runs jot processing without holding the command's reply. grammy handles one update
   *  at a time, and a batch can wait minutes on a button tap (voice fix) that would be
   *  queued behind this handler. Nothing awaits the work, so its failure is logged here. */
  private background(work: Promise<void>, scope: Logger, label: string): void {
    work.catch((err) => scope.error({ err }, `${label} failed`));
  }

  async retry(args: string): Promise<string> {
    const { repo, processing, jots } = this.deps;
    const arg = args.trim().toLowerCase();
    if (arg && arg !== "all") {
      const jot = await repo.getJot(arg);
      if (!jot || jot.status === "deleted") {
        log.retry.warn({ id: arg, status: jot?.status }, "/retry: no such jot");
        return `no jot ${arg}`;
      }
      if ((await jots.retry(jot)) === "in-flight") {
        log.retry.warn({ id: arg }, "/retry: jot is being processed");
        return `⏳ ${arg} is still processing`;
      }
      log.retry.info({ id: arg }, "/retry: single jot requeued");
      return `🔄 retrying ${arg}`;
    }
    const requeued = await repo.resetFailed(arg === "all");
    if (requeued) this.background(processing.retryPass(), log.retry, "/retry");
    log.retry.info({ count: requeued, all: arg === "all" }, "/retry command");
    return `🔄 requeued ${pluralize(requeued, "jot")}${arg === "all" ? " (incl. abandoned)" : ""}`;
  }

  async unstick(): Promise<string> {
    const unstuck = await this.deps.repo.resetProcessing();
    log.unstick.info({ count: unstuck }, "/unstick command");
    return `🔧 unstuck ${pluralize(unstuck, "jot")}`;
  }

  async stopwords(args: string): Promise<string> {
    const { linkRules } = this.deps;
    const [sub, ...rest] = args.trim().split(/\s+/);
    const word = rest.join(" ");
    if (sub === "list") {
      const words = [...(await linkRules.stopwords())].sort();
      const page = pageIndex(rest[0]);
      log.stopword.info({ count: words.length, page }, "/stopword list");
      if (!words.length) return "(none)";
      return formatListPage(
        words,
        page,
        STOPWORDS_PAGE,
        "/stopword list",
        ", ",
      );
    }
    if (sub === "add") {
      if (!word) {
        log.stopword.warn("/stopword add rejected: no word given");
        return "usage: /stopword add <word>";
      }
      await linkRules.addStopword(word);
      log.stopword.info({ word }, "/stopword add");
      return `➕ stopword "${word.toLowerCase()}"`;
    }
    if (sub === "del") {
      if (!word) {
        log.stopword.warn("/stopword del rejected: no word given");
        return "usage: /stopword del <word>";
      }
      const removed = await linkRules.delStopword(word);
      log.stopword.info({ word, removed }, "/stopword del");
      return removed
        ? `➖ removed "${word.toLowerCase()}"`
        : `no stopword "${word.toLowerCase()}"`;
    }
    log.stopword.warn({ sub }, "/stopword rejected: bad subcommand");
    return "usage: /stopword add|del|list [word]";
  }

  async rejections(args: string): Promise<string> {
    const list = await this.deps.linkRules.rejectionList();
    const page = pageIndex(args.trim());
    log.rejections.info({ count: list.length, page }, "/rejections command");
    if (!list.length) return "(no rejections)";
    const lines = list.map(
      (rejection) => `"${rejection.surface}" ✗ [[${rejection.note}]]`,
    );
    return formatListPage(lines, page, REJECTIONS_PAGE, "/rejections");
  }

  async unreject(
    args: string,
  ): Promise<string | { surfaces: string[]; total: number }> {
    const { linkRules } = this.deps;
    const arg = args.trim();
    // The note is the last token, the surface is everything before it.
    if (arg) {
      const splitAt = arg.lastIndexOf(" ");
      if (splitAt < 0)
        return "usage: /unreject <word> <note> (or /unreject with no args for a menu)";
      const surface = arg.slice(0, splitAt);
      const note = arg.slice(splitAt + 1);
      const removed = await linkRules.unreject(surface, note);
      log.unreject.info({ surface, note, removed }, "/unreject direct");
      return removed
        ? `↩️ "${surface}" may link to [[${note}]] again`
        : `no rejection for "${surface}" → [[${note}]]`;
    }

    const list = await linkRules.rejectionList();
    if (!list.length) return "(no rejections)";
    const surfaces = distinctSurfaces(list);
    log.unreject.info({ surfaces: surfaces.length }, "/unreject menu opened");
    const shown = surfaces.slice(0, UNREJECT_ROWS);
    const more = surfaces.length - shown.length;
    if (more) log.unreject.info({ more }, "/unreject menu truncated");
    return { surfaces: shown, total: surfaces.length };
  }

  async rejectedWord(
    step: string | undefined,
    idx: string[],
  ): Promise<RejectedWord | undefined> {
    const list = await this.deps.linkRules.rejectionList();
    const surface = distinctSurfaces(list)[Number(idx[0])];
    if (surface === undefined) {
      log.unreject.warn({ step, idx }, "unreject: surface index out of range");
      return undefined;
    }
    return {
      surface,
      notes: notesFor(list, surface),
    };
  }

  /** Undoes the rejection of the `ni`th note of `word`; undefined when that index no
   *  longer exists, so a shifted list never undoes the wrong pair. */
  async unrejectNote(
    word: RejectedWord,
    idx: string[],
  ): Promise<{ note: string; removed: number } | undefined> {
    const { surface } = word;
    const note = word.notes[Number(idx[1])];
    if (note === undefined) {
      log.unreject.warn({ surface, idx }, "unreject: note index out of range");
      return undefined;
    }
    const removed = await this.deps.linkRules.unreject(surface, note);
    log.unreject.info({ surface, note, removed }, "unreject via menu");
    return { note, removed };
  }

  private async targetsBetween(lo: string, hi: string): Promise<string[]> {
    const jots = await this.deps.repo.jotsInRange(
      dayBounds(lo)[0],
      dayBounds(hi)[1],
    );
    return reprocessTargets(jots);
  }

  async reprocessCount(lo: string, hi: string): Promise<number> {
    return (await this.targetsBetween(lo, hi)).length;
  }

  async jotsPage(page: number): Promise<PageView<Jot>> {
    // One extra row tells whether a next page exists without a count query.
    const rows = await this.deps.repo.jotsPage(
      page * REPROCESS_PAGE,
      REPROCESS_PAGE + 1,
    );
    return {
      items: rows.slice(0, REPROCESS_PAGE),
      page,
      pages: rows.length > REPROCESS_PAGE ? page + 2 : page + 1,
      offset: page * REPROCESS_PAGE,
    };
  }

  async reprocessPick(id?: string): Promise<Jot | "gone" | "busy"> {
    const jot = id ? await this.deps.repo.getJot(id) : undefined;
    if (!jot) return "gone";
    // A stale button or a race with the retry job can leave the jot mid-processing.
    if (!isReprocessable(jot.status)) {
      log.reprocess.warn(
        { id, status: jot.status },
        "reprocess: jot pick rejected: no longer reprocessable",
      );
      return "busy";
    }
    return jot;
  }

  async reprocessExecute(
    scope: ReprocessScope,
  ): Promise<{ text: string; queued: boolean }> {
    if ("jot" in scope) {
      const jot = await this.deps.repo.getJot(scope.jot);
      if (!jot) {
        log.reprocess.warn(
          { id: scope.jot },
          "reprocess: execute rejected: jot not found",
        );
        return { text: `Jot ${scope.jot} not found.`, queued: false };
      }
      // A crafted callback can name a squashed follower; its line lives under the leader.
      return this.resetAndQueue([jot.anchor], jot.anchor);
    }
    const { lo, hi, day } = scope;
    return this.resetAndQueue(
      await this.targetsBetween(lo, hi),
      day ? lo : `${lo} → ${hi}`,
    );
  }

  private async resetAndQueue(targets: string[], label: string) {
    const refuse = (text: string) => ({ text, queued: false });
    if (!targets.length) return refuse(`No reprocessable jots for ${label}.`);
    const { queue } = this.deps;
    log.reprocess.info({ label, count: targets.length }, "reprocess triggered");
    log.reprocess.debug({ ids: targets }, "reprocess targets");
    // Only what the reset set to pending is queued: a target can race into `processing`
    // between the query and the reset.
    const reset = await this.deps.repo.resetForReprocess(targets);
    if (!reset.length)
      return refuse(`No reprocessable jots for ${label} anymore.`);
    queue.add(reset);
    return {
      text: `🔁 Reprocessing ${pluralize(reset.length, "jot")} from ${label}…`,
      queued: true,
    };
  }

  async dailySummary(): Promise<void> {
    const stats = await this.deps.repo.windowStats(startOfToday(), Date.now());
    const failed = stats.failed + stats.abandoned;
    log.main.info(
      { jots: stats.total, audio: stats.audio, failed },
      "daily summary",
    );
    if (stats.total === 0) return;

    const lines = [
      `📓 ${plainDate()}`,
      `Jots: ${stats.total} (voice: ${stats.audio})`,
    ];
    if (failed) lines.push(`⚠️ Failed/abandoned: ${failed}`);
    await this.deps.notifier.notify(lines.join("\n"));
  }

  async announceDeploy(): Promise<void> {
    const { settings, github, notifier, build } = this.deps;
    const deployId = `${build.version}@${build.sha}`;
    const lastDeployId = await settings.getSetting("deployId");
    if (lastDeployId === deployId) return;
    log.main.info(
      { deployId, lastDeployId },
      "new deploy detected — notifying",
    );
    // The notice still goes out without "what's new" when the GitHub lookup fails.
    const releaseNote = await github.byVersion(build.version).catch((err) => {
      log.main.warn(
        { err, version: build.version },
        "release note lookup failed for deploy notice",
      );
      return null;
    });
    // Recorded only once the notice sends, so a Telegram outage retries on the next boot.
    try {
      await notifier.notify(
        formatDeployNotice(build.version, build.sha, releaseNote),
      );
      await settings.setSetting("deployId", deployId);
    } catch (err) {
      log.main.warn(
        { err },
        "deploy notice failed to send — will retry next boot",
      );
    }
  }
}

/** Pages are 1-based on the wire (the footer tells the user to type one) and 0-based in
 *  `formatListPage`. */
function pageIndex(raw: string | undefined): number {
  return Math.max(1, Number(raw) || 1) - 1;
}
