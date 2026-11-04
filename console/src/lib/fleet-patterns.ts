// Fleet patterns (decision-log D22) as the console shows them. Kept free of React so it is tested on its own.

export interface FleetPattern { id: string; title: string; severity: string; clients: number; sites: number; cabinets: number; occurrences: number;
  firstSeen: string; lastSeen: string; openedAt: string; resolvedAt: string | null;
  /** When it first rang the alarm; null while a minor one is listed quietly (D25). */
  alarmedAt: string | null; issueTypeId?: string | null }

/** "50 sites, 50 cabinets, 1 client": the reach of a pattern in one line. */
export function reachText(p: Pick<FleetPattern, "sites" | "cabinets" | "clients">): string {
  const n = (v: number, one: string) => `${Number.isInteger(v) && v >= 0 ? v.toLocaleString("en-US") : "?"} ${one}${v === 1 ? "" : "s"}`;
  return `${n(p.sites, "site")}, ${n(p.cabinets, "cabinet")}, ${n(p.clients, "client")}`;
}

/** Open patterns first, the widest first; then resolved ones, newest first. */
export function orderPatterns<T extends Pick<FleetPattern, "resolvedAt" | "sites" | "openedAt">>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => Number(a.resolvedAt !== null) - Number(b.resolvedAt !== null) || b.sites - a.sites || b.openedAt.localeCompare(a.openedAt));
}
