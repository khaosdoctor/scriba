import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentService } from "../services/agent.ts";
import { CommandController } from "./command.ts";
import { Modes } from "./modes.ts";

/** Let the controller's promise chains (agent stream, serialized Telegram sends) run out. */
const settle = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 1));
};

/**
 * A stand-in for the agent SDK's `query`: records the prompts pushed into its streaming
 * input and lets a test emit stream messages back whenever it likes, so the interleaving
 * a real agent produces can be reproduced exactly.
 */
class FakeAgent {
  prompts: string[] = [];
  interrupts = 0;
  options: any;
  private out: any[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  query = (params: any) => {
    this.options = params.options;
    void this.drain(params.prompt);
    const self = this;
    const gen = (async function* () {
      for (;;) {
        while (self.out.length) yield self.out.shift();
        if (self.ended) return;
        await new Promise<void>((r) => {
          self.wake = r;
        });
      }
    })();
    (gen as any).interrupt = async () => {
      self.interrupts++;
    };
    return gen as any;
  };

  private async drain(stream: AsyncIterable<any>): Promise<void> {
    // The same shape the CLI is handed: {role, content: [{type:"text", text}]}.
    for await (const m of stream) this.prompts.push(m.message.content[0].text);
  }

  emit(msg: any): void {
    this.out.push(msg);
    this.wake?.();
    this.wake = null;
  }
  /** End the query's output stream, as an SDK crash or a torn-down CLI would. */
  end(): void {
    this.ended = true;
    this.wake?.();
    this.wake = null;
  }
}

const assistant = (...content: any[]) => ({
  type: "assistant",
  message: { content },
});
const result = (text?: string, subtype = "success") => ({
  type: "result",
  subtype,
  session_id: "s1",
  ...(text === undefined ? {} : { result: text }),
});

type Sent = { text: string; id: number; opts: any };

/** A controller wired to a chat that only records, opened unless the vault is missing. */
async function harness(
  feedEditMs = 0,
  turnSilenceMs = 30_000,
  vaultEnabled = true,
  idleMs = 60_000,
) {
  const sent: Sent[] = [];
  const edits: { msg: number; text: string; opts: any }[] = [];
  const notices: string[] = [];
  let nextId = 100;
  const failSends = { on: false };
  const notifier = {
    notify: async (text: string) => void notices.push(text),
    send: async (text: string, opts: any = {}) => {
      if (failSends.on) throw new Error("telegram is down");
      const id = nextId++;
      sent.push({ text, id, opts });
      return id;
    },
    edit: async (msg: number, text: string, opts: any = {}) =>
      void edits.push({ msg, text, opts }),
  };
  const vault = { enabled: vaultEnabled };
  const web = { fetchPage: async () => "# AI Writing Tropes to Avoid\nnope" };
  const agent = new FakeAgent();
  const service = new AgentService(
    vault as any,
    web as any,
    { model: "m", thinkingTokens: 4000 },
    agent.query as any,
  );
  const modes = new Modes(notifier, idleMs);
  const command: any = new CommandController(
    { service, notifier, modes },
    feedEditMs,
    turnSilenceMs,
  );

  /** The status message of each prompt, oldest first. */
  const replies: Sent[] = [];
  /** Deliver a message the way the text view does: the owner's own message id is what
   *  everything about that turn should hang off. Returns that id. */
  const say = async (text: string): Promise<number> => {
    const incoming = nextId++;
    const before = sent.length;
    await command.handle(text, incoming);
    const status = sent[before];
    if (status) replies.push(status);
    return incoming;
  };
  /** Every send that is not a prompt's status message. */
  const extra = () => sent.filter((s) => !replies.includes(s));

  const opened = command.open();
  return {
    command,
    modes,
    agent,
    say,
    replies,
    extra,
    edits,
    notices,
    failSends,
    opened,
  };
}

/** The text of every edit made to one message, oldest first. */
const editsTo = (edits: { msg: number; text: string }[], id: number) =>
  edits.filter((e) => e.msg === id).map((e) => e.text);

/** What a recorded send is threaded under, if anything. */
const repliedTo = (call: { opts: any }) => call.opts?.replyTo;

/** The callback data behind a status message's ⏹ Stop button. */
const stopData = (reply: { opts: any }) =>
  reply.opts.keyboard.inline_keyboard[0][0].callback_data as string;

/** The id after `cm:s:` on a status message. */
const turnId = (reply: { opts: any }) => stopData(reply).split(":")[2];

/** Press Stop the way the view does, collecting the toasts. */
const stop = async (command: any, id?: string): Promise<string[]> => {
  const answered: string[] = [];
  await command.stop(id, async (toast: string) => void answered.push(toast));
  return answered;
};

const WRITE = "mcp__vault__vault_write";
const DELETE = "mcp__vault__vault_delete";

/** The ✅/❌ callback data on a confirmation message. */
const confirmData = (call: { opts: any }) =>
  call.opts.keyboard.inline_keyboard[0].map(
    (b: any) => b.callback_data as string,
  );

test("a message sent while the agent is working is accepted, not refused", async () => {
  const { agent, say, replies } = await harness();
  const m1 = await say("first");
  await settle();
  const m2 = await say("second");
  await settle();

  assert.equal(replies.length, 2);
  assert.match(replies[0]!.text, /Working/);
  // The second one says it was seen and where it is in the queue.
  assert.match(replies[1]!.text, /Queued/);
  assert.match(replies[1]!.text, /1 message ahead/);
  // Each status message hangs off the message that asked for it.
  assert.equal(repliedTo(replies[0]!), m1);
  assert.equal(repliedTo(replies[1]!), m2);
  // Only the first prompt is with the agent; the second waits its turn.
  assert.deepEqual(agent.prompts, ["first"]);
});

test("handle returns without waiting for the agent", async () => {
  const { agent, say } = await harness();
  // No result is ever emitted: if handle awaited the answer, this would hang.
  await say("first");
  await settle();
  assert.deepEqual(agent.prompts, ["first"]);
});

test("each answer arrives on the message that asked for it", async () => {
  const { agent, say, replies, edits } = await harness();
  await say("first");
  await settle();
  await say("second");
  await settle();

  agent.emit(assistant({ type: "text", text: "one done" }));
  agent.emit(result());
  await settle();

  const firstId = replies[0]!.id;
  const secondId = replies[1]!.id;
  // The first prompt's status message became its answer, and lost its button.
  const answer = edits.find((e) => e.msg === firstId && e.text === "one done");
  assert.ok(answer, "the first prompt's message was edited into the answer");
  assert.deepEqual(answer!.opts.keyboard.inline_keyboard.flat(), []);
  // The second was handed over and its message promoted out of the queue.
  assert.deepEqual(agent.prompts, ["first", "second"]);
  assert.ok(edits.some((e) => e.msg === secondId && /Working/.test(e.text)));

  agent.emit(assistant({ type: "text", text: "two done" }));
  agent.emit(result());
  await settle();
  assert.ok(edits.some((e) => e.msg === secondId && e.text === "two done"));
});

test("the live feed rewrites one message instead of posting more", async () => {
  const { agent, say, replies, extra, edits } = await harness();
  const m1 = await say("write a note");
  await settle();

  agent.emit(
    assistant(
      { type: "thinking", thinking: `let me read the note ${"x".repeat(600)}` },
      {
        type: "tool_use",
        name: "mcp__vault__vault_read",
        input: { path: "notes/a.md" },
      },
    ),
  );
  await settle();

  // Not one message per thought: that's what buried the chat.
  assert.deepEqual(extra(), []);
  const status = replies[0]!;
  assert.equal(repliedTo(status), m1);
  const latest = editsTo(edits, status.id).at(-1)!;
  // The header stays, and the feed accumulates under it in order.
  assert.match(latest, /^🧭 Working…\n\n/);
  assert.match(latest, /let me read the note/);
  assert.match(latest, /📖 vault_read · notes\/a\.md$/);
  // Each line is still capped, so one long thought can't fill the message.
  for (const line of latest.split("\n").slice(2))
    assert.ok(line.length <= 330, `feed line too long: ${line.length}`);
});

test("each line carries an emoji for what it is", async () => {
  const { agent, say, replies, edits } = await harness();
  await say("go");
  await settle();

  agent.emit(
    assistant(
      { type: "thinking", thinking: "let me search for the meeting note" },
      { type: "tool_use", name: "mcp__vault__vault_search", input: {} },
      {
        type: "tool_use",
        name: "mcp__vault__vault_write",
        input: { path: "a.md" },
      },
      { type: "tool_use", name: "WebSearch", input: {} },
      { type: "tool_use", name: "mcp__vault__mystery_tool", input: {} },
    ),
  );
  await settle();

  const lines = editsTo(edits, replies[0]!.id).at(-1)!.split("\n").slice(2);
  assert.deepEqual(
    lines.map((l) => l.split(" ")[0]),
    ["🔍", "🔍", "✍️", "🔎", "🔧"],
  );
});

test("the feed drops its oldest lines rather than outgrow the message", async () => {
  const { agent, say, replies, edits } = await harness();
  await say("go");
  await settle();

  // Each thought clips to 330 characters, so ~13 of them pass Telegram's 4096 cap.
  for (let i = 0; i < 30; i++) {
    agent.emit(
      assistant({ type: "thinking", thinking: `step ${i} ${"x".repeat(400)}` }),
    );
    await settle(2);
  }

  const latest = editsTo(edits, replies[0]!.id).at(-1)!;
  assert.ok(latest.length <= 4096, `message is ${latest.length} characters`);
  // The newest line survives; the oldest ones are the ones that went.
  assert.match(latest, /step 29/);
  assert.ok(!latest.includes("step 0 "));
});

test("feed edits are throttled, so a busy agent doesn't hammer Telegram", async () => {
  // An interval far longer than the test: whatever arrives after the first edit waits for it.
  const { agent, say, replies, edits } = await harness(10_000);
  await say("go");
  await settle();
  const before = editsTo(edits, replies[0]!.id).length;

  for (const t of ["one", "two", "three"]) {
    agent.emit(assistant({ type: "thinking", thinking: t }));
    await settle();
  }
  assert.equal(
    editsTo(edits, replies[0]!.id).length - before,
    1,
    "three updates in quick succession should coalesce into one edit",
  );
});

test("prose written mid-run joins the feed; the closing prose is the answer", async () => {
  const { agent, say, replies, edits } = await harness();
  await say("go");
  await settle();

  // Spaced out, the way a real run arrives: prose, then the tool call that supersedes it.
  // (A turn that finishes before the next render just skips that frame: the answer wins.)
  agent.emit(assistant({ type: "text", text: "reading the folder first" }));
  await settle();
  agent.emit(
    assistant({
      type: "tool_use",
      name: "mcp__vault__vault_list",
      input: { dir: "notes" },
    }),
  );
  await settle();
  agent.emit(assistant({ type: "text", text: "wrote notes/a.md" }));
  agent.emit(result());
  await settle();

  const seen = editsTo(edits, replies[0]!.id);
  assert.ok(seen.some((t) => t.includes("reading the folder first")));
  // The last block is the answer: the message ends as that alone, feed cleared away.
  assert.equal(seen.at(-1), "wrote notes/a.md");
});

test("the feed follows whichever prompt is being answered", async () => {
  const { agent, say, replies, edits } = await harness();
  await say("first");
  await settle();
  await say("second");
  await settle();

  agent.emit(assistant({ type: "thinking", thinking: "on the first" }));
  await settle();
  agent.emit(result("first answered"));
  await settle();
  // The queue has moved on: the next turn's chatter belongs to the next message.
  agent.emit(assistant({ type: "thinking", thinking: "on the second" }));
  await settle();

  const one = editsTo(edits, replies[0]!.id);
  const two = editsTo(edits, replies[1]!.id);
  assert.ok(one.some((t) => t.includes("on the first")));
  assert.equal(
    one.at(-1),
    "first answered",
    "the answer is the last word on it",
  );
  assert.ok(two.some((t) => t.includes("on the second")));
  assert.ok(!two.some((t) => t.includes("on the first")));
});

test("a failing tool result gets a line, a successful one does not", async () => {
  const { agent, say, replies, edits } = await harness();
  await say("go");
  await settle();

  agent.emit({
    type: "user",
    message: {
      content: [
        { type: "tool_result", is_error: true, content: "no such note" },
        { type: "tool_result", content: "# fine" },
      ],
    },
  });
  await settle();

  const lines = editsTo(edits, replies[0]!.id).at(-1)!.split("\n").slice(2);
  assert.deepEqual(lines, ["⚠️ no such note"]);
});

test("Stop interrupts the running turn and closes its message", async () => {
  const { command, agent, say, replies, edits } = await harness();
  await say("long one");
  await settle();

  assert.deepEqual(await stop(command, turnId(replies[0]!)), ["stopping…"]);
  await settle();
  assert.equal(agent.interrupts, 1);

  // The interrupt comes back as a result; the turn settles as stopped, not as an answer.
  agent.emit(result(undefined, "error_during_execution"));
  await settle();
  const last = edits.filter((e) => e.msg === replies[0]!.id).at(-1);
  assert.match(last!.text, /Stopped/);
});

test("Stop on a queued prompt drops it without touching the agent", async () => {
  const { command, agent, say, replies, edits } = await harness();
  await say("first");
  await settle();
  await say("second");
  await settle();

  assert.deepEqual(await stop(command, turnId(replies[1]!)), ["dropped"]);
  await settle();

  assert.equal(agent.interrupts, 0);
  assert.match(
    edits.filter((e) => e.msg === replies[1]!.id).at(-1)!.text,
    /Dropped/,
  );
  // And it never reaches the agent, even after the running turn finishes.
  agent.emit(result("done"));
  await settle();
  assert.deepEqual(agent.prompts, ["first"]);
});

test("a stop for a turn that already finished says so", async () => {
  const { command, agent, say, replies } = await harness();
  await say("go");
  await settle();
  agent.emit(result("done"));
  await settle();

  assert.deepEqual(await stop(command, turnId(replies[0]!)), [
    "nothing to stop",
  ]);
});

test("a query that dies is rebuilt, and the queue keeps moving", async () => {
  const { agent, say, replies, edits } = await harness();
  await say("first");
  await settle();
  await say("second");
  await settle();

  agent.end(); // the CLI exits mid-turn
  await settle();

  // The turn it was on says so rather than spinning forever…
  assert.match(
    edits.filter((e) => e.msg === replies[0]!.id).at(-1)!.text,
    /stopped early/,
  );
  // …and the waiting prompt goes to a fresh query, resuming the same conversation.
  assert.deepEqual(agent.prompts, ["first", "second"]);
});

test("closing the session answers everything still in flight", async () => {
  const { command, modes, agent, say, replies, edits } = await harness();
  await say("first");
  await settle();
  await say("second");
  await settle();

  modes.close();
  await settle();

  assert.equal(command.isOpen(), false);
  assert.equal(agent.interrupts, 1);
  assert.match(
    edits.filter((e) => e.msg === replies[0]!.id).at(-1)!.text,
    /Command mode closed — this one stopped/,
  );
  assert.match(
    edits.filter((e) => e.msg === replies[1]!.id).at(-1)!.text,
    /Command mode closed — this one never ran/,
  );
});

test("a session nobody talks to closes itself: in-flight prompts are answered and the owner is told", async () => {
  const IDLE = 40;
  const { command, agent, say, replies, edits, notices } = await harness(
    0,
    30_000,
    true,
    IDLE,
  );
  await say("first");
  await settle();
  await say("second");
  await settle();

  await new Promise((r) => setTimeout(r, IDLE * 2));
  await settle();

  assert.equal(command.isOpen(), false);
  assert.ok(agent.interrupts >= 1, "the query was torn down with the session");
  assert.match(
    editsTo(edits, replies[0]!.id).at(-1)!,
    /Command mode closed — this one stopped/,
  );
  assert.match(
    editsTo(edits, replies[1]!.id).at(-1)!,
    /Command mode closed — this one never ran/,
  );
  assert.deepEqual(notices, [
    "🧭 Command mode timed out — back to journaling.",
  ]);
});

test("the agent is given a thinking budget, so there is reasoning to relay", async () => {
  const { agent, say } = await harness();
  await say("go");
  await settle();
  assert.ok(agent.options.maxThinkingTokens > 0);
});

/** Long enough that the timer fires within a test, short enough not to slow it down. */
const SILENCE = 40;
const silence = () => new Promise((r) => setTimeout(r, SILENCE * 2));

test("a turn that goes silent is given up on, and the queue moves", async () => {
  const { agent, say, replies, edits } = await harness(0, SILENCE);
  await say("first");
  await settle();
  await say("second");
  await settle();

  // The agent takes the prompt, does some work, then stops producing anything at all:
  // no result, and the query never ends. Without the watchdog this wedges the session,
  // since `active` stays set and every later message queues behind it forever.
  agent.emit(
    assistant({
      type: "tool_use",
      name: "mcp__vault__vault_read",
      input: { path: "notes/Athens.md" },
    }),
  );
  await settle();
  await silence();

  assert.match(editsTo(edits, replies[0]!.id).at(-1)!, /went quiet/);
  assert.ok(
    agent.interrupts >= 1,
    "the dead query is interrupted, not left running",
  );
  // The waiting prompt is handed to a fresh query rather than stuck behind a dead turn.
  assert.deepEqual(agent.prompts, ["first", "second"]);
});

test("the agent doing anything at all resets the silence timer", async () => {
  const { agent, say, replies, edits } = await harness(0, SILENCE);
  await say("go");
  await settle();

  // Something every half-window: the turn is alive, so it must not be given up on.
  for (let i = 0; i < 6; i++) {
    agent.emit(assistant({ type: "thinking", thinking: `step ${i}` }));
    await new Promise((r) => setTimeout(r, SILENCE / 2));
  }
  assert.ok(
    !editsTo(edits, replies[0]!.id).some((t) => t.includes("went quiet")),
    "a working turn was killed",
  );

  agent.emit(result("done"));
  await settle();
  assert.equal(editsTo(edits, replies[0]!.id).at(-1), "done");
});

test("a turn waiting on a confirmation tap isn't counted as silent", async () => {
  const { command, agent, say, replies, edits } = await harness(0, SILENCE);
  await say("write a note");
  await settle();

  // canUseTool parks here until the owner taps; the agent is idle on purpose.
  const decision = agent.options.canUseTool(WRITE, {
    path: "notes/a.md",
    content: "hi",
  });
  await settle();
  await silence();
  assert.ok(
    !editsTo(edits, replies[0]!.id).some((t) => t.includes("went quiet")),
    "a turn waiting on the owner was given up on",
  );

  // Once the tap arrives the clock runs again, so a query that then dies is still caught.
  command.denyPending();
  assert.equal((await decision).behavior, "deny");
  await silence();
  assert.match(editsTo(edits, replies[0]!.id).at(-1)!, /went quiet/);
});

test("the watchdog stops with the turn, and doesn't fire after an answer", async () => {
  const { agent, say, replies, edits } = await harness(0, SILENCE);
  await say("go");
  await settle();
  agent.emit(result("all done"));
  await settle();
  await silence();

  // The answer is the last word: no late "went quiet" written over it.
  assert.equal(editsTo(edits, replies[0]!.id).at(-1), "all done");
});

test("command mode refuses to open while task mode is open, and re-opens over itself", async () => {
  const { command, modes } = await harness();
  modes.close();
  modes.open("task");

  assert.equal(command.open(), "busy");
  assert.equal(command.isOpen(), false);
  assert.equal(modes.isOpen("task"), true);

  modes.close();
  assert.equal(command.open(), "opened");
  command.sessionId = "previous-session";
  assert.equal(command.open(), "opened");
  assert.equal(command.sessionId, undefined, "a second /command starts over");
});

test("command mode refuses to open without a mounted vault", async () => {
  const { command, opened } = await harness(0, 30_000, false);
  assert.equal(opened, "noVault");
  assert.equal(command.isOpen(), false);
});

test("a result that gave up with no text, and an empty success, say so", async () => {
  const { agent, say, replies, edits } = await harness();
  await say("first");
  await settle();
  await say("second");
  await settle();

  agent.emit(result(undefined, "error_max_turns"));
  await settle();
  agent.emit(result());
  await settle();

  assert.equal(
    editsTo(edits, replies[0]!.id).at(-1),
    "⚠️ the assistant gave up (error_max_turns)",
  );
  assert.equal(editsTo(edits, replies[1]!.id).at(-1), "(no reply)");
});

test("the agent only gets the vault tools and web search", async () => {
  const { agent, say } = await harness();
  await say("go");
  await settle();

  assert.deepEqual(agent.options.allowedTools, [
    "mcp__vault__vault_list",
    "mcp__vault__vault_read",
    "mcp__vault__vault_search",
    "mcp__vault__web_fetch",
    WRITE,
    DELETE,
    "WebSearch",
  ]);
  assert.deepEqual(agent.options.disallowedTools, [
    "Bash",
    "BashOutput",
    "KillShell",
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Glob",
    "Grep",
    "WebFetch",
    "Task",
    "Agent",
    "TodoWrite",
    "ExitPlanMode",
  ]);
});

test("read-only tools and web search run without asking, anything else is refused", async () => {
  const { agent, say, extra } = await harness();
  await say("go");
  await settle();
  const { canUseTool } = agent.options;

  for (const name of [
    "mcp__vault__vault_list",
    "mcp__vault__vault_read",
    "mcp__vault__vault_search",
    "mcp__vault__web_fetch",
    "WebSearch",
  ])
    assert.deepEqual(await canUseTool(name, { q: 1 }), {
      behavior: "allow",
      updatedInput: { q: 1 },
    });
  assert.deepEqual(await canUseTool("Bash", { command: "ls" }), {
    behavior: "deny",
    message: "Bash is not available. Only the vault tools and web search are.",
  });
  assert.deepEqual(extra(), [], "nothing was asked in the chat");
});

test("a write waits for the ✅ tap and then goes through", async () => {
  const { command, agent, say, extra } = await harness();
  const source = await say("write it");
  await settle();

  const input = { path: "notes/a.md", content: "hi" };
  const decision = agent.options.canUseTool(WRITE, input);
  await settle();

  const ask = extra().at(-1)!;
  assert.equal(
    ask.text,
    "✏️ Write <code>notes/a.md</code>?\n<blockquote>hi</blockquote>",
  );
  assert.equal(ask.opts.html, true);
  assert.equal(repliedTo(ask), source);
  const [yes, no] = confirmData(ask);
  assert.match(yes!, /^cm:y:/);
  assert.match(no!, /^cm:n:/);

  const decide = command.takeConfirmation(yes!.split(":")[2]);
  assert.ok(decide, "the tap found its question");
  decide(true);
  assert.deepEqual(await decision, { behavior: "allow", updatedInput: input });
});

test("a declined delete is refused, and a second tap on it has expired", async () => {
  const { command, agent, say, extra } = await harness();
  await say("delete it");
  await settle();

  const decision = agent.options.canUseTool(DELETE, { path: "notes/a.md" });
  await settle();

  const ask = extra().at(-1)!;
  assert.equal(ask.text, "🗑 Delete <code>notes/a.md</code>?");
  const [, no] = confirmData(ask);
  const id = no!.split(":")[2];
  command.takeConfirmation(id)!(false);
  assert.deepEqual(await decision, {
    behavior: "deny",
    message: "The owner declined that change.",
  });

  assert.equal(command.takeConfirmation(id), undefined);
  assert.equal(command.takeConfirmation(undefined), undefined);
});

test("a confirmation Telegram refuses to send is declined rather than left waiting", async () => {
  const { agent, say, failSends } = await harness();
  await say("write it");
  await settle();

  failSends.on = true;
  const decision = await agent.options.canUseTool(WRITE, {
    path: "a.md",
    content: "",
  });

  assert.equal(decision.behavior, "deny");
});

test("Stop and /done refuse the confirmations still waiting", async () => {
  const { command, modes, agent, say, replies } = await harness();
  await say("write it");
  await settle();

  const first = agent.options.canUseTool(WRITE, { path: "a.md", content: "" });
  await settle();
  await stop(command, turnId(replies[0]!));
  assert.equal((await first).behavior, "deny");

  const second = agent.options.canUseTool(DELETE, { path: "a.md" });
  await settle();
  modes.close();
  assert.equal((await second).behavior, "deny");
});
