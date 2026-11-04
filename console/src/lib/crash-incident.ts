// The cabinet's crash incident (decision-log D21) as the console shows it. Kept free of React so it is tested on its own.

export interface CrashIncidentAlert { id: string; title: string; state: string; occurrences: number; firstSeen: string; lastSeen: string }
export interface CrashIncident { incidentId: string; state: string; openedAt: string; closedAt: string | null; alerts: CrashIncidentAlert[] }

/** How many times, in words: each alert is shown once with its count, never once per occurrence. */
export function timesText(n: unknown): string {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return "—";
  return n === 1 ? "Once" : `${n.toLocaleString("en-US")} times`;
}

/** The incident's state as a badge. */
export function incidentBadge(state: string): ["ok" | "warn" | "crit" | "off", string] {
  switch (state) {
    case "resolved": return ["ok", "Closed: every crash alert resolved"];
    case "unresolved": return ["off", "Closed unresolved"];
    case "open": case "awaiting_approval": case "approved": case "repairing": return ["crit", "Open"];
    default: return ["off", "Unknown"];
  }
}

/** All the crashes the incident holds, counted once each: the total of its alerts' counts. */
export function totalCrashes(alerts: readonly Pick<CrashIncidentAlert, "occurrences">[]): number {
  return alerts.reduce((n, a) => n + (Number.isInteger(a.occurrences) && a.occurrences > 0 ? a.occurrences : 0), 0);
}
