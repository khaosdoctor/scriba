import assert from "node:assert/strict";
import { test } from "node:test";
import { Enricher, type QueryFn } from "./enrich.ts";

type Msg =
	| {
			type: "assistant";
			message: {
				content: Array<{ type: string; text?: string }>;
				usage?: { input_tokens?: number; output_tokens?: number };
			};
	  }
	| { type: "result"; result?: string };

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
	assert.equal(withModel.calls[0]!.options.maxTurns, 1);

	const noModel = fakeQuery([assistantText('{"text":"ok"}')]);
	await new Enricher(undefined, noModel.fn).enrich({
		text: "x",
		candidates: [],
	});
	assert.equal("model" in noModel.calls[0]!.options, false);
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
