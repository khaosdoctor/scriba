import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_UPDATE_CHARS,
  clipUpdate,
  feedMessage,
  fitFeed,
  formatToolCall,
  queuedNotice,
  thoughtIcon,
  toolIcon,
} from "./feed.ts";
import { TELEGRAM_LIMIT } from "./text.ts";

test("feedMessage puts the tail under the header", () => {
  assert.equal(feedMessage("🧭 Working…", []), "🧭 Working…");
  assert.equal(
    feedMessage("🧭 Working…", ["📖 read a.md", "✍️ wrote b.md"]),
    "🧭 Working…\n\n📖 read a.md\n✍️ wrote b.md",
  );
});

test("fitFeed drops the oldest lines until the message fits", () => {
  const lines = Array.from(
    { length: 20 },
    (_, i) => `line ${i} ${"x".repeat(300)}`,
  );
  const kept = fitFeed("head", lines);
  assert.ok(feedMessage("head", kept).length <= TELEGRAM_LIMIT);
  // The newest survive, the oldest are the ones that go.
  assert.equal(kept.at(-1), lines.at(-1));
  assert.ok(!kept.includes(lines[0]!));
  // Nothing to drop when it already fits.
  assert.deepEqual(fitFeed("head", ["a", "b"]), ["a", "b"]);
  assert.deepEqual(fitFeed("head", []), []);
  // One line over the limit is still shown: something has to be on screen.
  assert.equal(fitFeed("head", ["y".repeat(5000)]).length, 1);
});

test("toolIcon says which tool without the mcp prefix", () => {
  assert.equal(toolIcon("mcp__vault__vault_read"), "📖");
  assert.equal(toolIcon("mcp__vault__vault_write"), "✍️");
  assert.equal(toolIcon("mcp__vault__vault_delete"), "🗑");
  assert.equal(toolIcon("WebSearch"), "🔎");
  // An unknown tool still gets a line, just a generic one.
  assert.equal(toolIcon("mcp__vault__something_new"), "🔧");
});

test("thoughtIcon reflects what the line is about", () => {
  assert.equal(thoughtIcon("searching for the meeting note"), "🔍");
  assert.equal(thoughtIcon("Reading notes/a.md first"), "📖");
  assert.equal(thoughtIcon("writing the note now"), "✍️");
  assert.equal(thoughtIcon("deleting the stale one"), "🗑");
  assert.equal(thoughtIcon("fetching the page"), "🌐");
  assert.equal(thoughtIcon("that failed, trying again"), "⚠️");
  assert.equal(thoughtIcon("matching the vault's voice"), "🎨");
  // Nothing recognisable is still a thought.
  assert.equal(thoughtIcon("hmm"), "💭");
  assert.equal(thoughtIcon(""), "💭");
});

test("clipUpdate flattens to one line and caps the length", () => {
  assert.equal(clipUpdate("  one\n\ttwo   three "), "one two three");
  const long = `${"word ".repeat(200)}end`;
  const out = clipUpdate(long);
  assert.ok(out.length <= AGENT_UPDATE_CHARS);
  // The cut falls on a word boundary, so the last word isn't left half-written.
  assert.match(out, /^(word )+word…$/);
  // A single unbroken run still gets cut, boundary or not.
  assert.equal(clipUpdate("x".repeat(500)).length, AGENT_UPDATE_CHARS);
  assert.equal(clipUpdate("short", 10), "short");
});

test("formatToolCall names the tool and what it is acting on", () => {
  assert.equal(
    formatToolCall("mcp__vault__vault_read", { path: "notes/a.md" }),
    "vault_read · notes/a.md",
  );
  assert.equal(
    formatToolCall("mcp__vault__vault_search", { query: "kubernetes" }),
    "vault_search · kubernetes",
  );
  // A write carries the whole note; its size is the useful part, never the body.
  assert.equal(
    formatToolCall("mcp__vault__vault_write", {
      path: "notes/a.md",
      content: "hello",
    }),
    "vault_write · notes/a.md (5 chars)",
  );
  assert.equal(
    formatToolCall("WebSearch", { query: "scriba" }),
    "WebSearch · scriba",
  );
  assert.equal(formatToolCall("mcp__vault__vault_list", {}), "vault_list");
  // A server name with an underscore in it still loses only the prefix.
  assert.equal(formatToolCall("mcp__my_server__do_it", {}), "do_it");
});

test("queuedNotice says how many are ahead", () => {
  assert.match(queuedNotice(1), /1 message ahead/);
  assert.match(queuedNotice(3), /3 messages ahead/);
});
