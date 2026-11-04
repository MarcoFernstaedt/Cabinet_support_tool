// Fleet patterns (decision-log D22, owner's choice 2026-11-04). The same problem on cabinets at many sites within a window is one fleet
// alert: a bad driver or update that makes cabinets everywhere log the same error, blue-screen, loop on restart or go offline. The
// owner's examples: 50 of 100 sites showing one error after the same driver install, and 60 sites in reboot loops at once. Defaults: 5
// sites within 24 hours, both Admin settings, so a fleet-wide problem is raised while it is still a handful of sites.
//
// A problem is the alerts' own grouping: one issue type (blue screen, reboot loop, offline, a mapped error...) or, for an error no rule
// recognizes, one alert signature (the same log, source and event ID). Each problem is one fleet pattern, counted up as it spreads;
// repeats never make a second one. It resolves itself once no cabinet has the problem unresolved. The report says which clients,
// sites and cabinets have it, since when, and what they have in common that the others do not (a driver, an update, software) from the
// changes each cabinet recorded before its problem began. Nothing here runs anything on a cabinet.
import { audit, isUniqueViolation, notify, type Pool, type Queryable } from "../db/db.js";
import { compareChanges, type ChangeComparison } from "./crashes.js";
import { platformSettings } from "./settings.js";

export interface PatternCount { key: string; issueTypeId: string | null; title: string; severity: string; clients: number; sites: number; cabinets: number; occurrences: number; firstSeen: Date; lastSeen: Date }

/**
 * A problem's key, on an alert row `a` joined to its cabinet `k`: issue:<issue type> for a known issue, else the alert signature, with
 * demo| in front for a demo cabinet. The demo fleet is a pattern of its own, never folded into a real one: the count, the update, the
 * resolve check and the report all read this one expression.
 */
const KEY = "CASE WHEN k.demo_scenario IS NULL THEN N'' ELSE N'demo|' END + CASE WHEN a.issue_type_id IS NOT NULL THEN N'issue:' + LOWER(CAST(a.issue_type_id AS nvarchar(36))) ELSE a.signature END";
/** Whether a pattern key is the demo fleet's. */
export const isDemoKey = (key: string) => key.startsWith("demo|");

/** The notification channel the live stream listens on: "<pattern id> opened|resolved". */
export const FLEET_CHANNEL = "fleet_patterns";

/**
 * As soon as possible (D23): an event batch that raised a new alert asks for a fleet check, which runs within a couple of seconds instead of
 * waiting for the one-minute sweep. Requests that arrive while one is pending or running share it, so a burst of batches is one check.
 */
let pending: Promise<void> | null = null;
let again = false;
export function checkFleetSoon(pool: Pool, delayMs = 2_000): Promise<void> {
  if (pending) { again = true; return pending; }
  pending = (async () => {
    try {
      do {
        again = false;
        await new Promise(r => setTimeout(r, delayMs));
        await sweepFleetPatterns(pool).catch(() => undefined);
      } while (again);
    } finally { pending = null; }
  })();
  return pending;
}

/** One fleet pattern by id, for the live stream. */
export async function fleetPatternById(db: Queryable, id: string): Promise<FleetPattern | null> {
  const r = (await db.query<Parameters<typeof toPattern>[0]>(`SELECT ${COLUMNS} FROM fleet_patterns WHERE id = $1`, [id])).rows[0];
  return r ? toPattern(r) : null;
}

/** Every problem seen at `minSites` or more sites within the last `hours`, from the alerts. Demo cabinets are counted with the demo only. */
export async function countPatterns(db: Queryable, o: { minSites: number; hours: number }): Promise<PatternCount[]> {
  const rows = (await db.query<{ k: string; issue_type_id: string | null; title: string; major: number; clients: number; sites: number; cabinets: number; occurrences: number; first_seen: Date; last_seen: Date }>(
    `SELECT ${KEY} AS k, MAX(a.issue_type_id) AS issue_type_id, MIN(a.title) AS title, MAX(CASE WHEN a.severity = 'major' THEN 1 ELSE 0 END) AS major,
            COUNT(DISTINCT s.client_id) AS clients, COUNT(DISTINCT k.site_id) AS sites, COUNT(DISTINCT a.cabinet_id) AS cabinets,
            SUM(CAST(a.occurrences AS bigint)) AS occurrences, MIN(a.first_seen) AS first_seen, MAX(a.last_seen) AS last_seen
       FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id JOIN sites s ON s.id = k.site_id
      WHERE a.last_seen > DATEADD(hour, -$1, SYSUTCDATETIME()) AND k.status = 'active'
      GROUP BY ${KEY}
     HAVING COUNT(DISTINCT k.site_id) >= $2`, [o.hours, o.minSites])).rows;
  return rows.map(r => ({ key: r.k, issueTypeId: r.issue_type_id?.toLowerCase() ?? null, title: r.title, severity: r.major ? "major" : "minor",
    clients: Number(r.clients), sites: Number(r.sites), cabinets: Number(r.cabinets), occurrences: Number(r.occurrences), firstSeen: r.first_seen, lastSeen: r.last_seen }));
}

/** The one-minute sweep: opens a fleet pattern for each problem past the threshold, counts open ones up, and resolves the ones gone. */
export async function sweepFleetPatterns(pool: Pool): Promise<{ opened: number; updated: number; resolved: number }> {
  const s = await platformSettings(pool);
  const found = await countPatterns(pool, { minSites: s.fleetPatternSites, hours: s.fleetPatternHours });
  let opened = 0, updated = 0;
  for (const p of found) {
    const title = `Fleet pattern: ${p.title}`.slice(0, 300);
    const args = [p.key, p.issueTypeId, title, p.severity, p.clients, p.sites, p.cabinets, p.occurrences, p.firstSeen, p.lastSeen];
    // Counts only grow while the pattern is open: a cabinet that recovers does not shrink what the pattern reached.
    const up = await pool.query(`UPDATE fleet_patterns SET clients = CASE WHEN $5 > clients THEN $5 ELSE clients END, sites = CASE WHEN $6 > sites THEN $6 ELSE sites END,
        cabinets = CASE WHEN $7 > cabinets THEN $7 ELSE cabinets END, occurrences = CASE WHEN $8 > occurrences THEN $8 ELSE occurrences END,
        severity = CASE WHEN $4 = 'major' THEN 'major' ELSE severity END, last_seen = CASE WHEN $10 > last_seen THEN $10 ELSE last_seen END
      WHERE pattern_key = $1 AND resolved_at IS NULL`, [p.key, null, null, p.severity, p.clients, p.sites, p.cabinets, p.occurrences, null, p.lastSeen]);
    if ((up.rowCount ?? 0) > 0) {
      updated++;
      // A minor pattern that has spread to the alarm level rings now (D25); it was listed quietly until here.
      const rang = await ring(pool, p.key, s.fleetMinorAlarmSites);
      if (rang) await notify(pool, FLEET_CHANNEL, `${rang} alarm`);
      continue;
    }
    try {
      const r = await pool.query<{ id: string }>(`INSERT INTO fleet_patterns (pattern_key, issue_type_id, title, severity, clients, sites, cabinets, occurrences, first_seen, last_seen)
        OUTPUT inserted.id VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, args);
      const id = r.rows[0]!.id.toLowerCase();
      await audit(pool, { actorKind: "system", actorId: "fleet-patterns", action: "fleet_pattern.open", targetKind: "fleet_pattern", targetId: id,
        outcome: "succeeded", details: { key: p.key, sites: p.sites, cabinets: p.cabinets, clients: p.clients, severity: p.severity } });
      // A major one rings at once; a minor one only from the alarm level (D25). Either way every console's list hears it within seconds,
      // and a ringing one is a red banner, a sound and a desktop notification (D23).
      await ring(pool, p.key, s.fleetMinorAlarmSites);
      await notify(pool, FLEET_CHANNEL, `${id} opened`);
      opened++;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // another sweep opened it a moment ago; the next look counts it up
    }
  }
  // Resolved: no cabinet still has the problem unresolved.
  const gone = (await pool.query<{ id: string }>(`DECLARE @o TABLE (id uniqueidentifier);
      UPDATE p SET resolved_at = SYSUTCDATETIME() OUTPUT inserted.id INTO @o FROM fleet_patterns p
       WHERE p.resolved_at IS NULL AND NOT EXISTS (SELECT 1 FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id WHERE a.state <> 'resolved' AND ${KEY} = p.pattern_key);
      SELECT id FROM @o;`)).rows;
  for (const g of gone) {
    await audit(pool, { actorKind: "system", actorId: "fleet-patterns", action: "fleet_pattern.resolve", targetKind: "fleet_pattern", targetId: g.id.toLowerCase(), outcome: "succeeded", details: {} });
    await notify(pool, FLEET_CHANNEL, `${g.id.toLowerCase()} resolved`);
  }
  return { opened, updated, resolved: gone.length };
}

/**
 * Rings the open pattern for this key if it has not rung yet and deserves it: major, or minor at minorSites or more (D25). Returns its id when
 * it rang just now, else null. Once rung it stays rung, so the alarm never flickers when counts or the setting change.
 */
async function ring(pool: Pool, key: string, minorSites: number): Promise<string | null> {
  const r = (await pool.query<{ id: string; severity: string; sites: number }>(`UPDATE fleet_patterns SET alarmed_at = SYSUTCDATETIME() OUTPUT inserted.id, inserted.severity, inserted.sites
      WHERE pattern_key = $1 AND resolved_at IS NULL AND alarmed_at IS NULL AND (severity = 'major' OR sites >= $2)`, [key, minorSites])).rows[0];
  if (!r) return null;
  const id = r.id.toLowerCase();
  await audit(pool, { actorKind: "system", actorId: "fleet-patterns", action: "fleet_pattern.alarm", targetKind: "fleet_pattern", targetId: id,
    outcome: "succeeded", details: { severity: r.severity, sites: Number(r.sites), minorAlarmSites: minorSites } });
  return id;
}

export interface FleetPattern { id: string; title: string; severity: string; issueTypeId: string | null; clients: number; sites: number; cabinets: number;
  occurrences: number; firstSeen: string; lastSeen: string; openedAt: string; resolvedAt: string | null;
  /** When it first rang the alarm; null while a minor pattern is listed quietly (D25). */
  alarmedAt: string | null }
const toPattern = (r: { id: string; title: string; severity: string; issue_type_id: string | null; clients: number; sites: number; cabinets: number; occurrences: number;
  first_seen: Date; last_seen: Date; opened_at: Date; resolved_at: Date | null; alarmed_at: Date | null }): FleetPattern => ({
  id: r.id.toLowerCase(), title: r.title, severity: r.severity, issueTypeId: r.issue_type_id?.toLowerCase() ?? null, clients: Number(r.clients), sites: Number(r.sites),
  cabinets: Number(r.cabinets), occurrences: Number(r.occurrences), firstSeen: r.first_seen.toISOString(), lastSeen: r.last_seen.toISOString(),
  openedAt: r.opened_at.toISOString(), resolvedAt: r.resolved_at?.toISOString() ?? null, alarmedAt: r.alarmed_at?.toISOString() ?? null });
const COLUMNS = "id, title, severity, issue_type_id, clients, sites, cabinets, occurrences, first_seen, last_seen, opened_at, resolved_at, alarmed_at";

/** Open fleet patterns, then those resolved in the last 30 days. */
export async function listFleetPatterns(db: Queryable): Promise<FleetPattern[]> {
  return (await db.query<Parameters<typeof toPattern>[0]>(`SELECT TOP (100) ${COLUMNS} FROM fleet_patterns
      WHERE resolved_at IS NULL OR resolved_at > DATEADD(day, -30, SYSUTCDATETIME())
      ORDER BY CASE WHEN resolved_at IS NULL THEN 0 ELSE 1 END, sites DESC, opened_at DESC`)).rows.map(toPattern);
}

export interface FleetPatternReport {
  pattern: FleetPattern;
  byClient: { client: string; sites: number; cabinets: number }[];
  /** Each site's affected cabinets, and the ones still affected there: a recovery is staged one site at a time, as fleet operations cover one site. */
  bySite: { client: string; siteId: string; site: string; cabinets: number; occurrences: number; stillAffected: { id: string; name: string }[] }[];
  cabinets: { id: string; name: string; client: string; siteId: string; site: string; occurrences: number; firstSeen: string; lastSeen: string; state: string; agentVersion: string | null }[];
  byAgentVersion: { version: string; affected: number; total: number }[];
  /** What the affected cabinets have in common that the others do not: changes in the 72 hours before each one's problem began. */
  commonFactors: ChangeComparison[];
  /** Incident response (roadmap module 42): how many have recovered (every alert of theirs in this pattern resolved) and how many have not. */
  recovered: number;
  stillAffected: number;
  /** By hour: cabinets whose problem began, and cabinets that recovered. */
  timeline: { hour: string; began: number; recovered: number }[];
}

/** The report a person reads: who has it, since when, and what they have in common. */
export async function fleetPatternReport(db: Queryable, id: string): Promise<FleetPatternReport | null> {
  const row = (await db.query<Parameters<typeof toPattern>[0] & { pattern_key: string }>(`SELECT ${COLUMNS}, pattern_key FROM fleet_patterns WHERE id = $1`, [id])).rows[0];
  if (!row) return null;
  const pattern = toPattern(row);
  const from = new Date(new Date(pattern.firstSeen).getTime() - 3_600_000), to = new Date(Math.max(Date.now(), new Date(pattern.lastSeen).getTime()));
  const affected = (await db.query<{ cabinet_id: string; name: string; client: string; site_id: string; site: string; occurrences: number; first_seen: Date; last_seen: Date; state: string; agent_version: string | null; demo: number; resolved_at: Date | null }>(
    `SELECT a.cabinet_id, k.name, c.name AS client, k.site_id, s.name AS site, SUM(CAST(a.occurrences AS bigint)) AS occurrences, MIN(a.first_seen) AS first_seen, MAX(a.last_seen) AS last_seen, MAX(a.resolved_at) AS resolved_at,
            MIN(CASE WHEN a.state <> 'resolved' THEN 'open' ELSE 'resolved' END) AS state, k.agent_version, CASE WHEN k.demo_scenario IS NULL THEN 0 ELSE 1 END AS demo
       FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
      WHERE ${KEY} = $1 AND a.last_seen >= $2
      GROUP BY a.cabinet_id, k.name, c.name, k.site_id, s.name, k.agent_version, k.demo_scenario ORDER BY MIN(a.first_seen), k.name`, [row.pattern_key, from])).rows;
  // The pattern's own kind decides, so its report holds only cabinets of that kind (the key already filtered them).
  const demo = isDemoKey(row.pattern_key);
  // The comparison group: the active cabinets of the same kind (real or demo), so a demo fleet never dilutes a real one.
  const population = (await db.query<{ id: string; agent_version: string | null }>(
    `SELECT id, agent_version FROM cabinets WHERE status = 'active' AND ${demo ? "demo_scenario IS NOT NULL" : "demo_scenario IS NULL"}`)).rows;
  const firstAt = new Map(affected.map(a => [a.cabinet_id.toLowerCase(), a.first_seen]));
  const ids = [...new Set([...population.map(p => p.id.toLowerCase()), ...firstAt.keys()])];
  const commonFactors = (await compareChanges(db, { ids, affected: firstAt, from, to })).filter(c => c.category !== "error" || c.standsOut);
  const clients = new Map<string, { sites: Set<string>; cabinets: number }>();
  const sites = new Map<string, { client: string; siteId: string; site: string; cabinets: number; occurrences: number; stillAffected: { id: string; name: string }[] }>();
  for (const a of affected) {
    const c = clients.get(a.client) ?? clients.set(a.client, { sites: new Set(), cabinets: 0 }).get(a.client)!;
    c.sites.add(a.site); c.cabinets++;
    // Keyed by the site's id: two sites of the same name (at different clients) stay apart.
    const key = a.site_id.toLowerCase();
    const s = sites.get(key) ?? sites.set(key, { client: a.client, siteId: key, site: a.site, cabinets: 0, occurrences: 0, stillAffected: [] }).get(key)!;
    s.cabinets++; s.occurrences += Number(a.occurrences);
    if (a.state === "open") s.stillAffected.push({ id: a.cabinet_id.toLowerCase(), name: a.name });
  }
  const versions = new Map<string, { affected: number; total: number }>();
  for (const p of population) { const v = p.agent_version ?? "unknown"; const e = versions.get(v) ?? { affected: 0, total: 0 }; e.total++; if (firstAt.has(p.id.toLowerCase())) e.affected++; versions.set(v, e); }
  // A cabinet has recovered when every alert of its in this pattern is resolved; it recovered when the last of them was.
  const hour = (d: Date) => d.toISOString().slice(0, 13) + ":00:00Z";
  const timeline = new Map<string, { began: number; recovered: number }>();
  const at = (h: string) => timeline.get(h) ?? timeline.set(h, { began: 0, recovered: 0 }).get(h)!;
  let recovered = 0;
  for (const a of affected) {
    at(hour(a.first_seen)).began++;
    if (a.state === "resolved") { recovered++; if (a.resolved_at) at(hour(a.resolved_at)).recovered++; }
  }
  return {
    pattern,
    recovered, stillAffected: affected.length - recovered,
    timeline: [...timeline.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([h, v]) => ({ hour: h, ...v })),
    byClient: [...clients.entries()].map(([client, v]) => ({ client, sites: v.sites.size, cabinets: v.cabinets })).sort((a, b) => b.cabinets - a.cabinets),
    // Sites still affected first, so the ones with recovery left to stage lead.
    bySite: [...sites.values()].sort((a, b) => b.stillAffected.length - a.stillAffected.length || b.cabinets - a.cabinets || b.occurrences - a.occurrences).slice(0, 500),
    cabinets: affected.slice(0, 2000).map(a => ({ id: a.cabinet_id.toLowerCase(), name: a.name, client: a.client, siteId: a.site_id.toLowerCase(), site: a.site, occurrences: Number(a.occurrences),
      firstSeen: a.first_seen.toISOString(), lastSeen: a.last_seen.toISOString(), state: a.state, agentVersion: a.agent_version })),
    byAgentVersion: [...versions.entries()].map(([version, v]) => ({ version, ...v })).filter(v => v.affected > 0).sort((a, b) => b.affected - a.affected),
    commonFactors,
  };
}
