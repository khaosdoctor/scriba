import { logger } from "../log.ts";

const log = logger("github");

export interface ReleaseNote {
	tag: string; // e.g. "v1.23.1"
	version: string; // tag with the leading "v" stripped
	name: string;
	body: string; // release notes markdown (the changelog section for this version)
	url: string; // GitHub Release page
	publishedAt: string; // ISO timestamp
}

/** Shape of the GitHub API response we read from. */
interface RawRelease {
	tag_name: string;
	name: string | null;
	body: string | null;
	html_url: string;
	published_at: string;
}

/** Thin client over the public GitHub Releases API for this repo. Release notes are
 *  authored by the release workflow (conventional-changelog-action, from conventional
 *  commits), so pulling them live keeps the deploy notice and /changelog in sync with
 *  what's actually on GitHub instead of duplicating that content into the image. No
 *  auth: public repo, low volume (once per deploy, plus on-demand /changelog calls). */
export class GithubReleases {
	constructor(private repo = "khaosdoctor/scriba") {}

	private headers(): Record<string, string> {
		return { Accept: "application/vnd.github+json", "User-Agent": "scriba" };
	}

	private toNote(r: RawRelease): ReleaseNote {
		return {
			tag: r.tag_name,
			version: r.tag_name.replace(/^v/, ""),
			name: r.name || r.tag_name,
			body: r.body ?? "",
			url: r.html_url,
			publishedAt: r.published_at,
		};
	}

	private async fetchOne(url: string): Promise<ReleaseNote | null> {
		log.debug({ url }, "github: fetching release");
		const res = await fetch(url, { headers: this.headers() });
		if (!res.ok) {
			log.warn({ url, status: res.status }, "github: fetching release failed");
			return null;
		}
		return this.toNote((await res.json()) as RawRelease);
	}

	/** The most recent published release. */
	latest(): Promise<ReleaseNote | null> {
		return this.fetchOne(
			`https://api.github.com/repos/${this.repo}/releases/latest`,
		);
	}

	/** A specific release by version, with or without a leading "v". */
	byVersion(version: string): Promise<ReleaseNote | null> {
		const tag = version.startsWith("v") ? version : `v${version}`;
		return this.fetchOne(
			`https://api.github.com/repos/${this.repo}/releases/tags/${tag}`,
		);
	}

	/** The N most recent releases, newest first. */
	async recent(count: number): Promise<ReleaseNote[]> {
		const url = `https://api.github.com/repos/${this.repo}/releases?per_page=${count}`;
		log.debug({ url, count }, "github: listing releases");
		const res = await fetch(url, { headers: this.headers() });
		if (!res.ok) {
			log.warn({ status: res.status }, "github: listing releases failed");
			return [];
		}
		const data = (await res.json()) as RawRelease[];
		return data.map((r) => this.toNote(r));
	}
}
