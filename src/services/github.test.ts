import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubReleases } from "./github.ts";

function fakeResponse(body: unknown, ok = true, status = ok ? 200 : 404) {
	return { ok, status, json: async () => body } as Response;
}

const RAW = {
	tag_name: "v1.2.3",
	name: "v1.2.3",
	body: "### Bug Fixes\n\n* fixed the thing",
	html_url: "https://github.com/khaosdoctor/scriba/releases/tag/v1.2.3",
	published_at: "2026-07-15T12:00:00Z",
};

test("latest fetches the latest-release endpoint and maps the payload", async (t) => {
	let calledUrl = "";
	t.mock.method(globalThis, "fetch", async (url: string) => {
		calledUrl = url;
		return fakeResponse(RAW);
	});
	const note = await new GithubReleases("owner/repo").latest();
	assert.match(calledUrl, /repos\/owner\/repo\/releases\/latest$/);
	assert.deepEqual(note, {
		tag: "v1.2.3",
		version: "1.2.3",
		name: "v1.2.3",
		body: "### Bug Fixes\n\n* fixed the thing",
		url: "https://github.com/khaosdoctor/scriba/releases/tag/v1.2.3",
		publishedAt: "2026-07-15T12:00:00Z",
	});
});

test("byVersion adds a leading v to the tag when missing", async (t) => {
	let calledUrl = "";
	t.mock.method(globalThis, "fetch", async (url: string) => {
		calledUrl = url;
		return fakeResponse(RAW);
	});
	await new GithubReleases("owner/repo").byVersion("1.2.3");
	assert.match(calledUrl, /releases\/tags\/v1\.2\.3$/);
	calledUrl = "";
	await new GithubReleases("owner/repo").byVersion("v1.2.3");
	assert.match(calledUrl, /releases\/tags\/v1\.2\.3$/);
});

test("byVersion returns null on a non-ok response instead of throwing", async (t) => {
	t.mock.method(globalThis, "fetch", async () => fakeResponse(null, false));
	const note = await new GithubReleases("owner/repo").byVersion("9.9.9");
	assert.equal(note, null);
});

test("recent returns the mapped list, and [] on a non-ok response", async (t) => {
	t.mock.method(globalThis, "fetch", async () =>
		fakeResponse([RAW, { ...RAW, tag_name: "v1.2.2" }]),
	);
	const notes = await new GithubReleases("owner/repo").recent(2);
	assert.equal(notes.length, 2);
	assert.equal(notes[1]!.tag, "v1.2.2");

	t.mock.method(globalThis, "fetch", async () => fakeResponse(null, false));
	assert.deepEqual(await new GithubReleases("owner/repo").recent(2), []);
});

test("falls back to the tag name when the release has no name", async (t) => {
	t.mock.method(globalThis, "fetch", async () =>
		fakeResponse({ ...RAW, name: null }),
	);
	const note = await new GithubReleases("owner/repo").latest();
	assert.equal(note!.name, "v1.2.3");
});
