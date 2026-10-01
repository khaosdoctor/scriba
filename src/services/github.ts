import { z } from "zod";
import { logger } from "../log.ts";
import { type Release, ReleaseSchema } from "../models/ops.ts";

const log = logger("github");

export interface ReleaseNote {
  tag: string; // e.g. "v1.23.1"
  version: string; // tag with the leading "v" stripped
  name: string;
  body: string; // release notes markdown (the changelog section for this version)
  url: string; // GitHub Release page
  publishedAt: string; // ISO timestamp
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

  private toNote(r: Release): ReleaseNote {
    return {
      tag: r.tag_name,
      version: r.tag_name.replace(/^v/, ""),
      name: r.name || r.tag_name,
      body: r.body ?? "",
      url: r.html_url,
      publishedAt: r.published_at,
    };
  }

  private async get<S extends z.ZodType>(
    url: string,
    what: string,
    warnFields: object,
    schema: S,
  ): Promise<z.infer<S> | null> {
    const res = await fetch(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return schema.parse(await res.json());
    log.warn({ ...warnFields, status: res.status }, `github: ${what} failed`);
    return null;
  }

  private async fetchOne(url: string): Promise<ReleaseNote | null> {
    log.debug({ url }, "github: fetching release");
    const raw = await this.get(url, "fetching release", { url }, ReleaseSchema);
    return raw && this.toNote(raw);
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
    const data = await this.get(
      url,
      "listing releases",
      {},
      z.array(ReleaseSchema),
    );
    return data ? data.map((r) => this.toNote(r)) : [];
  }
}
