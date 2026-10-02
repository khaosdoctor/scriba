import { pluralize, TELEGRAM_LIMIT } from "./text.ts";

export const AGENT_UPDATE_CHARS = 330;

export function feedMessage(header: string, lines: string[]): string {
  return lines.length ? `${header}\n\n${lines.join("\n")}` : header;
}

export function fitFeed(
  header: string,
  lines: string[],
  limit = TELEGRAM_LIMIT,
): string[] {
  const kept = [...lines];
  while (kept.length > 1 && feedMessage(header, kept).length > limit)
    kept.shift();
  return kept;
}

const TOOL_ICONS: Record<string, string> = {
  vault_read: "📖",
  vault_list: "📂",
  vault_search: "🔍",
  vault_write: "✍️",
  vault_delete: "🗑",
  web_fetch: "🌐",
  WebSearch: "🔎",
};

/** What a line of the agent's own words is about. First match wins, so the specific
 *  patterns come before the general ones. */
const THOUGHT_ICONS: [RegExp, string][] = [
  [/\b(delet|remov|drop)/i, "🗑"],
  [/\b(writ|creat|draft|updat|add)/i, "✍️"],
  [/\b(search|find|look(ing)? for|grep)/i, "🔍"],
  [/\b(read|open|check(ing)? the|inspect)/i, "📖"],
  [/\b(list|folder|director)/i, "📂"],
  [/\b(fetch|web|http|url|site|page|research)/i, "🌐"],
  [/\b(style|voice|tone|match|convention|shape)/i, "🎨"],
  [/\b(date|day|yesterday|today|journal)/i, "📅"],
  [/\b(link|wikilink|backlink)/i, "🔗"],
  [/\b(fail|error|wrong|can'?t|couldn'?t|problem)/i, "⚠️"],
  [/\b(done|finish|complete|ready|saved)/i, "✅"],
  [/\b(ask|question|clarif|unsure|not sure)/i, "❓"],
  [/\b(plan|first|then|next|need to|should)/i, "🧭"],
];

export function toolIcon(name: string): string {
  return TOOL_ICONS[name.replace(/^mcp__.*?__/, "")] ?? "🔧";
}

export function thoughtIcon(text: string): string {
  for (const [pattern, icon] of THOUGHT_ICONS)
    if (pattern.test(text)) return icon;
  return "💭";
}

export function clipUpdate(text: string, max = AGENT_UPDATE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const body = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${body.trimEnd()}…`;
}

const TOOL_ARGS = ["path", "url", "query", "dir", "pattern", "prompt"];

export function formatToolCall(
  name: string,
  input: Record<string, unknown> = {},
): string {
  const label = name.replace(/^mcp__.*?__/, "");
  const key = TOOL_ARGS.find(
    (k) => typeof input[k] === "string" && (input[k] as string).trim(),
  );
  const detail = key ? ` · ${String(input[key]).trim()}` : "";
  // A write carries the whole note; its size is the useful part, never the body.
  const size =
    typeof input.content === "string" ? ` (${input.content.length} chars)` : "";
  return `${label}${detail}${size}`;
}

export function silentNotice(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  return `⚠️ The assistant went quiet — nothing at all for ${pluralize(mins, "minute")}, so I stopped waiting on it. Send that again and it picks the conversation up where it left off.`;
}

export function queuedNotice(ahead: number): string {
  return `🕐 Queued — ${pluralize(ahead, "message")} ahead of this one. It goes to the assistant as soon as that's done, and the reply lands here.`;
}
