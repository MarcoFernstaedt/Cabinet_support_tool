// The small pieces the configuration screens share (docs/spec/15-baselines-and-config.md): the categories and their names, how a value is shown,
// how long ago and between which looks a change happened, and where a baseline expectation comes from. The wording never says one thing caused another.
import { fullTime } from "../lib/time";

export const CATEGORIES: [string, string][] = [
  ["network", "Network"], ["services", "Services"], ["drivers", "Drivers"], ["updates", "Windows updates"], ["firewall", "Firewall"], ["time", "Time"],
  ["devices", "Devices"], ["applications", "Software"], ["hosts", "Hosts file"], ["tasks", "Tasks and startup"], ["system", "Hardware and identity"],
];
export const categoryName = (c: string) => CATEGORIES.find(x => x[0] === c)?.[1] ?? c;

/** One configuration value as plain text. */
export const show = (v: unknown): string => v === null || v === undefined ? "none" : Array.isArray(v) ? (v.length ? v.join(", ") : "none") : typeof v === "boolean" ? (v ? "yes" : "no") : String(v);

export type FieldChanges = Record<string, { before: unknown; after: unknown }>;

export function FieldChange({ fields }: { fields: FieldChanges }) {
  return <ul className="plain small">{Object.entries(fields).slice(0, 12).map(([f, v]) => <li key={f}><strong>{f}</strong>: {show(v.before)} <span aria-label="became">→</span> {show(v.after)}</li>)}</ul>;
}

/** When a change happened, as much as is known: Windows' own time if there is one, otherwise the window between two looks. */
export function WhenKnown({ c }: { c: { notBefore: string | null; observedAt: string; exactAt: string | null; gap?: boolean } }) {
  if (c.exactAt) return <span title="Windows recorded this time itself">{fullTime(c.exactAt)} <span className="muted small">(recorded by Windows)</span></span>;
  return <span>{c.notBefore ? <>between {fullTime(c.notBefore)} and {fullTime(c.observedAt)}</> : <>first seen {fullTime(c.observedAt)}</>}{c.gap && <span className="muted small"> (the cabinet was out of contact: older looks were lost)</span>}</span>;
}

export function Origin({ o }: { o: { kind: string; name: string; version: number } }) {
  return <span className="muted small">from the {o.kind === "global" ? "baseline for all cabinets" : `${o.kind} baseline "${o.name}"`}, version {o.version}</span>;
}

export type Health = "healthy" | "degraded" | "offline" | "unknown";
export const HEALTH_TONE: Record<Health, "ok" | "warn" | "crit" | "off"> = { healthy: "ok", degraded: "crit", offline: "warn", unknown: "off" };
export const HEALTH_LABEL: Record<Health, string> = { healthy: "Healthy", degraded: "Not as the baseline says", offline: "Out of contact", unknown: "Not judged yet" };

/** Why there is nothing to compare with the last healthy state (F8.R5): said plainly, with what would change it. */
export const NOTHING_TO_COMPARE: Record<string, string> = {
  not_evaluated: "This cabinet's configuration health has not been judged yet, so there is no healthy state to compare with.",
  no_configuration: "This cabinet has not reported its configuration yet, so it cannot be judged healthy or compared. Read its configuration now to start.",
  no_baseline: "No approved baseline applies to this cabinet, so it is never judged healthy and there is nothing to compare with. Approve a baseline for its site, client or role.",
  never_healthy: "This cabinet has been judged against its baseline but never found healthy, so there is no healthy state to compare with.",
  no_mark: "This cabinet was healthy, but no record of its configuration at that time is kept, so there is nothing to compare with.",
  versions_pruned: "The configuration this cabinet had when it was last healthy is no longer kept, so none of it can be compared.",
};
