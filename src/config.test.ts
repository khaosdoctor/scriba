import assert from "node:assert/strict";
import { test } from "node:test";

const BASE: Record<string, string> = {
	TELEGRAM_BOT_TOKEN: "t",
	ALLOWED_TELEGRAM_USER_ID: "1",
	OBSIDIAN_API_KEY: "o",
};

let counter = 0;
/** Load config.ts fresh with a given env (config reads process.env at import time). */
async function load(env: Record<string, string>) {
	const saved = { ...process.env };
	// wipe the vars we care about so leakage between cases can't hide a bug
	for (const k of ["GROQ_API_KEY", "PARAKEET_URL", "ENRICH_BACKUP_MODEL"])
		delete process.env[k];
	Object.assign(process.env, BASE, env);
	try {
		return await import(`./config.ts?v=${counter++}`);
	} finally {
		process.env = saved;
	}
}

test("groq key is optional and the sidecar url has a default", async () => {
	const { config } = await load({});
	assert.equal(config.transcription.groqApiKey, "");
	assert.match(config.transcription.parakeetUrl, /parakeet:5092/);
	assert.equal(config.enrich.backupModel, "claude-sonnet-5");
});

test("groq key and an explicit PARAKEET_URL are passed through", async () => {
	const { config } = await load({
		GROQ_API_KEY: "gk",
		PARAKEET_URL: "http://custom/asr",
	});
	assert.equal(config.transcription.groqApiKey, "gk");
	assert.equal(config.transcription.parakeetUrl, "http://custom/asr");
});

test("a blank PARAKEET_URL fails at boot", async () => {
	await assert.rejects(load({ PARAKEET_URL: "" }), /Invalid configuration/);
});

test("OBSIDIAN_INSECURE_TLS defaults off and parses to boolean", async () => {
	const { config } = await load({});
	assert.equal(config.obsidian.insecureTls, false);
	const on = await load({ OBSIDIAN_INSECURE_TLS: "true" });
	assert.equal(on.config.obsidian.insecureTls, true);
});
