export interface ReleaseNote {
  tag: string; // e.g. "v1.23.1"
  version: string; // tag with the leading "v" stripped
  name: string;
  body: string; // release notes markdown (the changelog section for this version)
  url: string; // GitHub Release page
  publishedAt: string; // ISO timestamp
}
