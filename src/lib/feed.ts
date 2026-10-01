// While the vault assistant works, its reasoning, tool calls and intermediate prose are
// relayed to the chat as they happen. Those are chatter around the answer, not the answer:
// each one is flattened to a single line and hard-capped, so a long thought or a note-sized
// tool argument can't bury the conversation. They all live inside the turn's one status
// message, which is rewritten as they arrive; a message per thought floods the chat.
import { pluralize, TELEGRAM_LIMIT } from "./text.ts";

/** Hard cap on one live agent update. */
export const AGENT_UPDATE_CHARS = 330;

/** The live status message: a header, then the tail of what the agent has been up to. */
export function feedMessage(header: string, lines: string[]): string {
  return lines.length ? `${header}\n\n${lines.join("\n")}` : header;
}

/** Drop lines off the front until the rendered message fits. The message is a live view of
 *  what the agent is doing now, not a transcript, so the oldest line is the one to lose,
 *  and what's left is what the next render starts from, so the tail can't grow unbounded.
 *  The newest line is always kept, even alone: something has to be on screen. */
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

// A uniform 💭 on every line makes the feed one grey wall. Each line gets an emoji for what
// it actually is instead, so a glance says which part of the job the agent is on. The
// choice is a lookup, never a model call: this is display, and display must not cost a
// token or a round trip.

/** One per tool, keyed by the bare name `formatToolCall` produces. */
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

/** Emoji for a tool call. Unknown tools keep the generic wrench. */
export function toolIcon(name: string): string {
  return TOOL_ICONS[name.replace(/^mcp__.*?__/, "")] ?? "🔧";
}

/** Emoji for a line the agent wrote: its reasoning, or prose along the way. */
export function thoughtIcon(text: string): string {
  for (const [pattern, icon] of THOUGHT_ICONS)
    if (pattern.test(text)) return icon;
  return "💭";
}

/** Flatten to one line and cut to `max` characters, on a word boundary where there is one
 *  near the end. The returned string is never longer than `max`. */
export function clipUpdate(text: string, max = AGENT_UPDATE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const body = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${body.trimEnd()}…`;
}

/** Arguments worth showing on a live tool line, most identifying first. */
const TOOL_ARGS = ["path", "url", "query", "dir", "pattern", "prompt"];

/** One-line rendering of a tool call: the bare tool name (the `mcp__<server>__` prefix is
 *  noise here) plus the argument that says what it is acting on. */
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

/** What a turn that stopped producing anything is answered with. The conversation itself
 *  survives (the next prompt resumes the session id), so the way out is to ask again. */
export function silentNotice(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  return `⚠️ The assistant went quiet — nothing at all for ${pluralize(mins, "minute")}, so I stopped waiting on it. Send that again and it picks the conversation up where it left off.`;
}

/** Status line for a prompt that arrived while the assistant was still on an earlier one.
 *  It says the message was seen, which is the whole point of accepting it right away. */
export function queuedNotice(ahead: number): string {
  return `🕐 Queued — ${pluralize(ahead, "message")} ahead of this one. It goes to the assistant as soon as that's done, and the reply lands here.`;
}
