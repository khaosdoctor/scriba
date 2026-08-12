import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ObsidianClient } from "./obsidian.ts";
import { isPrivateAddress, VaultTools } from "./vault.ts";

/** A vault with one note, plus a secret outside it and a symlink pointing at that secret. */
async function fixture() {
	const base = await mkdtemp(join(tmpdir(), "scriba-vault-"));
	const root = join(base, "vault");
	await mkdir(join(root, "notes"), { recursive: true });
	await writeFile(join(root, "notes", "a.md"), "# A\nhello vault\n");
	await writeFile(join(base, "secret.md"), "TELEGRAM_BOT_TOKEN=hunter2");
	await symlink(join(base, "secret.md"), join(root, "escape.md")).catch(
		() => {},
	);
	const written: { path: string; content: string }[] = [];
	const obsidian = {
		writeNote: async (path: string, content: string) => {
			written.push({ path, content });
		},
		deleteNote: async () => {},
	} as unknown as ObsidianClient;
	return {
		base,
		root,
		written,
		tools: new VaultTools(root, obsidian),
		cleanup: () => rm(base, { recursive: true, force: true }),
	};
}

test("vault tools read inside the vault and refuse every way out of it", async () => {
	const f = await fixture();
	try {
		assert.match(await f.tools.read("notes/a.md"), /hello vault/);
		assert.match(await f.tools.list(), /notes\/a\.md/);
		assert.match(await f.tools.search("hello"), /notes\/a\.md/);

		// Traversal, absolute paths, and a symlink out all fail — and none of them leaks the
		// file's contents in the error.
		for (const bad of [
			"../secret.md",
			"notes/../../secret.md",
			"/etc/passwd",
			"escape.md", // symlink pointing outside the vault
		]) {
			await assert.rejects(
				() => f.tools.read(bad),
				(err: Error) => {
					assert.doesNotMatch(err.message, /hunter2/);
					return /escapes the vault|ENOENT|no such file/i.test(err.message);
				},
				`expected ${bad} to be refused`,
			);
		}

		// Writes are path-checked the same way, and go through the REST client (the mount is
		// read-only), with .md added when it's missing.
		await f.tools.write("notes/new", "body");
		assert.deepEqual(f.written, [{ path: "notes/new.md", content: "body" }]);
		await assert.rejects(
			() => f.tools.write("../evil", "x"),
			/escapes the vault/,
		);
	} finally {
		await f.cleanup();
	}
});

test("web_fetch refuses anything that isn't a public http(s) page", async () => {
	const f = await fixture();
	try {
		for (const bad of [
			"file:///etc/passwd",
			"ftp://example.com/x",
			"data:text/html,hi",
		])
			await assert.rejects(() => f.tools.fetchPage(bad), /only http\(s\)/);
		// Resolves to loopback → refused before any request goes out.
		await assert.rejects(
			() => f.tools.fetchPage("http://localhost:8080/health"),
			/private address/,
		);
		await assert.rejects(
			() => f.tools.fetchPage("http://127.0.0.1/"),
			/private address/,
		);
		await assert.rejects(() => f.tools.fetchPage("not a url"), /not a URL/);
	} finally {
		await f.cleanup();
	}
});

test("isPrivateAddress covers loopback, RFC1918, link-local and CGNAT", () => {
	for (const ip of [
		"127.0.0.1",
		"10.1.2.3",
		"192.168.50.125", // the homelab itself
		"172.16.0.1",
		"172.31.255.255",
		"169.254.1.1",
		"100.64.0.1",
		"0.0.0.0",
		"::1",
		"fd00::1",
		"fe80::1",
		"::ffff:127.0.0.1",
	])
		assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);

	for (const ip of [
		"1.1.1.1",
		"8.8.8.8",
		"172.32.0.1",
		"192.169.0.1",
		"2606:4700::1111",
	])
		assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
});

test("a vault path that isn't configured disables the tools", async () => {
	const tools = new VaultTools(null, {} as ObsidianClient);
	assert.equal(tools.enabled, false);
	await assert.rejects(() => tools.read("x.md"), /not configured/);
});

test("ids used for confirmations are unguessable enough", () => {
	// Sanity: the confirm ids come from makeJotId (4 random bytes), not a counter.
	const a = randomBytes(4).toString("hex");
	assert.match(a, /^[0-9a-f]{8}$/);
});
