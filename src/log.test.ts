import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Redaction happens in pino's core, at logger construction, so it can only be checked by
 * looking at what actually reaches the stream. The stream writes to fd 1 directly (sync
 * SonicBoom, not process.stdout.write), so a child process is the way to read it back.
 */
const LOG = fileURLToPath(new URL("./log.ts", import.meta.url));

function logLine(payload: string, level = "info"): Record<string, any> {
	const out = execFileSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`import { logger } from ${JSON.stringify(LOG)};
			 logger("test").${level}(${payload}, "a message");`,
		],
		{
			env: { ...process.env, LOG_JSON: "1", LOG_LEVEL: "debug" },
			encoding: "utf8",
		},
	);
	const line = out.trim().split("\n").filter(Boolean).at(-1);
	assert.ok(line, "the logger wrote nothing");
	return JSON.parse(line);
}

test("secrets are censored before they reach the stream", () => {
	// The shape config.ts logs at boot, secrets and all.
	const rec = logLine(`{
		telegram: { token: "SECRET-TOKEN", allowedUserId: 1 },
		obsidian: { key: "SECRET-KEY", url: "http://127.0.0.1:27124" },
		transcription: { groqApiKey: "SECRET-GROQ", mode: "local" },
		enrich: { groqApiKey: "SECRET-GROQ-2", model: "claude-haiku-4-5" },
	}`);

	assert.equal(rec.telegram.token, "***");
	assert.equal(rec.obsidian.key, "***");
	assert.equal(rec.transcription.groqApiKey, "***");
	assert.equal(rec.enrich.groqApiKey, "***");
	// The whole point is that config objects stay loggable: only the secret is taken out.
	assert.equal(rec.telegram.allowedUserId, 1);
	assert.equal(rec.obsidian.url, "http://127.0.0.1:27124");
	assert.equal(rec.transcription.mode, "local");
	assert.ok(!JSON.stringify(rec).includes("SECRET"));
});

test("a child logger is tagged with its scope, and the message survives", () => {
	const rec = logLine(`{ jotId: "abcd1234" }`);
	assert.equal(rec.ns, "test");
	assert.equal(rec.msg, "a message");
	assert.equal(rec.jotId, "abcd1234");
});

test("errors are expanded rather than logged as an empty object", () => {
	// `log.error({ err }, "…")` is the house style; pino's std serializer is what makes it
	// useful, so a stack has to come out the other side.
	const rec = logLine(`{ err: new Error("obsidian is down") }`, "error");
	assert.equal(rec.err.message, "obsidian is down");
	assert.equal(rec.err.type, "Error");
	assert.match(rec.err.stack, /log.test|Error: obsidian is down/);
});
