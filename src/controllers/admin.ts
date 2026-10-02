import {
  type Jot,
  type JotStatus,
  TERMINAL_STATUSES,
} from "../domain/jot/entity.ts";
import type { Stats, StatusCounts } from "../domain/jot/structures.ts";
import { clipUpdate } from "../libs/feed.ts";
import { formatJotDetail, reprocessTargets } from "../libs/jot.ts";
import { distinctSurfaces } from "../libs/links.ts";
import { logger } from "../libs/log.ts";
import type { PageView } from "../libs/page.ts";
import type { FlushQueue } from "../libs/queue.ts";
import { formatDuration, pluralize } from "../libs/text.ts";
import { dayBounds, plainDate, startOfToday } from "../libs/time.ts";
import type { Repository } from "../repositories/index.ts";
import type { GithubReleases, ReleaseNote } from "../services/github.ts";
import type { HealthMonitor, UpstreamStatus } from "../services/health.ts";
import type { Notifier } from "../services/notifier.ts";
import type { FallbackTranscriber } from "../services/transcribe.ts";
import type { VaultService } from "../services/vault.ts";
import type { ProcessingController } from "./processing.ts";

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
  repo: Repository;
  queue: FlushQueue;
  processing: ProcessingController;
  transcriber: FallbackTranscriber;
  links: VaultService;
  github: GithubReleases;
  health: HealthMonitor;
  notifier: Pick<Notifier, "notify">;
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

/** The words an unreject picker offers: at most `UNREJECT_ROWS` of `total`. */
export interface UnrejectPicker {
  surfaces: string[];
  total: number;
}

/** A rejected word and the notes it was rejected for. */
export interface RejectedWord {
  surface: string;
  notes: string[];
}

/** What the admin commands and the menu's maintenance screens act on. The text each
 *  command answers with is built here; the views only send it. */
export class AdminController {
  constructor(private d: AdminDeps) {}

  version(): string {
    const { version, sha } = this.d.build;
    log.version.info({ version, sha }, "/version command");
    return `scriba ${version} (${sha.slice(0, 7)})`;
  }

  async changelog(args: string): Promise<string> {
    const arg = args.trim();
    const { github } = this.d;

    if (/^\d+$/.test(arg)) {
      const n = Math.min(20, Math.max(1, Number(arg)));
      log.changelog.info({ n }, "/changelog: listing recent releases");
      const notes = await github.recent(n);
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
      await this.d.repo.windowStats(from(now), now + 1000),
    );
  }

  async status(): Promise<string> {
    const { repo, queue, transcriber, links, health, build, startedAt } =
      this.d;
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

  /** The failed jots as one text, and their ids so the view can put buttons under it. */
  async failed(): Promise<{ text: string; ids: string[] }> {
    const jots = await this.d.repo.failedJots(10);
    log.failed.info({ count: jots.length }, "/failed command");
    if (!jots.length) return { text: "✅ nothing failed.", ids: [] };
    const lines = jots.map(
      (j) =>
        `${j.id} [${j.kind}] ${j.status} ×${j.attempts} — ${(j.error ?? "").slice(0, 60)}`,
    );
    return {
      text: `⚠️ ${jots.length} failed:\n${lines.join("\n")}`,
      ids: jots.map((j) => j.id),
    };
  }

  async jotDetail(args: string): Promise<string> {
    const id = args.trim();
    if (!id) {
      log.jot.warn("/jot rejected: no id given");
      return "usage: /jot <id>";
    }
    const jot = await this.d.repo.getJot(id);
    if (!jot) {
      log.jot.warn({ id }, "/jot: no such jot");
      return `no jot ${id}`;
    }
    log.jot.info({ id }, "/jot command");
    return formatJotDetail(jot);
  }

  async flush(): Promise<string> {
    const n = this.d.queue.depth;
    log.flush.info({ depth: n }, "/flush command");
    await this.d.queue.flush();
    return `⚡ flushed (${n} queued)`;
  }

  async retryPass(): Promise<string> {
    log.sweep.info("/sweep command");
    await this.d.processing.retryPass();
    return "🧹 sweep done";
  }

  async retry(args: string): Promise<string> {
    const { repo, queue, processing } = this.d;
    const arg = args.trim().toLowerCase();
    if (arg && arg !== "all") {
      const jot = await repo.getJot(arg);
      if (!jot) {
        log.retry.warn({ id: arg }, "/retry: no such jot");
        return `no jot ${arg}`;
      }
      await repo.resetForRetry(arg);
      queue.add([arg]);
      log.retry.info({ id: arg }, "/retry: single jot requeued");
      return `🔄 retrying ${arg}`;
    }
    // No arg takes the failed jots, `all` adds the abandoned ones; the pass picks them
    // up once reset.
    const n = await repo.resetFailed(arg === "all");
    if (n) void processing.retryPass();
    log.retry.info({ count: n, all: arg === "all" }, "/retry command");
    return `🔄 requeued ${pluralize(n, "jot")}${arg === "all" ? " (incl. abandoned)" : ""}`;
  }

  async unstick(): Promise<string> {
    const n = await this.d.repo.resetProcessing();
    log.unstick.info({ count: n }, "/unstick command");
    return `🔧 unstuck ${pluralize(n, "jot")}`;
  }

  async stopwords(args: string): Promise<string> {
    const { repo } = this.d;
    const [sub, ...rest] = args.trim().split(/\s+/);
    const word = rest.join(" ");
    if (sub === "list") {
      const words = [...(await repo.stopwords())].sort();
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
      await repo.addStopword(word);
      log.stopword.info({ word }, "/stopword add");
      return `➕ stopword "${word.toLowerCase()}"`;
    }
    if (sub === "del") {
      if (!word) {
        log.stopword.warn("/stopword del rejected: no word given");
        return "usage: /stopword del <word>";
      }
      const n = await repo.delStopword(word);
      log.stopword.info({ word, removed: n }, "/stopword del");
      return n
        ? `➖ removed "${word.toLowerCase()}"`
        : `no stopword "${word.toLowerCase()}"`;
    }
    log.stopword.warn({ sub }, "/stopword rejected: bad subcommand");
    return "usage: /stopword add|del|list [word]";
  }

  async rejections(args: string): Promise<string> {
    const list = await this.d.repo.rejectionList();
    const page = pageIndex(args.trim());
    log.rejections.info({ count: list.length, page }, "/rejections command");
    if (!list.length) return "(no rejections)";
    const lines = list.map((r) => `"${r.surface}" ✗ [[${r.note}]]`);
    return formatListPage(lines, page, REJECTIONS_PAGE, "/rejections");
  }

  /** `/unreject <word> <note>` answers with text. With no arguments it answers with the
   *  rejected words to pick from, or "(no rejections)". */
  async unreject(args: string): Promise<string | UnrejectPicker> {
    const { repo } = this.d;
    const arg = args.trim();
    // The note is the last token, the surface is everything before it.
    if (arg) {
      const i = arg.lastIndexOf(" ");
      if (i < 0)
        return "usage: /unreject <word> <note> (or /unreject with no args for a menu)";
      const surface = arg.slice(0, i);
      const note = arg.slice(i + 1);
      const n = await repo.unreject(surface, note);
      log.unreject.info({ surface, note, removed: n }, "/unreject direct");
      return n
        ? `↩️ "${surface}" may link to [[${note}]] again`
        : `no rejection for "${surface}" → [[${note}]]`;
    }

    const list = await repo.rejectionList();
    if (!list.length) return "(no rejections)";
    const surfaces = distinctSurfaces(list);
    log.unreject.info({ surfaces: surfaces.length }, "/unreject menu opened");
    const shown = surfaces.slice(0, UNREJECT_ROWS);
    const more = surfaces.length - shown.length;
    if (more) log.unreject.info({ more }, "/unreject menu truncated");
    return { surfaces: shown, total: surfaces.length };
  }

  /** The `si`th rejected word and the notes rejected for it. Indices are positions in the
   *  ordered rejection list, re-derived on every tap so nothing is held between messages;
   *  undefined when the list changed under the tap. */
  async rejectedWord(si: number): Promise<RejectedWord | undefined> {
    const list = await this.d.repo.rejectionList();
    const surface = distinctSurfaces(list)[si];
    if (surface === undefined) {
      log.unreject.warn({ si }, "unreject: surface index out of range");
      return undefined;
    }
    return {
      surface,
      notes: list.filter((r) => r.surface === surface).map((r) => r.note),
    };
  }

  /** Undoes the rejection of the `ni`th note of `word`; undefined when that index no
   *  longer exists, so a shifted list never undoes the wrong pair. */
  async unrejectNote(
    word: RejectedWord,
    ni: number,
  ): Promise<{ note: string; removed: number } | undefined> {
    const { surface } = word;
    const note = word.notes[ni];
    if (note === undefined) {
      log.unreject.warn({ surface, ni }, "unreject: note index out of range");
      return undefined;
    }
    const removed = await this.d.repo.unreject(surface, note);
    log.unreject.info({ surface, note, removed }, "unreject via menu");
    return { note, removed };
  }

  private async targetsBetween(lo: string, hi: string): Promise<string[]> {
    const jots = await this.d.repo.jotsInRange(
      dayBounds(lo)[0],
      dayBounds(hi)[1],
    );
    return reprocessTargets(jots);
  }

  /** How many entries reprocessing the days `lo` to `hi` would redo: a squashed follower
   *  counts with its leader, whose line carries the combined text. */
  async reprocessCount(lo: string, hi: string): Promise<number> {
    return (await this.targetsBetween(lo, hi)).length;
  }

  async jotsPage(page: number): Promise<PageView<Jot>> {
    // One extra row tells whether a next page exists without a count query.
    const rows = await this.d.repo.jotsPage(
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
    const jot = id ? await this.d.repo.getJot(id) : undefined;
    if (!jot) return "gone";
    // A stale button or a race with the retry job can leave the jot mid-processing.
    if (!(TERMINAL_STATUSES as readonly JotStatus[]).includes(jot.status)) {
      log.reprocess.warn(
        { id, status: jot.status },
        "reprocess: jot pick rejected: no longer reprocessable",
      );
      return "busy";
    }
    return jot;
  }

  /** Resets what `scope` names to pending and queues it. `queued` is false when nothing
   *  was, and `text` then says why. */
  async reprocessExecute(
    scope: ReprocessScope,
  ): Promise<{ text: string; queued: boolean }> {
    if ("jot" in scope) {
      const jot = await this.d.repo.getJot(scope.jot);
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
    const { queue } = this.d;
    log.reprocess.info({ label, count: targets.length }, "reprocess triggered");
    log.reprocess.debug({ ids: targets }, "reprocess targets");
    // Only what the reset set to pending is queued: a target can race into `processing`
    // between the query and the reset.
    const reset = await this.d.repo.resetForReprocess(targets);
    if (!reset.length)
      return refuse(`No reprocessable jots for ${label} anymore.`);
    queue.add(reset);
    return {
      text: `🔁 Reprocessing ${pluralize(reset.length, "jot")} from ${label}…`,
      queued: true,
    };
  }

  /** Tells the owner how the day went in jots; says nothing on a day without any. */
  async dailySummary(): Promise<void> {
    const s = await this.d.repo.windowStats(startOfToday(), Date.now());
    const failed = s.failed + s.abandoned;
    log.main.info({ jots: s.total, audio: s.audio, failed }, "daily summary");
    if (s.total === 0) return;

    const lines = [`📓 ${plainDate()}`, `Jots: ${s.total} (voice: ${s.audio})`];
    if (failed) lines.push(`⚠️ Failed/abandoned: ${failed}`);
    await this.d.notifier.notify(lines.join("\n"));
  }

  /** Notifies only on an actual new deploy (version or sha changed since the last boot
   *  recorded), so a plain restart on the same image stays quiet. */
  async announceDeploy(): Promise<void> {
    const { repo, github, notifier, build } = this.d;
    const deployId = `${build.version}@${build.sha}`;
    const lastDeployId = await repo.getSetting("deployId");
    if (lastDeployId === deployId) return;
    log.main.info({ deployId, lastDeployId }, "new deploy detected, notifying");
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
      await repo.setSetting("deployId", deployId);
    } catch (err) {
      log.main.warn(
        { err },
        "deploy notice failed to send, will retry next boot",
      );
    }
  }
}

/** Pages are 1-based on the wire (the footer tells the user to type one) and 0-based in
 *  `formatListPage`. */
function pageIndex(raw: string | undefined): number {
  return Math.max(1, Number(raw) || 1) - 1;
}

/** One page of a list, plus a footer naming the window and the command for the next page.
 *  `page` is 0-based and clamped; `cmd` is the command the footer tells the user to retype
 *  with a page number (e.g. "/rejections"). A single-page list gets no footer. */
export function formatListPage(
  items: string[],
  page: number,
  size: number,
  cmd: string,
  sep = "\n",
): string {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const shown = items.slice(p * size, p * size + size);
  const body = shown.join(sep);
  if (pages === 1) return body;
  const from = p * size + 1;
  const nav =
    p + 1 < pages ? `next: ${cmd} ${p + 2}` : `back to the start: ${cmd} 1`;
  return `${body}\n\nShowing ${from}–${from + shown.length - 1} of ${items.length} · page ${p + 1}/${pages} · ${nav}`;
}

/** /stats body for a labelled window. */
export function formatStats(label: string, s: Stats): string {
  const tail = [
    s.inflight ? `in-flight ${s.inflight}` : "",
    s.failed ? `failed ${s.failed}` : "",
    s.abandoned ? `abandoned ${s.abandoned}` : "",
  ].filter(Boolean);
  return [
    `📊 ${label}`,
    `Jots: ${s.total}`,
    `  text ${s.text} · voice ${s.audio} · image ${s.image} · video ${s.video}`,
    `Done ${s.done}${tail.length ? ` · ${tail.join(" · ")}` : ""}`,
  ].join("\n");
}

export interface StatusView {
  counts: StatusCounts;
  queueDepth: number;
  transcriber: string;
  links: { enabled: boolean; files: number; aliases: number };
  version: string;
  sha: string;
  uptimeMs: number;
}

/** /status body: health at a glance. */
export function formatStatus(v: StatusView): string {
  const c = v.counts;
  const links = v.links.enabled
    ? `${v.links.files} files / ${v.links.aliases} aliases`
    : "disabled";
  return [
    `🩺 scriba ${v.version} (${v.sha.slice(0, 7)})`,
    `Uptime: ${formatDuration(v.uptimeMs)}`,
    `Jots: ${c.done} done · ${c.pending + c.processing} in-flight · ${c.failed} failed · ${c.abandoned} abandoned`,
    `Queue depth: ${v.queueDepth}`,
    `Transcriber: ${v.transcriber}`,
    `Link index: ${links}`,
  ].join("\n");
}

/** /status block for the health monitor: one line per upstream. An error line is capped,
 *  since a fetch error can carry a whole cause chain. */
export function formatHealth(rows: UpstreamStatus[], now: number): string {
  const lines = ["Upstreams:"];
  for (const r of rows) {
    // 🟡 is one failed probe: an error on show, but not yet the two that make it down.
    const dot = !r.up ? "🔴" : r.failures ? "🟡" : "🟢";
    const parts = [`${dot} ${r.name}`];
    if (!r.up) parts.push(`down ${formatDuration(now - r.since)}`);
    parts.push(r.latencyMs === null ? "not probed yet" : `${r.latencyMs} ms`);
    if (r.error) parts.push(clipUpdate(r.error, 120));
    lines.push(parts.join(" · "));
  }
  return lines.join("\n");
}

/** GitHub Release bodies are conventional-changelog markdown: `### Section` headers and
 *  `* item ([#N](url)) ([sha](url))` bullets. Telegram gets plain text, not markdown, so
 *  this strips the `#`/`*` markers and the trailing commit/issue link refs, leaving
 *  `Section:` labels and `• item` bullets. */
function formatChangelogMarkdown(body: string): string {
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.*)/);
    if (heading) {
      if (out.length) out.push("");
      out.push(`${heading[1]!}:`);
      continue;
    }
    const item = line.match(/^[*-]\s+(.*)/);
    if (item) {
      const text = item[1]!.replace(/\s*\(\[[^\]]+\]\([^)]+\)\)/g, "").trim();
      out.push(`• ${text}`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Release body + link, shared by the deploy notice and /changelog. */
function formatReleaseBody(note: ReleaseNote): string {
  const lines: string[] = [];
  const body = formatChangelogMarkdown(note.body).trim();
  if (body) lines.push(body);
  lines.push(note.url);
  return lines.join("\n\n");
}

/** Boot notice sent once when the running version/sha differs from the last known deploy.
 *  `note` is this version's GitHub Release, fetched live, so the notice shows what
 *  actually changed. Omitted when the lookup fails. */
export function formatDeployNotice(
  version: string,
  sha: string,
  note?: ReleaseNote | null,
): string {
  const header = `🚀 scriba deployed — ${version} (${sha.slice(0, 7)})`;
  return note ? [header, formatReleaseBody(note)].join("\n\n") : header;
}

/** /changelog body for one version. */
export function formatReleaseNote(note: ReleaseNote): string {
  return [`📋 ${note.name}`, formatReleaseBody(note)].join("\n\n");
}

/** /changelog N: a compact list of the N most recent releases. */
export function formatReleaseList(notes: ReleaseNote[]): string {
  if (!notes.length) return "no releases found";
  return notes
    .map(
      (n) => `• ${n.tag} (${plainDate(Date.parse(n.publishedAt))}) — ${n.url}`,
    )
    .join("\n");
}
