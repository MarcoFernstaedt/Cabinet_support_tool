// Incidents opened by diagnoses (decision D16, owner's choice 2026-11-03). When a network diagnosis or a cabinet diagnosis finds a
// problem, the platform keeps one open incident per cabinet and module: the first problem opens it with the problem as its symptom,
// every later run of the same module adds what it found as evidence and is linked to it, and a later run that finds the module clean
// closes it as resolved (as a passed verification when a repair was running). A run that could not read enough to tell changes
// nothing, so a cabinet that is offline or half-read never closes an incident by saying nothing.
//
// Nothing here runs anything on a cabinet. It is called after a diagnosis is stored, and a failure here never fails the diagnosis.
import type { Pool } from "../db/db.js";
import type { AreaSummary } from "../diagnose/cabinet-findings.js";
import type { Finding as NetworkFinding } from "../diagnose/network-findings.js";
import { appendStep, linkIncident, openIncident, type Actor, type IncidentState } from "./incidents.js";

/** What one run said about one module. */
export type CheckOutcome =
  | { state: "problem"; titles: string[]; problems: number; warnings: number }
  | { state: "warning"; titles: string[]; warnings: number }
  | { state: "clean" }
  | { state: "unknown" };

export const DIAGNOSIS_ACTOR: Actor = { kind: "system", name: "diagnosis" };

/** A network diagnosis's findings as one outcome. A run that could not read the settings tells nothing, whatever else it found. */
export function networkOutcome(findings: readonly NetworkFinding[]): CheckOutcome {
  const problems = findings.filter(f => f.severity === "problem" && !f.causedBy);
  const warnings = findings.filter(f => f.severity === "warning" && !f.causedBy);
  if (problems.length > 0) return { state: "problem", titles: problems.map(f => f.title), problems: problems.length, warnings: warnings.length };
  if (findings.some(f => f.id === "config" && f.certainty === "not_checked")) return { state: "unknown" };
  if (warnings.length > 0) return { state: "warning", titles: warnings.map(f => f.title), warnings: warnings.length };
  return { state: "clean" };
}

/**
 * A cabinet diagnosis as one outcome per cabinet module, from its area summaries (the area's state already accounts for reads that
 * failed). The network area is left out: its findings come from the network diagnosis run alongside, which records its own.
 */
export function cabinetOutcomes(areas: readonly AreaSummary[], moduleForArea: ReadonlyMap<string, { id: string; version: number }>):
  { module: { id: string; version: number }; outcome: CheckOutcome }[] {
  const out: { module: { id: string; version: number }; outcome: CheckOutcome }[] = [];
  for (const a of areas) {
    if (a.area === "network") continue;
    const module = moduleForArea.get(a.area);
    if (!module) continue;
    const outcome: CheckOutcome = a.state === "problem" ? { state: "problem", titles: [a.summary], problems: 1, warnings: 0 }
      : a.state === "warning" ? { state: "warning", titles: [a.summary], warnings: 1 }
      : a.state === "ok" ? { state: "clean" } : { state: "unknown" };
    out.push({ module, outcome });
  }
  return out;
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
/** One line of plain text: anything that is not printable on one line becomes a space. Findings' titles come from cabinet data. */
const oneLine = (s: string) => [...s].map(ch => { const c = ch.codePointAt(0)!; return c < 32 || c === 127 || (c >= 0x80 && c < 0xa0) || c === 0x2028 || c === 0x2029 ? " " : ch; }).join("").split(" ").filter(Boolean).join(" ");
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export type Recorded = { action: "opened" | "added" | "closed" | "none"; incidentId: string | null };

/**
 * Records what one run of one module said on the cabinet's open incident for that module, opening one for a problem and closing it on a
 * clean run. `label` names the run for people ("The network diagnosis").
 */
export async function recordCheck(pool: Pool, o: { cabinetId: string; diagnosisId: string; module: { id: string; version: number }; label: string; outcome: CheckOutcome }): Promise<Recorded> {
  const open = (await pool.query<{ id: string; state: IncidentState }>(
    `SELECT TOP (1) id, state FROM incidents WHERE cabinet_id = $1 AND module_id = $2 AND state NOT IN ('resolved', 'unresolved') ORDER BY opened_at DESC, id`,
    [o.cabinetId, o.module.id])).rows[0];
  const outcome = o.outcome;
  const evidence = async (incidentId: string, summary: string, detail: Record<string, string | number>) => {
    await appendStep(pool, incidentId, { kind: "evidence", summary: clip(oneLine(summary), 300), detail: { diagnosisId: o.diagnosisId, ...detail } }, DIAGNOSIS_ACTOR);
    await linkIncident(pool, incidentId, "diagnosis", o.diagnosisId, DIAGNOSIS_ACTOR);
  };
  switch (outcome.state) {
    case "problem": {
      const titles = outcome.titles.map(oneLine).filter(Boolean);
      const symptom = clip(titles[0] || `${o.label} found a problem`, 200);
      const id = open ? open.id.toLowerCase() : await openIncident(pool, { cabinetId: o.cabinetId, symptom, module: o.module, by: DIAGNOSIS_ACTOR });
      await evidence(id, `${o.label} found ${plural(outcome.problems, "problem")}: ${titles.join("; ")}`, { problems: outcome.problems, warnings: outcome.warnings });
      return { action: open ? "added" : "opened", incidentId: id };
    }
    case "warning": {
      if (!open) return { action: "none", incidentId: null };
      const id = open.id.toLowerCase();
      await evidence(id, `${o.label} found no problem, but ${plural(outcome.warnings, "warning")}: ${outcome.titles.map(oneLine).join("; ")}`, { problems: 0, warnings: outcome.warnings });
      return { action: "added", incidentId: id };
    }
    case "clean": {
      if (!open) return { action: "none", incidentId: null };
      const id = open.id.toLowerCase();
      await evidence(id, `${o.label} found nothing wrong.`, { problems: 0, warnings: 0 });
      if (open.state === "repairing") await appendStep(pool, id, { kind: "verification", result: "passed", summary: `${o.label} found nothing wrong after the repair.` }, DIAGNOSIS_ACTOR);
      else await appendStep(pool, id, { kind: "close", result: "resolved", summary: `${o.label} found nothing wrong; closed by the platform.` }, DIAGNOSIS_ACTOR);
      return { action: "closed", incidentId: id };
    }
    case "unknown":
      return { action: "none", incidentId: null };
  }
}
