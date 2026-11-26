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

/** What the affected cabinets are that the others are not (decision-log D157): one attribute value, counted on both sides. */
export interface SharedAttribute { attribute: string; name: string; value: string; affected: number; affectedShare: number; unaffected: number; unaffectedShare: number; standsOut: boolean }

/** The values that stand out, as the server already ordered them; a list without the field (an older server) is empty. */
export const standingAttributes = (list: readonly SharedAttribute[] | undefined | null): SharedAttribute[] =>
  Array.isArray(list) ? list.filter(a => a && a.standsOut === true && typeof a.name === "string" && typeof a.value === "string") : [];

/** One line for the case notes and the pattern report: what it is, on how many affected and other cabinets. */
export function attributeLine(a: SharedAttribute, affectedTotal: number, unaffectedTotal: number): string {
  const n = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0;
  return `${a.name} ${a.value}: ${n(a.affected)} of ${n(affectedTotal)} affected (${n(a.affectedShare)}%) vs ${n(a.unaffected)} of ${n(unaffectedTotal)} unaffected (${n(a.unaffectedShare)}%)`;
}
