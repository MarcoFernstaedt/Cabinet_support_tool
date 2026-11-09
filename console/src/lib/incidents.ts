// Incident records as the console shows them (docs/platform/archive/diagnostic-engine-execution.md, item 6): plain words for each state and
// step, and one line saying where an incident stands.

export type IncidentState = "open" | "awaiting_approval" | "approved" | "repairing" | "resolved" | "unresolved";
export type StepKind = "symptom" | "evidence" | "hypothesis" | "proposed_repair" | "approval" | "execution" | "verification" | "note" | "close";
export type Tone = "ok" | "warn" | "crit" | "info" | "off";
export interface Actor { kind: "user" | "system"; name: string }
export interface IncidentSummary {
  id: string; state: IncidentState; symptom: string; module: { id: string; version: number } | null;
  openedBy: Actor; openedAt: string; updatedAt: string; closedAt: string | null; outcome: string | null;
}
export interface IncidentStep { position: number; kind: StepKind; actor: Actor; at: string; summary: string; detail: Record<string, string | number | boolean | null> | null }
export interface IncidentLink { kind: "alert" | "diagnosis" | "command" | "case_note" | "fleet_job"; refId: string; linkedAt: string }
export interface IncidentDetail extends IncidentSummary { steps: IncidentStep[]; links: IncidentLink[] }

export const STATE: Record<IncidentState, [string, Tone]> = {
  open: ["Open", "warn"], awaiting_approval: ["Waiting for approval", "info"], approved: ["Approved", "info"], repairing: ["Repair sent", "info"],
  resolved: ["Resolved", "ok"], unresolved: ["Closed unresolved", "off"],
};
export const stateOf = (s: string): [string, Tone] => STATE[s as IncidentState] ?? [s, "off"];

const STEP: Record<StepKind, string> = {
  symptom: "Symptom", evidence: "Evidence", hypothesis: "Likely cause", proposed_repair: "Repair proposed", approval: "Approved",
  execution: "Repair sent", verification: "Checked", note: "Note", close: "Closed",
};
export const stepLabel = (k: string): string => STEP[k as StepKind] ?? k;

export const actorText = (a: Actor): string => (a.kind === "user" ? a.name : `the platform (${a.name})`);

const LINK: Record<IncidentLink["kind"], string> = { alert: "Alert", diagnosis: "Diagnosis", command: "Command", case_note: "Case note", fleet_job: "Fleet job" };
export const linkLabel = (k: string): string => LINK[k as IncidentLink["kind"]] ?? k;

/** The one line under an incident: what happened last, or how it ended. */
export function incidentLine(i: IncidentSummary): string {
  if (i.closedAt) return i.outcome ? `Ended: ${i.outcome}` : "Closed.";
  if (i.state === "awaiting_approval") return "A repair is proposed and waits for a person to approve it.";
  if (i.state === "approved") return "The repair is approved and not yet sent.";
  if (i.state === "repairing") return "The repair was sent; it is checked next.";
  return `Opened by ${actorText(i.openedBy)}.`;
}

/** An open incident as the fleet triage list shows it (GET /api/incidents/open). */
export interface OpenIncident {
  id: string; state: IncidentState; symptom: string; module: { id: string; version: number } | null; openedAt: string; updatedAt: string;
  cabinet: { id: string; name: string }; site: { id: string; name: string }; client: { id: string; name: string };
  steps: number; runs: number; lastStep: { kind: StepKind; summary: string; at: string };
}

const MODULE_AREA: Record<string, string> = {
  "network-diagnosis": "Network", "sql-connectivity-ladder": "Sync database", "cabinet-system": "System", "cabinet-storage": "Storage",
  "cabinet-performance": "Performance", "cabinet-scanner": "Scanner", "cabinet-devices": "Devices", "cabinet-services": "Services",
  "cabinet-updates": "Updates", "cabinet-time": "Time", "cabinet-logs": "Logs",
};
/** The area an incident belongs to, from the module that opened it; a module the console does not know is shown by its id. */
export const moduleArea = (m: { id: string } | null): string => (m === null ? "Opened by hand" : MODULE_AREA[m.id] ?? m.id);

/** How often a problem has been looked at, in words: the first look, or how many runs since. */
export function runsText(runs: number): string {
  if (!Number.isFinite(runs) || runs <= 0) return "Not looked at by a diagnosis";
  return runs === 1 ? "Found by one diagnosis" : `Seen in ${runs} diagnoses`;
}

/** Where to open one incident: its cabinet's History tab, with that incident open. */
export const incidentHref = (i: { id: string; cabinet: { id: string } }): string =>
  `/cabinets/${encodeURIComponent(i.cabinet.id)}/history?incident=${encodeURIComponent(i.id)}`;
