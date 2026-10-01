import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentService, PromptStream } from "./agent.ts";

const HEADING = "# AI Writing Tropes to Avoid";

/** A stand-in for the SDK's `query` that keeps the options it was started with. */
function fixture(fetchPage: (url: string) => Promise<string>) {
  const started: any[] = [];
  const fetched: string[] = [];
  const vaultCalls: unknown[][] = [];
  const call =
    (name: string, out: string) =>
    async (...a: unknown[]) => {
      vaultCalls.push([name, ...a]);
      return out;
    };
  const vault = {
    enabled: true,
    listNotes: call("list", "L"),
    read: call("read", "R"),
    searchNotes: call("search", "S"),
    write: call("write", "W"),
    delete: call("delete", "D"),
  };
  const web = {
    fetchPage: async (url: string) => {
      fetched.push(url);
      return fetchPage(url);
    },
  };
  const service = new AgentService(
    vault as any,
    web as any,
    { model: "m", thinkingTokens: 0 },
    ((params: any) => {
      started.push(params);
      return {} as any;
    }) as any,
  );
  const start = (resume?: string) =>
    service.startQuery({
      prompt: new PromptStream(),
      resume,
      confirm: async () => true,
    });
  return { service, start, started, fetched, vaultCalls };
}

const systemOf = (call: any) => call.options.systemPrompt as string;

test("the system prompt carries the tropes list from its heading onward", async () => {
  const { start, started, fetched } = fixture(
    async () => `site chrome\n${HEADING}\n- delve`,
  );
  await start();

  assert.deepEqual(fetched, ["https://tropes.fyi/tropes-md"]);
  assert.match(
    systemOf(started[0]),
    new RegExp(`Do not produce any of them\\.\\n\\n${HEADING}\\n- delve$`),
  );
  assert.doesNotMatch(systemOf(started[0]), /site chrome/);
});

test("the tropes list is fetched once a day, not once per query", async () => {
  const { start, fetched } = fixture(async () => `${HEADING}\nx`);
  await start();
  await start();

  assert.equal(fetched.length, 1);
});

test("an unreachable tropes site degrades to the short list and is retried next time", async () => {
  const { start, started, fetched } = fixture(async () => {
    throw new Error("offline");
  });
  await start();
  await start();

  assert.match(systemOf(started[0]), /Avoid the usual machine tells: delve/);
  assert.equal(fetched.length, 2);
});

test("a query resumes the earlier conversation only when given its id", async () => {
  const { start, started } = fixture(async () => HEADING);
  await start();
  await start("s1");

  assert.equal("resume" in started[0].options, false);
  assert.equal(started[1].options.resume, "s1");
});

test("a zero thinking budget leaves extended thinking off", async () => {
  const { start, started } = fixture(async () => HEADING);
  await start();

  assert.equal("maxThinkingTokens" in started[0].options, false);
  assert.equal(started[0].options.model, "m");
  assert.equal(started[0].options.maxTurns, 120);
});

test("the vault tools reach the vault, and web_fetch reaches the web fetcher", async () => {
  const { service, vaultCalls, fetched } = fixture(async () => "page text");
  const tools = new Map(
    (service as any).tools().map((t: any) => [t.name, t.handler]),
  ) as Map<string, (args: any) => Promise<any>>;

  const text = async (name: string, args: object) =>
    (await tools.get(name)!(args)).content[0].text;
  assert.equal(await text("vault_list", {}), "L");
  assert.equal(await text("vault_list", { dir: "notes" }), "L");
  assert.equal(await text("vault_read", { path: "a.md" }), "R");
  assert.equal(await text("vault_search", { query: "q" }), "S");
  assert.equal(await text("vault_write", { path: "a", content: "c" }), "W");
  assert.equal(await text("vault_delete", { path: "a.md" }), "D");
  assert.equal(
    await text("web_fetch", { url: "https://x.test/" }),
    "page text",
  );

  assert.deepEqual(vaultCalls, [
    ["list", ""],
    ["list", "notes"],
    ["read", "a.md"],
    ["search", "q", ""],
    ["write", "a", "c"],
    ["delete", "a.md"],
  ]);
  assert.deepEqual(fetched, ["https://x.test/"]);
});

test("a failing tool goes back to the model as text instead of throwing", async () => {
  const { service } = fixture(async () => {
    throw new Error("blocked: private address");
  });
  const fetch = (service as any)
    .tools()
    .find((t: any) => t.name === "web_fetch");

  assert.deepEqual(await fetch.handler({ url: "http://localhost/" }), {
    content: [{ type: "text", text: "error: blocked: private address" }],
    isError: true,
  });
});

test("the prompt stream hands over queued prompts in order, waits for more, and ends on end()", async () => {
  const stream = new PromptStream();
  stream.push("one");
  stream.push("two");
  const seen: string[] = [];
  const done = (async () => {
    for await (const m of stream) seen.push((m as any).message.content[0].text);
  })();

  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, ["one", "two"]);

  stream.push("three");
  stream.end();
  await done;
  assert.deepEqual(seen, ["one", "two", "three"]);
});

test("a prompt goes to the CLI as a user message with one text block", async () => {
  const stream = new PromptStream();
  stream.push("hello");
  stream.end();
  const sent: unknown[] = [];
  for await (const m of stream) sent.push(m);

  assert.deepEqual(sent[0], {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });
});
