import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryFn } from "../data/connections/anthropic.ts";
import type { GroqChatFn } from "../data/connections/groq.ts";
import { Enricher, ModelsDownError } from "./enrich.ts";

type Msg =
  | {
      type: "assistant";
      message: {
        content: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
    }
  | {
      type: "result";
      result?: unknown;
      subtype?: string;
      structured_output?: unknown;
      is_error?: boolean;
    };

/** Fake SDK query: yields the given messages, and records the last call's prompt + options. */
function fakeQuery(msgs: Msg[]) {
  const calls: { prompt: unknown; options: any }[] = [];
  const fn: QueryFn = ((args: any) => {
    calls.push({ prompt: args.prompt, options: args.options });
    return (async function* () {
      for (const m of msgs) yield m as any;
    })();
  }) as any;
  return { fn, calls };
}

const assistantText = (
  text: string,
  usage?: { input_tokens?: number; output_tokens?: number },
): Msg => ({
  type: "assistant",
  message: { content: [{ type: "text", text }], usage },
});

test("enrich returns parsed text, ambiguous, and usage from clean JSON", async () => {
  const body = JSON.stringify({
    text: "Ran with [[John]] today",
    ambiguous: [{ surface: "no", note: "Norway" }],
  });
  const { fn } = fakeQuery([
    assistantText(body, { input_tokens: 10, output_tokens: 3 }),
  ]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "Ran with John today",
    candidates: [{ surface: "John", note: "John" }],
  });
  assert.equal(out.text, "Ran with [[John]] today");
  assert.deepEqual(out.ambiguous, [{ surface: "no", note: "Norway" }]);
  assert.deepEqual(out.usage, { input: 10, output: 3 });
});

test("enrich defaults ambiguous to [] when the model omits it", async () => {
  const { fn } = fakeQuery([assistantText(JSON.stringify({ text: "hi" }))]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "hi",
    candidates: [],
  });
  assert.deepEqual(out.ambiguous, []);
});

test("enrich parses JSON wrapped in a ```json fence", async () => {
  const { fn } = fakeQuery([assistantText('```json\n{"text":"fenced"}\n```')]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "x",
    candidates: [],
  });
  assert.equal(out.text, "fenced");
});

test("enrich extracts JSON from surrounding prose via the outermost braces", async () => {
  const { fn } = fakeQuery([
    assistantText('Sure! Here it is: {"text":"embedded"} hope that helps'),
  ]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "x",
    candidates: [],
  });
  assert.equal(out.text, "embedded");
});

test("enrich throws when the response has no usable JSON", async () => {
  const { fn } = fakeQuery([assistantText("totally not json")]);
  await assert.rejects(
    new Enricher(undefined, fn).enrich({ text: "x", candidates: [] }),
    /no usable JSON/,
  );
});

test("enrich lists candidates in the prompt, or '(none)' when empty", async () => {
  const withCands = fakeQuery([assistantText('{"text":"ok"}')]);
  await new Enricher(undefined, withCands.fn).enrich({
    text: "hey",
    candidates: [{ surface: "John", note: "John Doe" }],
  });
  assert.match(
    withCands.calls[0]!.prompt as string,
    /- "John" -> \[\[John Doe\]\]/,
  );

  const noCands = fakeQuery([assistantText('{"text":"ok"}')]);
  await new Enricher(undefined, noCands.fn).enrich({
    text: "hey",
    candidates: [],
  });
  assert.match(
    noCands.calls[0]!.prompt as string,
    /Candidate links:\n\(none\)/,
  );
});

test("enrich marks forced (registered) candidates in the prompt", async () => {
  const { fn, calls } = fakeQuery([assistantText('{"text":"ok"}')]);
  await new Enricher(undefined, fn).enrich({
    text: "hey",
    candidates: [
      { surface: "gym", note: "Fitness", forced: true },
      { surface: "John", note: "John Doe" },
    ],
  });
  assert.match(
    calls[0]!.prompt as string,
    /- "gym" -> \[\[Fitness\]\] \(REGISTERED\)/,
  );
  assert.match(calls[0]!.prompt as string, /- "John" -> \[\[John Doe\]\]\n/);
});

test("enrich strips the triple-quote fence from user text so it can't break out", async () => {
  const { fn, calls } = fakeQuery([assistantText('{"text":"ok"}')]);
  await new Enricher(undefined, fn).enrich({
    text: 'say """hi""" now',
    candidates: [],
  });
  const prompt = calls[0]!.prompt as string;
  // the injected fence chars are gone; the one wrapping the text remains balanced
  assert.equal(prompt.match(/"""/g)?.length, 2);
  assert.match(prompt, /say hi now/);
});

test("run aggregates usage across multiple assistant messages", async () => {
  const { fn } = fakeQuery([
    assistantText('{"text":', { input_tokens: 5, output_tokens: 1 }),
    assistantText('"joined"}', { input_tokens: 2, output_tokens: 4 }),
  ]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "x",
    candidates: [],
  });
  assert.equal(out.text, "joined");
  assert.deepEqual(out.usage, { input: 7, output: 5 });
});

test("run falls back to the result string when no assistant text is emitted", async () => {
  const { fn } = fakeQuery([
    { type: "result", result: '{"text":"from-result"}' },
  ]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "x",
    candidates: [],
  });
  assert.equal(out.text, "from-result");
});

test("run ignores the result string when assistant text was already collected", async () => {
  const { fn } = fakeQuery([
    assistantText('{"text":"from-assistant"}'),
    { type: "result", result: '{"text":"IGNORED"}' },
  ]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "x",
    candidates: [],
  });
  assert.equal(out.text, "from-assistant");
});

test("run skips non-text content blocks", async () => {
  const { fn } = fakeQuery([
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking" },
          { type: "text", text: '{"text":"kept"}' },
        ],
      },
    },
  ]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "x",
    candidates: [],
  });
  assert.equal(out.text, "kept");
});

test("run tolerates an assistant message with no content array", async () => {
  const { fn } = fakeQuery([
    { type: "assistant", message: {} } as any,
    assistantText('{"text":"recovered"}'),
  ]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "x",
    candidates: [],
  });
  assert.equal(out.text, "recovered");
});

test("run tolerates an assistant message with no message payload at all", async () => {
  const { fn } = fakeQuery([
    { type: "assistant" } as any,
    assistantText('{"text":"still-ok"}'),
  ]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "x",
    candidates: [],
  });
  assert.equal(out.text, "still-ok");
});

test("run treats missing token fields in a usage object as zero", async () => {
  const { fn } = fakeQuery([assistantText('{"text":"ok"}', {})]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "x",
    candidates: [],
  });
  assert.deepEqual(out.usage, { input: 0, output: 0 });
});

test("run ignores a result message whose result is not a string", async () => {
  const { fn } = fakeQuery([
    { type: "result", result: 123 } as any,
    assistantText('{"text":"text-wins"}'),
  ]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "x",
    candidates: [],
  });
  assert.equal(out.text, "text-wins");
});

test("enrich throws when braces are present but the span is not valid JSON", async () => {
  const { fn } = fakeQuery([assistantText("here: {nope, not json} end")]);
  await assert.rejects(
    new Enricher(undefined, fn).enrich({ text: "x", candidates: [] }),
    /no usable JSON/,
  );
});

test("run passes the model to the SDK only when one is set", async () => {
  const withModel = fakeQuery([assistantText('{"text":"ok"}')]);
  await new Enricher("claude-x", withModel.fn).enrich({
    text: "x",
    candidates: [],
  });
  assert.equal(withModel.calls[0]!.options.model, "claude-x");
  // structured output: the tool call takes a turn, plus room for one re-ask
  assert.equal(withModel.calls[0]!.options.maxTurns, 3);

  const noModel = fakeQuery([assistantText('{"text":"ok"}')]);
  await new Enricher(undefined, noModel.fn).enrich({
    text: "x",
    candidates: [],
  });
  assert.equal("model" in noModel.calls[0]!.options, false);
});

test("the model is the caller's alone: AGENT_MODEL in the environment is never read here", async () => {
  const saved = process.env.AGENT_MODEL;
  process.env.AGENT_MODEL = "claude-from-env";
  try {
    const { fn, calls } = fakeQuery([assistantText('{"text":"ok"}')]);
    await new Enricher(undefined, fn).enrich({ text: "x", candidates: [] });
    assert.equal("model" in calls[0]!.options, false);
  } finally {
    delete process.env.AGENT_MODEL;
    if (saved !== undefined) process.env.AGENT_MODEL = saved;
  }
});

test("describeImage returns a trimmed caption", async () => {
  const { fn } = fakeQuery([assistantText("  a cat on a couch  ")]);
  const out = await new Enricher(undefined, fn).describeImage(
    new Uint8Array([1, 2]),
    "image/png",
  );
  assert.equal(out, "a cat on a couch");
});

test("editText returns the trimmed edit", async () => {
  const { fn } = fakeQuery([assistantText("  fixed line  ")]);
  const out = await new Enricher(undefined, fn).editText("old line", "fix it");
  assert.equal(out, "fixed line");
});

test("editText keeps the current text when the edit comes back empty", async () => {
  const { fn } = fakeQuery([assistantText("   ")]);
  const out = await new Enricher(undefined, fn).editText(
    "keep me",
    "do nothing",
  );
  assert.equal(out, "keep me");
});

/** A query fn that throws while streaming — simulates the subscription SDK out of usage. */
function failQuery(message = "usage limit reached"): QueryFn {
  return (() => {
    async function* gen() {
      if (message) throw new Error(message);
      yield undefined as never;
    }
    return gen();
  }) as unknown as QueryFn;
}

function fakeGroq(text: string) {
  const calls: { apiKey: string; model: string; messages: unknown[] }[] = [];
  const fn: GroqChatFn = async (apiKey, model, messages) => {
    calls.push({ apiKey, model, messages });
    return { text, usage: { input: 1, output: 2 } };
  };
  return { fn, calls };
}

test("enrich falls back to Groq when the subscription SDK is out of usage", async () => {
  const groq = fakeGroq('{"text":"linked via [[Foo]]","ambiguous":[]}');
  const enricher = new Enricher(
    "claude-haiku-4-5",
    failQuery(),
    [{ apiKey: "gsk_test", model: "llama-3.3-70b-versatile" }],
    groq.fn,
  );
  const res = await enricher.enrich({ text: "hi Foo", candidates: [] });
  assert.equal(res.text, "linked via [[Foo]]");
  assert.equal(res.usage.output, 2);
  assert.equal(groq.calls.length, 1);
  assert.equal(groq.calls[0]!.model, "llama-3.3-70b-versatile");
  assert.equal(groq.calls[0]!.apiKey, "gsk_test");
});

test("enrich rethrows when the SDK fails and no Groq fallback is configured", async () => {
  const enricher = new Enricher("claude-haiku-4-5", failQuery("boom"));
  await assert.rejects(
    () => enricher.enrich({ text: "hi", candidates: [] }),
    /boom/,
  );
});

test("editText falls back to Groq when the SDK is out of usage", async () => {
  const groq = fakeGroq("edited on the free model");
  const enricher = new Enricher(
    "claude-haiku-4-5",
    failQuery(),
    [{ apiKey: "gsk_test", model: "openai/gpt-oss-120b" }],
    groq.fn,
  );
  const out = await enricher.editText("original", "make it better");
  assert.equal(out, "edited on the free model");
  assert.equal(groq.calls.length, 1);
});

/** A query fn that throws its first `failFirst` calls, then streams `text`. */
function flakyQuery(failFirst: number, text: string): QueryFn {
  let n = 0;
  return (() => {
    const fail = n < failFirst;
    n++;
    async function* gen() {
      if (fail) throw new Error("usage out");
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text }] },
      };
    }
    return gen();
  }) as unknown as QueryFn;
}

test("warns once when switching to the fallback and once when usage recovers", async () => {
  const groq = fakeGroq('{"text":"free","ambiguous":[]}');
  const switches: { to: string; model: string; err?: unknown }[] = [];
  const enricher = new Enricher(
    "claude-haiku-4-5",
    flakyQuery(2, '{"text":"ok","ambiguous":[]}'),
    [{ apiKey: "k", model: "openai/gpt-oss-120b" }],
    groq.fn,
    undefined,
    undefined,
    undefined,
    (to, model, err) => {
      switches.push({ to, model, err });
    },
  );
  await enricher.enrich({ text: "a", candidates: [] }); // fail → switch to fallback
  await enricher.enrich({ text: "b", candidates: [] }); // fail → already on fallback, no switch
  await enricher.enrich({ text: "c", candidates: [] }); // SDK ok → switch back to primary
  assert.deepEqual(
    switches.map((s) => s.to),
    ["fallback", "primary"],
  );
  assert.equal(switches[0]!.model, "openai/gpt-oss-120b");
  assert.equal(switches[1]!.model, "claude-haiku-4-5");
  assert.equal((switches[0]!.err as Error).message, "usage out"); // failure reason surfaced
  assert.equal(switches[1]!.err, undefined); // recovery carries no error
  assert.equal(groq.calls.length, 2); // fallback used for the two failing calls only
});

/** A query fn that fails for every model in `downModels` and answers `text` otherwise,
 *  recording which model each call asked for. */
function modelQuery(downModels: Set<string>, text: string) {
  const models: string[] = [];
  const fn = ((req: any) => {
    const model = req.options.model;
    models.push(model);
    async function* gen() {
      if (downModels.has(model)) throw new Error(`${model} down`);
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text }] },
      };
    }
    return gen();
  }) as unknown as QueryFn;
  return { fn, models };
}

test("chain runs haiku → sonnet → groq, each only when the one before fails", async () => {
  const down = new Set(["claude-haiku-4-5"]);
  const q = modelQuery(down, '{"text":"from claude","ambiguous":[]}');
  const groq = fakeGroq('{"text":"from groq","ambiguous":[]}');
  const switches: string[] = [];
  const enricher = new Enricher(
    "claude-haiku-4-5",
    q.fn,
    [{ apiKey: "k", model: "openai/gpt-oss-120b" }],
    groq.fn,
    "claude-sonnet-5",
    undefined,
    undefined,
    (to, model) => {
      switches.push(`${to}:${model}`);
    },
  );

  // haiku down → sonnet answers
  const a = await enricher.enrich({ text: "a", candidates: [] });
  assert.equal(a.text, "from claude");
  assert.deepEqual(q.models, ["claude-haiku-4-5", "claude-sonnet-5"]);

  // both Claude models down → groq answers
  down.add("claude-sonnet-5");
  const b = await enricher.enrich({ text: "b", candidates: [] });
  assert.equal(b.text, "from groq");
  assert.equal(groq.calls.length, 1);

  // everything back → haiku answers, no backup call
  down.clear();
  q.models.length = 0;
  await enricher.enrich({ text: "c", candidates: [] });
  assert.deepEqual(q.models, ["claude-haiku-4-5"]);

  assert.deepEqual(switches, [
    "fallback:claude-sonnet-5",
    "fallback:openai/gpt-oss-120b",
    "primary:claude-haiku-4-5",
  ]);
});

test("backup model equal to the chosen one is not tried twice", async () => {
  const q = modelQuery(new Set(["claude-sonnet-5"]), "x");
  const enricher = new Enricher(
    "claude-sonnet-5",
    q.fn,
    undefined,
    undefined,
    "claude-sonnet-5",
  );
  await assert.rejects(() => enricher.editText("old", "fix"), /sonnet-5 down/);
  assert.deepEqual(q.models, ["claude-sonnet-5"]);
});

test("an unusable answer moves down the chain like a failed call", async () => {
  const models: string[] = [];
  const fn = ((req: any) => {
    const model = req.options.model;
    models.push(model);
    const text =
      model === "claude-haiku-4-5"
        ? "sorry, no JSON here"
        : '{"text":"from sonnet","ambiguous":[]}';
    async function* gen() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text }] },
      };
    }
    return gen();
  }) as unknown as QueryFn;
  const enricher = new Enricher(
    "claude-haiku-4-5",
    fn,
    undefined,
    undefined,
    "claude-sonnet-5",
  );
  const res = await enricher.enrich({ text: "a", candidates: [] });
  assert.equal(res.text, "from sonnet");
  assert.deepEqual(models, ["claude-haiku-4-5", "claude-sonnet-5"]);
});

test("enrich requests structured output and uses it directly, skipping text parsing", async () => {
  const { fn, calls } = fakeQuery([
    {
      type: "result",
      subtype: "success",
      result: "ignored — structured_output wins",
      structured_output: {
        text: "Ran with [[John]] today",
        ambiguous: [{ surface: "no", note: "Norway" }],
      },
    },
  ]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "Ran with John today",
    candidates: [{ surface: "John", note: "John" }],
  });
  assert.equal(out.text, "Ran with [[John]] today");
  assert.deepEqual(out.ambiguous, [{ surface: "no", note: "Norway" }]);
  assert.equal(calls[0]!.options.outputFormat.type, "json_schema");
  assert.deepEqual(calls[0]!.options.outputFormat.schema.required, [
    "text",
    "ambiguous",
    "tasks",
    "til",
  ]);
  // The schema asks for tasks every time, but a payload without them still parses — the
  // Groq fallback has no structured output to enforce the shape.
  assert.deepEqual(out.tasks, []);
});

test("enrich reports the tasks the entry says are still to do", async () => {
  const { fn } = fakeQuery([
    {
      type: "result",
      subtype: "success",
      structured_output: {
        text: "Long day. I need to call the vet tomorrow.",
        ambiguous: [],
        tasks: [
          { description: "Call the vet", due: "tomorrow", type: "personal" },
          { description: "Answer the RFC", type: "work" },
        ],
      },
    },
  ]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "Long day. I need to call the vet tomorrow.",
    candidates: [],
  });
  assert.deepEqual(out.tasks, [
    { description: "Call the vet", due: "tomorrow", type: "personal" },
    { description: "Answer the RFC", type: "work" },
  ]);
});

test("a response with no tasks field is a response with no tasks", async () => {
  const { fn } = fakeQuery([
    assistantText('{"text":"plain day","ambiguous":[]}'),
  ]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "plain day",
    candidates: [],
  });
  assert.deepEqual(out.tasks, []);
  assert.equal(out.text, "plain day");
});

test("extractTask reads a line into a task, timing left as the author's words", async () => {
  const { fn, calls } = fakeQuery([
    {
      type: "result",
      subtype: "success",
      structured_output: {
        description: "Answer Pavlo about the Hive review",
        due: "next friday",
        type: "work",
      },
    },
  ]);
  const out = await new Enricher(undefined, fn).extractTask(
    "gotta answer pavlo re hive by next friday",
  );
  assert.deepEqual(out, {
    description: "Answer Pavlo about the Hive review",
    due: "next friday",
    type: "work",
  });
  // The dates come back as phrases: chrono resolves them, so the model is never asked
  // what today is.
  assert.equal(calls[0]!.options.outputFormat.type, "json_schema");
  assert.match(calls[0]!.options.systemPrompt, /do NOT calculate anything/);
});

test("extractTask fails loudly when nothing usable comes back", async () => {
  const { fn } = fakeQuery([assistantText("sorry, I can't do that")]);
  await assert.rejects(
    () => new Enricher(undefined, fn).extractTask("buy milk"),
    /no usable JSON/,
  );
});

test("editText and describeImage don't request structured output", async () => {
  const { fn: editFn, calls: editCalls } = fakeQuery([assistantText("edited")]);
  await new Enricher(undefined, editFn).editText("old", "fix it");
  assert.equal("outputFormat" in editCalls[0]!.options, false);

  const { fn: visionFn, calls: visionCalls } = fakeQuery([
    assistantText("a cat"),
  ]);
  await new Enricher(undefined, visionFn).describeImage(
    new Uint8Array([1]),
    "image/png",
  );
  assert.equal("outputFormat" in visionCalls[0]!.options, false);
});

test("enrich falls back to text parsing when structured_output fails schema validation", async () => {
  const { fn } = fakeQuery([
    {
      type: "result",
      subtype: "success",
      result: '{"text":"from-text-fallback","ambiguous":[]}',
      structured_output: { text: 42 }, // wrong type, and missing "ambiguous"
    },
  ]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "x",
    candidates: [],
  });
  assert.equal(out.text, "from-text-fallback");
});

test("enrich throws when the SDK gives up on structured output (error subtype)", async () => {
  const { fn } = fakeQuery([
    { type: "result", subtype: "error_max_structured_output_retries" },
  ]);
  await assert.rejects(
    new Enricher(undefined, fn).enrich({ text: "x", candidates: [] }),
    /agent gave up producing a usable result/,
  );
});

test("chain tries the second chat fallback when the first one fails", async () => {
  const calls: { model: string; baseUrl?: string }[] = [];
  const chatFn: GroqChatFn = async (_key, model, _msgs, baseUrl) => {
    calls.push({ model, baseUrl });
    if (model === "groq-model") throw new Error("groq down");
    return {
      text: '{"text":"from opencode","ambiguous":[]}',
      usage: { input: 3, output: 4 },
    };
  };
  const switches: string[] = [];
  const enricher = new Enricher(
    "claude-haiku-4-5",
    failQuery(),
    [
      { apiKey: "gsk", model: "groq-model", name: "Groq" },
      {
        apiKey: "oc",
        model: "deepseek-v4.1-flash",
        baseUrl: "https://opencode.ai/zen/go/v1",
        name: "OpenCode",
      },
    ],
    chatFn,
    undefined,
    undefined,
    undefined,
    (to, model) => {
      switches.push(`${to}:${model}`);
    },
  );
  const out = await enricher.enrich({ text: "a", candidates: [] });
  assert.equal(out.text, "from opencode");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.model, "groq-model");
  assert.equal(calls[0]!.baseUrl, undefined);
  assert.equal(calls[1]!.model, "deepseek-v4.1-flash");
  assert.equal(calls[1]!.baseUrl, "https://opencode.ai/zen/go/v1");
  assert.deepEqual(switches, ["fallback:OpenCode"]);
});

test("enrich falls back to Groq text-parsing when structured output is exhausted", async () => {
  const groq = fakeGroq('{"text":"rescued by groq","ambiguous":[]}');
  const enricher = new Enricher(
    "claude-haiku-4-5",
    fakeQuery([
      { type: "result", subtype: "error_max_structured_output_retries" },
    ]).fn,
    [{ apiKey: "gsk_test", model: "llama-3.3-70b-versatile" }],
    groq.fn,
  );
  const out = await enricher.enrich({ text: "x", candidates: [] });
  assert.equal(out.text, "rescued by groq");
  assert.equal(groq.calls.length, 1);
});

test("a fallback answer nested inside its own text field is unwrapped, not journaled as JSON", async () => {
  const inner = JSON.stringify({
    text: "I enrolled in an electronics course in Portuguese",
    ambiguous: [{ surface: "Portuguese", note: "Portugal" }],
    tasks: [{ description: "Do one class a day", type: "personal" }],
  });
  const groq = fakeGroq(
    JSON.stringify({ text: inner, ambiguous: [], tasks: [] }),
  );
  const res = await new Enricher(
    "claude-haiku-4-5",
    failQuery(),
    [{ apiKey: "k", model: "m" }],
    groq.fn,
  ).enrich({ text: "x", candidates: [] });
  assert.equal(res.text, "I enrolled in an electronics course in Portuguese");
  assert.deepEqual(res.ambiguous, [
    { surface: "Portuguese", note: "Portugal" },
  ]);
  assert.equal(res.tasks.length, 1);
});

const structuredTil = async (structured_output: object) => {
  const { fn, calls } = fakeQuery([
    {
      type: "result",
      subtype: "success",
      result: "ignored, structured_output wins",
      structured_output,
    },
  ]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "x",
    candidates: [],
  });
  return { out, calls };
};

test("structured output carries til straight through and leaves the text alone", async () => {
  const { out } = await structuredTil({
    text: "TIL sqlite has WAL",
    ambiguous: [],
    tasks: [],
    til: true,
  });
  assert.equal(out.til, true);
  assert.equal(out.text, "TIL sqlite has WAL");
});

test("structured output without til, or with til false, is a valid answer that is not a TIL", async () => {
  for (const answer of [
    { text: "a", ambiguous: [] },
    { text: "a", ambiguous: [], til: false },
  ]) {
    const { out } = await structuredTil(answer);
    assert.equal(out.til, false);
    assert.equal(out.text, "a");
  }
});

test("a fenced fallback answer still yields til", async () => {
  const res = await new Enricher(
    "claude-haiku-4-5",
    failQuery(),
    [{ apiKey: "k", model: "m" }],
    fakeGroq('```json\n{"text":"a","ambiguous":[],"tasks":[],"til":true}\n```')
      .fn,
  ).enrich({ text: "x", candidates: [] });
  assert.equal(res.til, true);
});

test("only a literal true counts as til on the fallback path", async () => {
  for (const til of [null, 0, 1, "true", "TRUE", [], {}, "false", false]) {
    const res = await new Enricher(
      "claude-haiku-4-5",
      failQuery(),
      [{ apiKey: "k", model: "m" }],
      fakeGroq(JSON.stringify({ text: "a", ambiguous: [], til })).fn,
    ).enrich({ text: "x", candidates: [] });
    assert.equal(res.til, false, JSON.stringify(til));
  }
});

test("the til field is read when it is true and defaults to false when absent or malformed", async () => {
  const ask = async (answer: object) =>
    (
      await new Enricher(
        "claude-haiku-4-5",
        failQuery(),
        [{ apiKey: "k", model: "m" }],
        fakeGroq(JSON.stringify(answer)).fn,
      ).enrich({ text: "x", candidates: [] })
    ).til;
  assert.equal(await ask({ text: "a", ambiguous: [], til: true }), true);
  assert.equal(await ask({ text: "a", ambiguous: [] }), false);
  assert.equal(await ask({ text: "a", ambiguous: [], til: "yes" }), false);
});

test("a fallback answer with raw line breaks inside the text still parses", async () => {
  const groq = fakeGroq(
    '{"text": "I made a list.\n\nI still want to write again.", "ambiguous": [], "tasks": []}',
  );
  const res = await new Enricher(
    "claude-haiku-4-5",
    failQuery(),
    [{ apiKey: "k", model: "m" }],
    groq.fn,
  ).enrich({ text: "x", candidates: [] });
  assert.equal(res.text, "I made a list.\n\nI still want to write again.");
});

test("the prompt's triple-quote fence echoed around the text is stripped", async () => {
  const groq = fakeGroq(
    JSON.stringify({ text: '"""Like I have to go out,"""', ambiguous: [] }),
  );
  const res = await new Enricher(
    "claude-haiku-4-5",
    failQuery(),
    [{ apiKey: "k", model: "m" }],
    groq.fn,
  ).enrich({ text: "x", candidates: [] });
  assert.equal(res.text, "Like I have to go out,");
});

test("structured output whose text holds the whole JSON answer is unwrapped", async () => {
  const { fn } = fakeQuery([
    {
      type: "result",
      subtype: "success",
      structured_output: {
        text: '{"text": "At least I finished my website", "ambiguous": [], "tasks": []}',
        ambiguous: [],
        tasks: [],
      },
    },
  ]);
  const out = await new Enricher(undefined, fn).enrich({
    text: "x",
    candidates: [],
  });
  assert.equal(out.text, "At least I finished my website");
});

/** A query whose stream never yields: a CLI subprocess that went quiet. */
const hangingQuery = (() =>
  (async function* () {
    await new Promise(() => {});
  })()) as unknown as QueryFn;

test("a Claude call that hangs times out and the chain moves on", async () => {
  const groq = fakeGroq('{"text":"rescued","ambiguous":[]}');
  const out = await new Enricher(
    "claude-haiku-4-5",
    hangingQuery,
    [{ apiKey: "k", model: "m" }],
    groq.fn,
    undefined,
    20,
  ).enrich({ text: "x", candidates: [] });
  assert.equal(out.text, "rescued");
});

test("the SDK gets an abort controller and the chat fallbacks get the timeout", async () => {
  const { fn, calls } = fakeQuery([assistantText('{"text":"ok"}')]);
  await new Enricher("m", fn).enrich({ text: "x", candidates: [] });
  assert.ok(calls[0]!.options.abortController instanceof AbortController);
  // no extended thinking: it was most of haiku's time on every jot
  assert.deepEqual(calls[0]!.options.thinking, { type: "disabled" });

  const seen: (number | undefined)[] = [];
  const groqFn: GroqChatFn = async (_k, _m, _msgs, _url, timeoutMs) => {
    seen.push(timeoutMs);
    return { text: '{"text":"ok"}', usage: { input: 0, output: 0 } };
  };
  await new Enricher(
    "m",
    failQuery(),
    [{ apiKey: "k", model: "g" }],
    groqFn,
    undefined,
    1234,
  ).enrich({ text: "x", candidates: [] });
  assert.deepEqual(seen, [1234]);
});

test("a step that keeps failing is skipped once its circuit opens", async () => {
  const claudeCalls: string[] = [];
  const query = ((args: any) => {
    claudeCalls.push(args.options.model);
    return failQuery("overloaded 529")(args);
  }) as unknown as QueryFn;
  const groq = fakeGroq('{"text":"ok","ambiguous":[]}');
  const enricher = new Enricher(
    "claude-haiku-4-5",
    query,
    [{ apiKey: "k", model: "g", name: "Groq" }],
    groq.fn,
  );
  for (let i = 0; i < 5; i++)
    await enricher.enrich({ text: "x", candidates: [] });
  // three failures open haiku's circuit; jots four and five go straight to Groq
  assert.equal(claudeCalls.length, 3);
  assert.equal(groq.calls.length, 5);
});

test("every step down: the chain throws ModelsDownError once and says so once", async () => {
  const t = { now: 0 };
  const notices: string[] = [];
  const failGroq: GroqChatFn = async () => {
    throw new Error("Connection error.");
  };
  const enricher = new Enricher(
    "claude-haiku-4-5",
    failQuery("overloaded 529"),
    [{ apiKey: "k", model: "g", name: "Groq" }],
    failGroq,
    undefined,
    15_000,
    () => t.now,
    (to) => {
      notices.push(to);
    },
  );
  for (let i = 0; i < 2; i++)
    await assert.rejects(enricher.enrich({ text: "x", candidates: [] }));
  assert.equal(enricher.available(), true);
  await assert.rejects(
    enricher.enrich({ text: "x", candidates: [] }),
    ModelsDownError,
  );
  assert.equal(enricher.available(), false);
  // open circuits: nothing is called, and the down notice isn't repeated
  await assert.rejects(
    enricher.enrich({ text: "x", candidates: [] }),
    ModelsDownError,
  );
  assert.deepEqual(notices, ["down"]);
  // the cooldown runs out: a trial call goes through again
  t.now = 120_000;
  assert.equal(enricher.available(), true);
});

test("the switch notice carries the error that moved it down the chain", async () => {
  const errs: unknown[] = [];
  const { fn } = fakeQuery([assistantText('{"text":"ok"}')]);
  const query = ((args: any) =>
    args.options.model === "claude-haiku-4-5"
      ? failQuery("usage limit reached")(args)
      : fn(args)) as unknown as QueryFn;
  const enricher = new Enricher(
    "claude-haiku-4-5",
    query,
    [],
    undefined,
    "claude-sonnet-5",
    undefined,
    undefined,
    (_to, _model, err) => {
      errs.push(err);
    },
  );
  await enricher.enrich({ text: "x", candidates: [] });
  assert.equal((errs[0] as Error).message, "usage limit reached");
});

test("a failure no cooldown can fix never opens a circuit, so jots aren't held on it", async () => {
  const enricher = new Enricher(
    "claude-haiku-4-5",
    failQuery("invalid x-api-key (401)"),
  );
  for (let i = 0; i < 5; i++)
    await assert.rejects(enricher.enrich({ text: "x", candidates: [] }), {
      message: "invalid x-api-key (401)",
    });
  assert.equal(enricher.available(), true);
});

test("an unusable answer never trips the breaker, even when it reads like an outage", async () => {
  // the rejection quotes the answer, and "500" in it would match isRecoverable's 5xx
  const groq = fakeGroq("I walked 500 metres on a network of trails today");
  const enricher = new Enricher(
    "claude-haiku-4-5",
    failQuery("invalid x-api-key (401)"),
    [{ apiKey: "k", model: "g", name: "Groq" }],
    groq.fn,
  );
  for (let i = 0; i < 4; i++)
    await assert.rejects(enricher.enrich({ text: "x", candidates: [] }));
  assert.equal(groq.calls.length, 4);
  assert.equal(enricher.available(), true);
});

test("a fallback's malformed lists are dropped instead of trusted", async () => {
  const groq = fakeGroq('{"text":"x","ambiguous":"none","tasks":{}}');
  const out = await new Enricher(
    "claude-haiku-4-5",
    failQuery(),
    [{ apiKey: "k", model: "m" }],
    groq.fn,
  ).enrich({ text: "x", candidates: [] });
  assert.equal(out.text, "x");
  assert.deepEqual(out.ambiguous, []);
  assert.deepEqual(out.tasks, []);
});

test("an API error reported as a success result moves down the chain", async () => {
  const { fn } = fakeQuery([
    {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "API Error: 529 overloaded",
    } as Msg,
  ]);
  const groq = fakeGroq('{"text":"rescued","ambiguous":[]}');
  const out = await new Enricher(
    "claude-haiku-4-5",
    fn,
    [{ apiKey: "k", model: "m" }],
    groq.fn,
  ).enrich({ text: "x", candidates: [] });
  assert.equal(out.text, "rescued");
});

const taskProperties = {
  description: { type: "string" },
  start: { type: "string" },
  due: { type: "string" },
  type: { type: "string", enum: ["work", "personal"] },
};

test("the SDK receives these exact output schemas for enrichment and task extraction", async () => {
  const enrich = fakeQuery([
    {
      type: "result",
      subtype: "success",
      structured_output: { text: "a", ambiguous: [], tasks: [], til: false },
    },
  ]);
  await new Enricher(undefined, enrich.fn).enrich({
    text: "a",
    candidates: [],
  });
  assert.deepEqual(enrich.calls[0]!.options.outputFormat, {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        ambiguous: {
          type: "array",
          items: {
            type: "object",
            properties: {
              surface: { type: "string" },
              note: { type: "string" },
            },
            required: ["surface", "note"],
            additionalProperties: false,
          },
        },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: taskProperties,
            required: ["description"],
            additionalProperties: false,
          },
        },
        til: { type: "boolean" },
      },
      required: ["text", "ambiguous", "tasks", "til"],
      additionalProperties: false,
    },
  });

  const task = fakeQuery([
    {
      type: "result",
      subtype: "success",
      structured_output: { description: "d", type: "personal" },
    },
  ]);
  await new Enricher(undefined, task.fn).extractTask("d");
  assert.deepEqual(task.calls[0]!.options.outputFormat, {
    type: "json_schema",
    schema: {
      type: "object",
      properties: taskProperties,
      required: ["description", "type"],
      additionalProperties: false,
    },
  });
});
