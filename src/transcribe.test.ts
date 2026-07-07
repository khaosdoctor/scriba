import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createTranscriber,
	GroqTranscriber,
	ParakeetTranscriber,
	TranscriberSwitch,
} from "./transcribe.ts";

test("factory picks the backend from mode", () => {
	assert.ok(
		createTranscriber({
			mode: "local",
			groqApiKey: "",
			parakeetUrl: "http://p",
		}) instanceof ParakeetTranscriber,
	);
	assert.ok(
		createTranscriber({
			mode: "remote",
			groqApiKey: "k",
			parakeetUrl: "",
		}) instanceof GroqTranscriber,
	);
});

test("switch swaps mode when the target's creds exist", () => {
	const sw = new TranscriberSwitch({
		mode: "local",
		groqApiKey: "k",
		parakeetUrl: "http://p",
	});
	assert.equal(sw.mode, "local");
	sw.setMode("remote");
	assert.equal(sw.mode, "remote");
	sw.setMode("local");
	assert.equal(sw.mode, "local");
});

test("switch refuses to move to a backend with no creds and keeps the old mode", () => {
	const sw = new TranscriberSwitch({
		mode: "local",
		groqApiKey: "",
		parakeetUrl: "http://p",
	});
	assert.throws(() => sw.setMode("remote"), /GROQ_API_KEY/);
	assert.equal(sw.mode, "local"); // unchanged after the failed switch
});

function fakeResponse(body: string, json: boolean, ok = true) {
	return {
		ok,
		status: ok ? 200 : 500,
		headers: { get: () => (json ? "application/json" : "text/plain") },
		json: async () => JSON.parse(body),
		text: async () => body,
	};
}

test("parakeet parses json {text} responses", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async () => fakeResponse(JSON.stringify({ text: " hi " }), true) as any,
	);
	const out = await new ParakeetTranscriber("http://p").transcribe(
		new Uint8Array([1]),
		"ogg",
	);
	assert.equal(out, "hi");
});

test("parakeet parses plain-text responses", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async () => fakeResponse("yo\n", false) as any,
	);
	const out = await new ParakeetTranscriber("http://p").transcribe(
		new Uint8Array([1]),
		"ogg",
	);
	assert.equal(out, "yo");
});

test("parakeet throws on non-ok status", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async () => fakeResponse("boom", false, false) as any,
	);
	await assert.rejects(
		new ParakeetTranscriber("http://p").transcribe(new Uint8Array([1]), "ogg"),
		/parakeet 500/,
	);
});
