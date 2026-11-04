// Crash incidents (engine part 5b; decision-log D21, owner's choice 2026-11-04). A blue-screen or reboot-loop alert opens one incident
// per cabinet from the crash-incidents module; every further crash alert on the cabinet joins it; it closes once every crash alert it
// holds is resolved, by a person or on its own (a reboot loop ends after 2 hours up).
//
// Repeats never multiply: alerts already fold every repeat of the same kind into one alert with a count (its occurrences), and the
// incident links each alert once, with one evidence step when it joins. Fifteen blue screens are one alert counted 15 times on one
// incident, not fifteen rows. The crash page reads the count from the alert itself, so it is always current.
//
// The state is reconciled from the alerts rather than followed through every place an alert is raised or resolved: after an event
// batch, after a person resolves an alert, and in the one-minute sweep. Nothing here runs anything on a cabinet.
import { readModules } from "@mashura/cabinet-contracts/load";
import { isUniqueViolation, type Pool, type Queryable } from "../db/db.js";
import { parseModule, type DiagnosticModule } from "../diagnose/module.js";
import { appendStep, linkIncident, openIncident, type Actor } from "./incidents.js";

export const CRASH_ACTOR: Actor = { kind: "system", name: "crash-monitor" };
/** The issue types that are crashes: a blue screen and a reboot loop. */
// The ids of ISSUE.crash and ISSUE.rebootLoop (rules.ts), written out: rules.ts imports alerts.ts, which imports this file, so reading
// ISSUE here at load would come before it exists. crashes.test.ts checks they stay equal.
const CRASH = "00000000-0000-4000-8000-000000000109", REBOOT_LOOP = "00000000-0000-4000-8000-000000000117";
export const CRASH_ISSUES: readonly string[] = [CRASH, REBOOT_LOOP];

export interface CrashAlert { id: string; issueTypeId: string; title: string; state: string; occurrences: number }
export type CrashPlan =
  | { action: "none" }
  | { action: "open"; symptom: string; link: CrashAlert[] }
  | { action: "add"; link: CrashAlert[] }
  | { action: "close" };

/** The rule the module names: what to do with the cabinet's crash incident, given its crash alerts. Pure, so it is tested on its own. */
export function planCrashIncident(alerts: readonly CrashAlert[], open: { linked: ReadonlySet<string> } | null): CrashPlan {
  const active = alerts.filter(a => a.state !== "resolved");
  if (!open) {
    if (active.length === 0) return { action: "none" };
    const first = [...active].sort((a, b) => (a.issueTypeId === b.issueTypeId ? 0 : a.issueTypeId === CRASH ? -1 : 1))[0]!;
    return { action: "open", symptom: first.title, link: active };
  }
  const fresh = active.filter(a => !open.linked.has(a.id));
  if (fresh.length > 0) return { action: "add", link: fresh };
  if (active.length === 0) return { action: "close" };
  return { action: "none" };
}

/** The rules the crash-incidents module names. A module naming any other rule is refused. */
export const CRASH_RULES = { "crash.incident": planCrashIncident } as const;

let cache: DiagnosticModule | null = null;
/** The crash-incidents module, read and checked once. */
export function crashModule(): DiagnosticModule {
  if (cache) return cache;
  const file = readModules().find(f => f.file === "crash-incidents.json");
  if (!file) throw new Error("the crash-incidents module is missing");
  cache = parseModule(file.data, new Set(Object.keys(CRASH_RULES)));
  return cache;
}

const crashOf = (cabinetId: string, alerts: string) => `
  SELECT id, issue_type_id, title, state, occurrences FROM alerts
   WHERE cabinet_id = $1 AND issue_type_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($2)) AND ${alerts}`;

const summaryOf = (a: CrashAlert) => `${a.title}${Number(a.occurrences) > 1 ? ` (${Number(a.occurrences)} times so far)` : ""}`.slice(0, 300);

/** Brings the cabinet's crash incident in line with its crash alerts. Returns what it did. */
export async function syncCrashIncident(pool: Pool, cabinetId: string): Promise<{ action: CrashPlan["action"]; incidentId: string | null }> {
  const module = crashModule();
  const open = (await pool.query<{ id: string }>(
    `SELECT TOP (1) id FROM incidents WHERE cabinet_id = $1 AND module_id = $2 AND closed_at IS NULL`, [cabinetId, module.id])).rows[0];
  const openId = open ? open.id.toLowerCase() : null;
  const linked = openId ? new Set((await pool.query<{ ref_id: string }>(
    "SELECT ref_id FROM incident_links WHERE incident_id = $1 AND kind = 'alert'", [openId])).rows.map(r => r.ref_id.toLowerCase())) : null;
  // The cabinet's unresolved crash alerts, and those the open incident holds whatever their state.
  const rows = (await pool.query<{ id: string; issue_type_id: string; title: string; state: string; occurrences: number }>(
    crashOf(cabinetId, linked && linked.size > 0 ? "(state <> 'resolved' OR id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($3)))" : "state <> 'resolved'"),
    linked && linked.size > 0 ? [cabinetId, JSON.stringify(CRASH_ISSUES), JSON.stringify([...linked])] : [cabinetId, JSON.stringify(CRASH_ISSUES)])).rows;
  const alerts: CrashAlert[] = rows.map(r => ({ id: r.id.toLowerCase(), issueTypeId: r.issue_type_id.toLowerCase(), title: r.title, state: r.state, occurrences: Number(r.occurrences) }));
  const plan = planCrashIncident(alerts, linked ? { linked } : null);
  const link = async (incidentId: string, list: readonly CrashAlert[]) => {
    for (const a of list) {
      if ((await linkIncident(pool, incidentId, "alert", a.id, CRASH_ACTOR)).added)
        await appendStep(pool, incidentId, { kind: "evidence", summary: summaryOf(a), detail: { alertId: a.id, occurrences: a.occurrences } }, CRASH_ACTOR);
    }
  };
  switch (plan.action) {
    case "none": return { action: "none", incidentId: openId };
    case "open": {
      let id: string;
      try {
        id = await openIncident(pool, { cabinetId, symptom: plan.symptom, module: { id: module.id, version: module.version }, by: CRASH_ACTOR });
      } catch (e) {
        // Another run opened it a moment ago (incidents_one_open_crash): add to that one instead.
        if (!isUniqueViolation(e)) throw e;
        return syncCrashIncident(pool, cabinetId);
      }
      await link(id, plan.link);
      return { action: "open", incidentId: id };
    }
    case "add":
      await link(openId!, plan.link);
      return { action: "add", incidentId: openId };
    case "close":
      await appendStep(pool, openId!, { kind: "close", result: "resolved", summary: "Every crash alert on this cabinet is resolved; closed by the platform." }, CRASH_ACTOR);
      return { action: "close", incidentId: openId };
  }
}

/** The one-minute sweep: every cabinet with an unresolved crash alert or an open crash incident is brought in line. */
export async function sweepCrashIncidents(pool: Pool, limit = 500): Promise<number> {
  const cabinets = (await pool.query<{ cabinet_id: string }>(
    `SELECT TOP (${Math.max(1, Math.min(5000, Math.floor(limit)))}) cabinet_id FROM (
       SELECT cabinet_id FROM alerts WHERE state <> 'resolved' AND issue_type_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))
       UNION SELECT cabinet_id FROM incidents WHERE module_id = N'crash-incidents' AND closed_at IS NULL) c`, [JSON.stringify(CRASH_ISSUES)])).rows;
  let changed = 0;
  for (const c of cabinets) if ((await syncCrashIncident(pool, c.cabinet_id.toLowerCase())).action !== "none") changed++;
  return changed;
}

/** The crash incident shown on the crash page: the open one, else the latest; each of its alerts once, with its current count. */
export async function crashIncidentFor(db: Queryable, cabinetId: string): Promise<{ incidentId: string; state: string; openedAt: string; closedAt: string | null;
  alerts: { id: string; title: string; state: string; occurrences: number; firstSeen: string; lastSeen: string }[] } | null> {
  const inc = (await db.query<{ id: string; state: string; opened_at: Date; closed_at: Date | null }>(
    `SELECT TOP (1) id, state, opened_at, closed_at FROM incidents WHERE cabinet_id = $1 AND module_id = N'crash-incidents'
      ORDER BY CASE WHEN closed_at IS NULL THEN 0 ELSE 1 END, opened_at DESC, id`, [cabinetId])).rows[0];
  if (!inc) return null;
  const alerts = (await db.query<{ id: string; title: string; state: string; occurrences: number; first_seen: Date; last_seen: Date }>(
    `SELECT a.id, a.title, a.state, a.occurrences, a.first_seen, a.last_seen FROM incident_links l JOIN alerts a ON a.id = l.ref_id
      WHERE l.incident_id = $1 AND l.kind = 'alert' ORDER BY a.first_seen, a.id`, [inc.id])).rows;
  return { incidentId: inc.id.toLowerCase(), state: inc.state, openedAt: inc.opened_at.toISOString(), closedAt: inc.closed_at?.toISOString() ?? null,
    alerts: alerts.map(a => ({ id: a.id.toLowerCase(), title: a.title, state: a.state, occurrences: Number(a.occurrences), firstSeen: a.first_seen.toISOString(), lastSeen: a.last_seen.toISOString() })) };
}
