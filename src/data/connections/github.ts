import { z } from "zod";
import type { ReleaseNote } from "../../domain/release/structures.ts";
import { logger } from "../../libs/log.ts";

const log = logger("github");

const HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "scriba",
};

const ReleaseSchema = z.object({
  tag_name: z.string(),
  name: z.string().nullable(),
  body: z.string().nullable(),
  html_url: z.string(),
  published_at: z.string(),
});
type Release = z.infer<typeof ReleaseSchema>;

export class GithubReleases {
  constructor(private repo = "khaosdoctor/scriba") {}

  private toNote(release: Release): ReleaseNote {
    return {
      tag: release.tag_name,
      version: release.tag_name.replace(/^v/, ""),
      name: release.name || release.tag_name,
      body: release.body ?? "",
      url: release.html_url,
      publishedAt: release.published_at,
    };
  }

  private async get<S extends z.ZodType>(
    url: string,
    what: string,
    warnFields: object,
    schema: S,
  ): Promise<z.infer<S> | null> {
    const res = await fetch(url, {
      headers: HEADERS,
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

  latest(): Promise<ReleaseNote | null> {
    return this.fetchOne(
      `https://api.github.com/repos/${this.repo}/releases/latest`,
    );
  }

  byVersion(version: string): Promise<ReleaseNote | null> {
    const tag = version.startsWith("v") ? version : `v${version}`;
    return this.fetchOne(
      `https://api.github.com/repos/${this.repo}/releases/tags/${tag}`,
    );
  }

  async recent(count: number): Promise<ReleaseNote[]> {
    const url = `https://api.github.com/repos/${this.repo}/releases?per_page=${count}`;
    log.debug({ url, count }, "github: listing releases");
    const data = await this.get(
      url,
      "listing releases",
      {},
      z.array(ReleaseSchema),
    );
    return data ? data.map((release) => this.toNote(release)) : [];
  }
}
