// Every cabinet of a site, for the screens that pick one of them (decision-log D85). The site route sends its cabinets a page at a time
// (D81): asked without a page it sends the first 200. A picker built from that one answer could not offer cabinet 201 or later. These read
// the first page exactly as before, then ask for the rest, 500 at a time, until the server says there are no more.
export const SITE_PAGE_LIMIT = 500;
/** Stops a server that keeps saying "more" from being followed for good: 200 pages of 500 is far beyond any site. */
export const MAX_SITE_PAGES = 200;

export interface SitePage<C> { cabinets: C[]; cabinetsPage: { limit: number; offset: number; hasMore: boolean } }

/** The site's first answer, with `cabinets` holding every cabinet of the site, in the server's order. */
export async function everySiteCabinet<C, A extends SitePage<C>>(get: (path: string) => Promise<A>, siteId: string): Promise<A> {
  const base = `/api/fleet/sites/${encodeURIComponent(siteId)}`;
  const first = await get(base);
  const all = [...first.cabinets];
  let page: SitePage<C> = first;
  for (let n = 1; page.cabinetsPage.hasMore; n++) {
    if (n >= MAX_SITE_PAGES || page.cabinets.length === 0) throw new Error("The site's cabinets could not be read in full. Try again.");
    page = await get(`${base}?limit=${SITE_PAGE_LIMIT}&offset=${all.length}`);
    all.push(...page.cabinets);
  }
  return { ...first, cabinets: all };
}
