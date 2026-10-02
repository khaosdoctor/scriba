import type { UpstreamStatus } from "../domain/health/structures.ts";
import type { Stats, StatusCounts } from "../domain/jot/structures.ts";
import type { ReleaseNote } from "../domain/release/structures.ts";
import { clipUpdate } from "./feed.ts";
import { paginate } from "./page.ts";
import { formatDuration } from "./text.ts";
import { plainDate } from "./time.ts";

export function formatListPage(
  items: string[],
  page: number,
  size: number,
  cmd: string,
  sep = "\n",
): string {
  const { items: shown, page: p, pages, offset } = paginate(items, page, size);
  const body = shown.join(sep);
  if (pages === 1) return body;
  const from = offset + 1;
  const nav =
    p + 1 < pages ? `next: ${cmd} ${p + 2}` : `back to the start: ${cmd} 1`;
  return `${body}\n\nShowing ${from}–${from + shown.length - 1} of ${items.length} · page ${p + 1}/${pages} · ${nav}`;
}

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
      (n) => `• ${n.tag} (${plainDate(Date.parse(n.publishedAt))}) — ${n.url}`,
    )
    .join("\n");
}
