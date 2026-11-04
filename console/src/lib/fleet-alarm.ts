// The fleet alarm (decision-log D23) without React: what is shown, what was already acknowledged, and the desktop notification text.

export interface OpenPattern { id: string; title: string; sites: number; cabinets: number; clients: number; resolvedAt?: string | null }

/** The open patterns not yet acknowledged in this browser, widest first. */
export function unacknowledged<T extends OpenPattern>(open: readonly T[], acknowledged: ReadonlySet<string>): T[] {
  return open.filter(p => !p.resolvedAt && !acknowledged.has(p.id)).sort((a, b) => b.sites - a.sites);
}

/** The line in the banner and the desktop notification. */
export function alarmText(p: Pick<OpenPattern, "title" | "sites" | "cabinets" | "clients">): string {
  const n = (v: number, one: string) => `${Number.isInteger(v) && v >= 0 ? v.toLocaleString("en-US") : "?"} ${one}${v === 1 ? "" : "s"}`;
  const title = p.title.replace(/^Fleet pattern: /, "");
  return `${title}: ${n(p.sites, "site")}, ${n(p.cabinets, "cabinet")}, ${n(p.clients, "client")}`;
}

/** Acknowledged ids as stored in this browser: a list of ids, anything else is nothing. */
export function parseAcknowledged(text: string | null): Set<string> {
  if (!text) return new Set();
  try {
    const v: unknown = JSON.parse(text);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/.test(x)).slice(-200) : []);
  } catch { return new Set(); }
}
