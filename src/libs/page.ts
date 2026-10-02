export type PageView<T> = {
  items: T[];
  page: number;
  pages: number;
  offset: number;
};

/** Clamps `page` into range, so a stale or crafted button still shows a real page. */
export function paginate<T>(
  items: readonly T[],
  page: number,
  size: number,
): PageView<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const offset = p * size;
  return { items: items.slice(offset, offset + size), page: p, pages, offset };
}
