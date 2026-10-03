import type { UpstreamStatus } from "../domain/health/structures.ts";
import type { Stats, StatusCounts } from "../domain/jot/structures.ts";
import type { ReleaseNote } from "../domain/release/structures.ts";
import { paginate } from "./page.ts";
import { clipUpdate, formatDuration } from "./text.ts";
import { plainDate } from "./time.ts";

export function formatListPage(
  items: string[],
  page: number,
  size: number,
  cmd: string,
  sep = "\n",
): string {
  const {
    items: shown,
    page: current,
    pages,
    offset,
  } = paginate(items, page, size);
  const body = shown.join(sep);
  if (pages === 1) return body;
  const from = offset + 1;
  const nav =
    current + 1 < pages
      ? `next: ${cmd} ${current + 2}`
      : `back to the start: ${cmd} 1`;
  return `${body}\n\nShowing ${from}–${from + shown.length - 1} of ${items.length} · page ${current + 1}/${pages} · ${nav}`;
}

export function formatStats(label: string, stats: Stats): string {
  const tail = [
    stats.inflight ? `in-flight ${stats.inflight}` : "",
    stats.failed ? `failed ${stats.failed}` : "",
    stats.abandoned ? `abandoned ${stats.abandoned}` : "",
  ].filter(Boolean);
  return [
    `📊 ${label}`,
    `Jots: ${stats.total}`,
    `  text ${stats.text} · voice ${stats.audio} · image ${stats.image} · video ${stats.video}`,
    `Done ${stats.done}${tail.length ? ` · ${tail.join(" · ")}` : ""}`,
  ].join("\n");
}

interface StatusView {
  counts: StatusCounts;
  queueDepth: number;
  transcriber: string;
  links: { enabled: boolean; files: number; aliases: number };
  version: string;
  sha: string;
  uptimeMs: number;
}

export function formatStatus(view: StatusView): string {
  const counts = view.counts;
  const links = view.links.enabled
    ? `${view.links.files} files / ${view.links.aliases} aliases`
    : "disabled";
  return [
    `🩺 scriba ${view.version} (${view.sha.slice(0, 7)})`,
    `Uptime: ${formatDuration(view.uptimeMs)}`,
    `Jots: ${counts.done} done · ${counts.pending + counts.processing} in-flight · ${counts.failed} failed · ${counts.abandoned} abandoned`,
    `Queue depth: ${view.queueDepth}`,
    `Transcriber: ${view.transcriber}`,
    `Link index: ${links}`,
  ].join("\n");
}

export function formatHealth(rows: UpstreamStatus[], now: number): string {
  const lines = ["Upstreams:"];
  for (const row of rows) {
    // 🟡 is one failed probe: an error on show, but not yet the two that make it down.
    const dot = !row.up ? "🔴" : row.failures ? "🟡" : "🟢";
    const parts = [`${dot} ${row.name}`];
    if (!row.up) parts.push(`down ${formatDuration(now - row.since)}`);
    parts.push(
      row.latencyMs === null ? "not probed yet" : `${row.latencyMs} ms`,
    );
    if (row.error) parts.push(clipUpdate(row.error, 120));
    lines.push(parts.join(" · "));
  }
  return lines.join("\n");
}

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

function formatReleaseBody(note: ReleaseNote): string {
  const lines: string[] = [];
  const body = formatChangelogMarkdown(note.body).trim();
  if (body) lines.push(body);
  lines.push(note.url);
  return lines.join("\n\n");
}

export function formatDeployNotice(
  version: string,
  sha: string,
  note?: ReleaseNote | null,
): string {
  const header = `🚀 scriba deployed — ${version} (${sha.slice(0, 7)})`;
  return note ? [header, formatReleaseBody(note)].join("\n\n") : header;
}

export function formatReleaseNote(note: ReleaseNote): string {
  return [`📋 ${note.name}`, formatReleaseBody(note)].join("\n\n");
}

export function formatReleaseList(notes: ReleaseNote[]): string {
  if (!notes.length) return "no releases found";
  return notes
    .map(
      (note) =>
        `• ${note.tag} (${plainDate(Date.parse(note.publishedAt))}) — ${note.url}`,
    )
    .join("\n");
}
