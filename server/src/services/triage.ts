// The triage queue (docs/spec/12-milestones-8-to-12.md "Triage queue"): what needs attention first across the fleet, grouped by likely cause.
// The groups are the fleet's active alerts by issue type (the cause the platform already names) and its unrecognized errors by log, source
// and event ID; each is ranked by a fixed, explained score, and says how many cabinets and sites it touches, whether it is new or rising, whether
// it sits at one site (look at the site before the cabinets), which runbook applies and what usually fixed it. Live from the alerts table
// (cheap, indexed); the new and rising marks come from last night's trend tables (error-trends.ts).
import type { Queryable } from "../db/db.js";
import type { TriageQuery } from "../contracts.js";
import { clean } from "../diagnose/cabinet-findings.js";
import { trendMarks, type Mark } from "./error-trends.js";
import { runbookSummaries } from "./runbooks.js";

export const SEVERITY_POINTS = { major: 100, minor: 30 } as const;

export interface ScoreInput {
  severity: "major" | "minor"; cabinets: number; unclaimed: number; mark: Mark; sitePatternAlerts: number;
  /** Hours the oldest unclaimed alert has waited. */
  oldestUnclaimedHours: number; unrecognized: boolean;
}

/** The score and the reasons for it, in words, so the order is never a mystery. Pure. */
export function triageScore(i: ScoreInput): { score: number; why: string[] } {
  const why: string[] = [];
  let score = SEVERITY_POINTS[i.severity];
  why.push(i.severity === "major" ? "major severity" : "minor severity");
  const cab = Math.min(Math.max(0, i.cabinets), 50) * 4;
  score += cab;
  if (i.cabinets > 1) why.push(`${i.cabinets} cabinets affected`);
  const unclaimed = Math.min(Math.max(0, i.unclaimed), 20) * 2;
  score += unclaimed;
  if (i.unclaimed > 0) why.push(`${i.unclaimed} not yet claimed`);
  if (i.mark === "new") { score += 25; why.push("first seen in the last day"); }
  if (i.mark === "rising") { score += 40; why.push("rising: more than double the week before"); }
  if (i.sitePatternAlerts > 0) { score += 20; why.push("seen at several cabinets of a site within an hour"); }
  const wait = Math.min(Math.max(0, i.oldestUnclaimedHours), 24) / 2;
  if (wait >= 1) { score += wait; why.push(`the oldest unclaimed one has waited ${Math.round(i.oldestUnclaimedHours)} hours`); }
  if (i.unrecognized) { score -= 10; why.push("not recognized yet: map it to an issue to classify every cabinet at once"); }
  return { score: Math.round(score), why };
}

interface GroupRow { issue_type_id: string; name: string; description: string; major: number; alerts: number; cabinets: number; sites: number; clients: number; unclaimed: number;
  first_seen: Date; last_seen: Date; site_pattern: number; oldest_unclaimed: Date | null }

const WINDOW_DEFAULT = 14;

export async function triage(db: Queryable, q: TriageQuery, now = Date.now()) {
  const days = q.days ? Number(q.days) : WINDOW_DEFAULT;
  const since = new Date(now - days * 86_400_000);
  const args = [q.clientId ?? null, q.siteId ?? null, since];
  const scope = `a.state <> 'resolved' AND a.scope = 'fleet' AND k.status = 'active' AND a.last_seen >= $3 AND ($1 IS NULL OR s.client_id = CAST($1 AS uniqueidentifier)) AND ($2 IS NULL OR s.id = CAST($2 AS uniqueidentifier))`;
  const from = "FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id JOIN sites s ON s.id = k.site_id";

  const groups = (await db.query<GroupRow>(
    `SELECT a.issue_type_id, MAX(t.name) AS name, MAX(t.description) AS description, MAX(CASE WHEN a.severity = 'major' THEN 1 ELSE 0 END) AS major, COUNT(*) AS alerts,
            COUNT(DISTINCT a.cabinet_id) AS cabinets, COUNT(DISTINCT s.id) AS sites, COUNT(DISTINCT s.client_id) AS clients,
            SUM(CASE WHEN a.state = 'open' THEN 1 ELSE 0 END) AS unclaimed, MIN(a.first_seen) AS first_seen, MAX(a.last_seen) AS last_seen,
            SUM(CASE WHEN a.site_pattern = 1 THEN 1 ELSE 0 END) AS site_pattern, MIN(CASE WHEN a.state = 'open' THEN a.first_seen END) AS oldest_unclaimed
       ${from} JOIN issue_types t ON t.id = a.issue_type_id WHERE ${scope} AND a.issue_type_id IS NOT NULL GROUP BY a.issue_type_id`, args)).rows;
  const ids = groups.map(g => g.issue_type_id);

  // Where each issue sits: the site with the most of its cabinets. Three or more cabinets, and most of them at one site, says "look at the site".
  const bySite = (await db.query<{ issue_type_id: string; site_id: string; site: string; n: number }>(
    `SELECT a.issue_type_id, s.id AS site_id, s.name AS site, COUNT(DISTINCT a.cabinet_id) AS n ${from}
      WHERE ${scope} AND a.issue_type_id IS NOT NULL GROUP BY a.issue_type_id, s.id, s.name`, args)).rows;
  const samples = ids.length === 0 ? [] : (await db.query<{ issue_type_id: string; cabinet_id: string; cabinet: string; site: string; rn: number }>(
    `SELECT x.issue_type_id, x.cabinet_id, x.cabinet, x.site, x.rn FROM (
        SELECT a.issue_type_id, k.id AS cabinet_id, k.name AS cabinet, s.name AS site, ROW_NUMBER() OVER (PARTITION BY a.issue_type_id ORDER BY a.last_seen DESC) AS rn
          ${from} WHERE ${scope} AND a.issue_type_id IS NOT NULL) x WHERE x.rn <= 5 ORDER BY x.issue_type_id, x.rn`, args)).rows;

  const marks = await trendMarks(db, ids, []);
  const books = await runbookSummaries(db, ids, []);
  const fixCounts = ids.length === 0 ? [] : (await db.query<{ issue_type_id: string; n: number }>(
    "SELECT issue_type_id, COUNT(*) AS n FROM known_fixes WHERE status = 'approved' AND removed_at IS NULL AND issue_type_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1)) GROUP BY issue_type_id", [ids])).rows;
  const usual = ids.length === 0 ? [] : (await db.query<{ issue_type_id: string; fix: string; n: number }>(
    `SELECT x.issue_type_id, x.fix, x.n FROM (
        SELECT issue_type_id, resolution_fix AS fix, COUNT(*) AS n, ROW_NUMBER() OVER (PARTITION BY issue_type_id ORDER BY COUNT(*) DESC, MAX(resolved_at) DESC) AS rn
          FROM alerts WHERE resolution_fix IS NOT NULL AND resolved_at > DATEADD(day, -365, SYSUTCDATETIME()) AND issue_type_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))
         GROUP BY issue_type_id, resolution_fix) x WHERE x.rn = 1`, [ids])).rows;

  const items = groups.map(g => {
    const mark = marks.issue.get(g.issue_type_id)?.mark ?? null;
    const top = bySite.filter(s => s.issue_type_id === g.issue_type_id).sort((a, b) => b.n - a.n)[0];
    const concentrated = top && Number(g.cabinets) >= 3 && top.n >= Math.ceil(Number(g.cabinets) * 0.6) ? { siteId: top.site_id, siteName: top.site, cabinets: Number(top.n) } : null;
    const { score, why } = triageScore({ severity: g.major ? "major" : "minor", cabinets: Number(g.cabinets), unclaimed: Number(g.unclaimed), mark, sitePatternAlerts: Number(g.site_pattern),
      oldestUnclaimedHours: g.oldest_unclaimed ? (now - g.oldest_unclaimed.getTime()) / 3_600_000 : 0, unrecognized: false });
    const book = books.issue.get(g.issue_type_id);
    const fix = usual.find(u => u.issue_type_id === g.issue_type_id);
    return { key: g.issue_type_id, kind: "issue" as const, issueTypeId: g.issue_type_id, title: g.name, cause: g.description, severity: g.major ? "major" as const : "minor" as const,
      cabinets: Number(g.cabinets), sites: Number(g.sites), clients: Number(g.clients), alerts: Number(g.alerts), unclaimed: Number(g.unclaimed),
      firstSeen: g.first_seen.toISOString(), lastSeen: g.last_seen.toISOString(), mark, score, why,
      concentratedAt: concentrated, runbook: book ? { title: book.title, steps: book.steps, builtIn: book.builtIn } : null,
      knownFixes: Number(fixCounts.find(f => f.issue_type_id === g.issue_type_id)?.n ?? 0), usualFix: fix ? { fix: fix.fix, count: Number(fix.n) } : null,
      sample: samples.filter(s => s.issue_type_id === g.issue_type_id).map(s => ({ id: s.cabinet_id, name: s.cabinet, site: s.site })) };
  }).sort((a, b) => b.score - a.score || b.cabinets - a.cabinets || (a.title < b.title ? -1 : 1));

  // Unrecognized errors: the active unrecognized alerts, grouped by where the error came from.
  const un = (await db.query<{ signature: string; alerts: number; cabinets: number; sites: number; unclaimed: number; last_seen: Date; first_seen: Date; last_event: string | null }>(
    `SELECT TOP (100) a.signature, COUNT(*) AS alerts, COUNT(DISTINCT a.cabinet_id) AS cabinets, COUNT(DISTINCT s.id) AS sites, SUM(CASE WHEN a.state = 'open' THEN 1 ELSE 0 END) AS unclaimed,
            MAX(a.last_seen) AS last_seen, MIN(a.first_seen) AS first_seen, CAST(MAX(CAST(a.last_event_id AS char(36))) AS uniqueidentifier) AS last_event
       ${from} WHERE ${scope} AND a.issue_type_id IS NULL AND a.signature LIKE 'unrecognized:%' GROUP BY a.signature ORDER BY COUNT(DISTINCT a.cabinet_id) DESC, MAX(a.last_seen) DESC`, args)).rows;
  const events = un.length === 0 ? [] : (await db.query<{ event_id: string; source: { log: string; source: string; eventId: number; level: string } | null; message: string | null }>(
    "SELECT event_id, source, JSON_VALUE(detail, '$.message') AS message FROM events WHERE event_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))", [un.map(u => u.last_event).filter(Boolean)])).rows;
  const parsed = un.map(u => {
    const ev = events.find(e => e.event_id === u.last_event);
    // The signature is "unrecognized:<log>|<source>|<event id>" (alerts.ts); read by splitting, never by a pattern.
    const body = u.signature.slice("unrecognized:".length), first = body.indexOf("|"), last = body.lastIndexOf("|");
    const log = ev?.source?.log ?? (first > 0 ? body.slice(0, first) : ""), source = ev?.source?.source ?? (first >= 0 && last > first ? body.slice(first + 1, last) : "");
    const eventId = ev?.source?.eventId ?? Number(last >= 0 ? body.slice(last + 1) : NaN);
    return { u, log, source, eventId, message: ev?.message ?? null, level: ev?.source?.level ?? null };
  }).filter(p => p.log && Number.isInteger(p.eventId));
  const errorMarks = await trendMarks(db, [], parsed.map(p => ({ log: p.log, source: p.source, eventId: p.eventId })));
  const unrecognized = parsed.map(p => {
    const mark = errorMarks.error.get(`${p.log}|${p.source}|${p.eventId}`)?.mark ?? null;
    const { score, why } = triageScore({ severity: "minor", cabinets: Number(p.u.cabinets), unclaimed: Number(p.u.unclaimed), mark, sitePatternAlerts: 0, oldestUnclaimedHours: 0, unrecognized: true });
    return { key: p.u.signature, kind: "unrecognized" as const, log: clean(p.log, 128), source: clean(p.source, 120), eventId: p.eventId, level: p.level, cabinets: Number(p.u.cabinets), sites: Number(p.u.sites),
      alerts: Number(p.u.alerts), unclaimed: Number(p.u.unclaimed), firstSeen: p.u.first_seen.toISOString(), lastSeen: p.u.last_seen.toISOString(), mark, score, why,
      sample: p.message ? clean(p.message, 300) : null, lastEventId: p.u.last_event };
  }).sort((a, b) => b.cabinets - a.cabinets || b.score - a.score);

  const cabinetCount = Number((await db.query<{ n: number }>(`SELECT COUNT(DISTINCT a.cabinet_id) AS n ${from} WHERE ${scope}`, args)).rows[0]!.n);
  const totals = { groups: items.length, cabinets: cabinetCount, alerts: items.reduce((n, i) => n + i.alerts, 0),
    unclaimedMajor: items.filter(i => i.severity === "major").reduce((n, i) => n + i.unclaimed, 0), unrecognized: unrecognized.length };
  return { generatedAt: new Date(now).toISOString(), days, trendsAsOf: marks.asOf ?? errorMarks.asOf, totals, items, unrecognized };
}
