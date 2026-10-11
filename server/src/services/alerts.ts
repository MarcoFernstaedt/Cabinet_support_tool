// The alerts engine (docs/spec/05-server-spec.md "Alerts engine" and "Offline handling").
// Each new event is checked against the live rules; a match raises or updates the issue's alert,
// anything else becomes a minor unrecognized alert. Repeats fold into one active alert per
// cabinet; the same issue on several cabinets at one site within an hour is a site-wide pattern.
import { platformSettings } from "./settings.js";
import type pg from "pg";
import type { AlertFilter, Event } from "../contracts.js";
import { audit, transaction, type Queryable } from "../db/db.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";
import { Refused } from "./errors.js";
import { decide, ISSUE, liveRules, type LiveRule } from "./rules.js";
import { isBootRecord, recordBoot } from "./crashes.js";

export const SITE_PATTERN_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_OFFLINE_ALERT_DAYS = 5;

/** What one event led to, for tests and logs. */
export type Outcome =
  | { kind: "issue"; alertId: string; issueTypeId: string; created: boolean }
  | { kind: "unrecognized"; alertId: string; created: boolean }
  | { kind: "suppressed"; ruleId: string }
  | { kind: "resolved"; alertIds: string[] }
  | { kind: "platform_change" }
  /** A warning (or lower) that matches no rule: kept on its cabinet, where it can be mapped, but not an alert. */
  | { kind: "stored" };

/** The signature that folds repeats together. An unrecognized error is known by where it came from. */
export function unrecognizedSignature(e: Pick<Event, "kind" | "source">): string {
  return e.kind === "error" && e.source ? `unrecognized:${e.source.log}|${e.source.source.toLowerCase()}|${e.source.eventId}` : `unrecognized:${e.kind}`;
}

function unrecognizedTitle(e: Pick<Event, "kind" | "source">): string {
  if (e.kind === "error" && e.source) return `Unrecognized ${e.source.level}: ${e.source.source || "(no source)"} event ${e.source.eventId} in ${e.source.log}`.slice(0, 300);
  return `Unrecognized ${e.kind.replace("_", " ")} event`;
}

/** Runs the engine over newly stored events, inside the transaction that stored them. */
export async function processEvents(c: pg.PoolClient, cabinetId: string, events: readonly Event[]): Promise<Outcome[]> {
  if (events.length === 0) return [];
  const rules = await liveRules(c);
  const outcomes: Outcome[] = [];
  for (const e of events) outcomes.push(await processOne(c, cabinetId, e, rules));
  return outcomes;
}

async function processOne(c: pg.PoolClient, cabinetId: string, e: Event, rules: readonly LiveRule[]): Promise<Outcome> {
  // A firewall change carrying a platform command's ID is an approved change, not an alert (its history arrives with milestone 5's writes).
  if (e.kind === "firewall_changed" && e.commandId) return { kind: "platform_change" };

  // The scanner watcher says when the scanner works again; its alert resolves itself.
  if (e.kind === "scanner" && e.device?.state === "recovered") {
    const r = await c.query<{ id: string }>(
      `UPDATE alerts SET state = 'resolved', resolved_at = now(), resolution = 'The scanner recovered on its own.'
        WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved' RETURNING id`, [cabinetId, ISSUE.scanner]);
    await c.query("UPDATE events SET alert_id = $2 WHERE event_id = $1", [e.eventId, r.rows[0]?.id ?? null]);
    return { kind: "resolved", alertIds: r.rows.map(x => x.id) };
  }

  if (e.kind === "service") return processService(c, cabinetId, e);
  // A system change is kept for the crash timeline and the fleet comparison; it never raises an alert. Windows starting is a boot.
  if (e.kind === "change") {
    if (e.source && isBootRecord(e.source.source, e.source.eventId)) await recordBoot(c, cabinetId, new Date(e.occurredAt), "event");
    return { kind: "stored" };
  }

  const rule = decide(rules, e);
  if (rule?.kind === "suppress") {
    await c.query("UPDATE events SET matched_rule = $2 WHERE event_id = $1", [e.eventId, rule.id]);
    await c.query("UPDATE symptom_rules SET matched_count = matched_count + 1 WHERE id = $1", [rule.id]);
    return { kind: "suppressed", ruleId: rule.id };
  }

  // Warnings are collected because they are often the first sign of a failing drive or controller, but only one a rule
  // recognizes raises an alert; the rest stay on the cabinet's event list, where anyone can map them to an issue.
  if (!rule && e.kind === "error" && e.source && e.source.level !== "error" && e.source.level !== "critical") return { kind: "stored" };

  let issue: { id: string; name: string; severity: string } | undefined;
  if (rule) issue = (await c.query<{ id: string; name: string; severity: string }>("SELECT id, name, severity FROM issue_types WHERE id = $1", [rule.issueTypeId])).rows[0];
  const signature = issue ? `issue:${issue.id}` : unrecognizedSignature(e);
  const a = await upsertAlert(c, {
    // The rule's own severity overrides the issue type's: an early sign of an issue can be minor, a real failure major.
    cabinetId, issueTypeId: issue?.id ?? null, severity: (issue && rule?.severity) || issue?.severity || "minor", signature, title: issue?.name ?? unrecognizedTitle(e),
    seenAt: new Date(e.occurredAt), ruleId: rule?.id ?? null, eventId: e.eventId,
  });
  await c.query("UPDATE events SET alert_id = $2, matched_rule = $3 WHERE event_id = $1", [e.eventId, a.id, rule?.id ?? null]);
  if (rule) await c.query("UPDATE symptom_rules SET matched_count = matched_count + 1 WHERE id = $1", [rule.id]);
  if (issue) await flagSitePattern(c, cabinetId, signature);
  return issue ? { kind: "issue", alertId: a.id, issueTypeId: issue.id, created: a.created } : { kind: "unrecognized", alertId: a.id, created: a.created };
}

const SERVICE_NAME = /^[A-Za-z0-9_.$-](?:[A-Za-z0-9_.$ -]{0,78}[A-Za-z0-9_.$-])?$/;

/**
 * Events from the broker's service watcher (docs/spec/12-milestones-8-to-12.md): an automatic restart opens a minor
 * alert per service, 3 failed restarts a major one, recovery resolves it, and a missing or disabled watched service
 * a minor one. Each service has its own alert, so a repeat offender shows its count.
 */
async function processService(c: pg.PoolClient, cabinetId: string, e: Event): Promise<Outcome> {
  const service = e.detail?.fields?.service, change = e.detail?.fields?.change;
  if (!service || !SERVICE_NAME.test(service) || !change) return { kind: "stored" };
  if (change === "recovered") {
    const r = await c.query<{ id: string }>(
      `UPDATE alerts SET state = 'resolved', resolved_at = now(), resolution = 'The service is running again.'
        WHERE cabinet_id = $1 AND signature = $2 AND state <> 'resolved' RETURNING id`, [cabinetId, `service:failing:${service}`]);
    await c.query("UPDATE events SET alert_id = $2 WHERE event_id = $1", [e.eventId, r.rows[0]?.id ?? null]);
    return { kind: "resolved", alertIds: r.rows.map(x => x.id) };
  }
  const kind = change === "restarted" ? { issue: ISSUE.serviceRestarted, key: "restarted" } : change === "failing" ? { issue: ISSUE.serviceFailing, key: "failing" }
    : change === "missing" || change === "disabled" ? { issue: ISSUE.serviceWatch, key: "watch" } : null;
  if (!kind) return { kind: "stored" };
  const issue = (await c.query<{ id: string; name: string; severity: string }>("SELECT id, name, severity FROM issue_types WHERE id = $1", [kind.issue])).rows[0]!;
  const a = await upsertAlert(c, { cabinetId, issueTypeId: issue.id, severity: issue.severity, signature: `service:${kind.key}:${service}`, title: `${issue.name}: ${service}`,
    seenAt: new Date(e.occurredAt), ruleId: null, eventId: e.eventId });
  await c.query("UPDATE events SET alert_id = $2 WHERE event_id = $1", [e.eventId, a.id]);
  return { kind: "issue", alertId: a.id, issueTypeId: issue.id, created: a.created };
}

export async function upsertAlert(c: Queryable, a: { cabinetId: string; issueTypeId: string | null; severity: string; signature: string; title: string; seenAt: Date; ruleId: string | null; eventId: string | null }) {
  // An agent clock far in the future cannot push last_seen past now.
  const seen = new Date(Math.min(a.seenAt.getTime(), Date.now()));
  const r = (await c.query<{ id: string; created: boolean }>(
    `INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen, rule_id, last_event_id, scope)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, COALESCE((SELECT scope FROM issue_types WHERE id = $2::uuid), 'fleet'))
     ON CONFLICT (cabinet_id, signature) WHERE state <> 'resolved' DO UPDATE
       SET occurrences = alerts.occurrences + 1, first_seen = LEAST(alerts.first_seen, EXCLUDED.first_seen),
           last_seen = GREATEST(alerts.last_seen, EXCLUDED.last_seen), last_event_id = COALESCE(EXCLUDED.last_event_id, alerts.last_event_id),
           rule_id = COALESCE(EXCLUDED.rule_id, alerts.rule_id),
           -- A more serious symptom of the same issue makes the alert major; it never drops back on its own.
           severity = CASE WHEN EXCLUDED.severity = 'major' OR alerts.severity = 'major' THEN 'major' ELSE 'minor' END
     RETURNING id, (xmax = 0) AS created`,
    [a.cabinetId, a.issueTypeId, a.severity, a.signature, a.title, seen, a.ruleId, a.eventId])).rows[0]!;
  return r;
}

/** Flags every active alert for this issue at the cabinet's site when two or more cabinets there saw it within the hour. */
async function flagSitePattern(c: pg.PoolClient, cabinetId: string, signature: string): Promise<void> {
  const site = (await c.query<{ site_id: string }>("SELECT site_id FROM cabinets WHERE id = $1", [cabinetId])).rows[0];
  if (!site) return;
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`site-pattern:${site.site_id}:${signature}`]);
  await c.query(
    `WITH peers AS (
       SELECT a.id, a.cabinet_id FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id
        WHERE k.site_id = $1 AND a.signature = $2 AND a.state <> 'resolved' AND a.last_seen > now() - make_interval(secs => $3))
     UPDATE alerts SET site_pattern = true
      WHERE id IN (SELECT id FROM peers) AND NOT site_pattern AND (SELECT count(DISTINCT cabinet_id) FROM peers) >= 2`,
    [site.site_id, signature, SITE_PATTERN_WINDOW_MS / 1000]);
}

// ---- Listing ---------------------------------------------------------------------------

const ALERT_SELECT = `
  SELECT a.id, a.cabinet_id, k.name AS cabinet_name, s.id AS site_id, s.name AS site_name, c.id AS client_id, c.name AS client_name,
         a.scope, a.issue_type_id, a.severity, a.title, a.state, a.occurrences, a.first_seen, a.last_seen, a.site_pattern, a.rule_id,
         a.last_event_id, a.claimed_by, cu.name AS claimed_by_name, a.claimed_at, a.resolved_by, ru.name AS resolved_by_name, a.resolved_at, a.resolution
    FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
    LEFT JOIN users cu ON cu.id = a.claimed_by LEFT JOIN users ru ON ru.id = a.resolved_by`;

interface AlertRow {
  id: string; cabinet_id: string; cabinet_name: string; site_id: string; site_name: string; client_id: string; client_name: string;
  issue_type_id: string | null; severity: string; title: string; state: string; occurrences: number; first_seen: Date; last_seen: Date;
  scope: string; site_pattern: boolean; rule_id: string | null; last_event_id: string | null; claimed_by: string | null; claimed_by_name: string | null;
  claimed_at: Date | null; resolved_by: string | null; resolved_by_name: string | null; resolved_at: Date | null; resolution: string | null;
}

export const alertView = (r: AlertRow) => ({
  id: r.id, scope: r.scope, cabinet: { id: r.cabinet_id, name: r.cabinet_name }, site: { id: r.site_id, name: r.site_name }, client: { id: r.client_id, name: r.client_name },
  issueTypeId: r.issue_type_id, unrecognized: r.issue_type_id === null, severity: r.severity, title: r.title, state: r.state, occurrences: r.occurrences,
  firstSeen: r.first_seen.toISOString(), lastSeen: r.last_seen.toISOString(), sitePattern: r.site_pattern, ruleId: r.rule_id, lastEventId: r.last_event_id,
  claimedBy: r.claimed_by ? { id: r.claimed_by, name: r.claimed_by_name } : null, claimedAt: r.claimed_at?.toISOString() ?? null,
  resolvedBy: r.resolved_by ? { id: r.resolved_by, name: r.resolved_by_name } : null, resolvedAt: r.resolved_at?.toISOString() ?? null, resolution: r.resolution,
});

export async function listAlerts(db: Queryable, f: AlertFilter, me: string) {
  const state = f.state ?? "active";
  const rows = (await db.query<AlertRow>(`${ALERT_SELECT}
     WHERE ($1::text = 'active' AND a.state <> 'resolved' OR a.state = $1)
       AND ($2::text IS NULL OR a.severity = $2) AND ($3::uuid IS NULL OR a.issue_type_id = $3)
       AND ($4::boolean IS NULL OR (a.issue_type_id IS NULL) = $4)
       AND ($5::uuid IS NULL OR c.id = $5) AND ($6::uuid IS NULL OR s.id = $6) AND ($7::uuid IS NULL OR k.id = $7)
       AND ($8::uuid IS NULL OR a.claimed_by = $8)
       AND (a.scope = 'fleet' OR $7::uuid IS NOT NULL)
     ORDER BY (a.state = 'resolved'), (a.severity = 'major') DESC, a.last_seen DESC LIMIT 500`,
    [state, f.severity ?? null, f.issueTypeId ?? null, f.unrecognized === undefined ? null : f.unrecognized === "true",
     f.clientId ?? null, f.siteId ?? null, f.cabinetId ?? null, f.claimedBy === "me" ? me : f.claimedBy ?? null])).rows;
  return rows.map(alertView);
}

export async function alertById(db: Queryable, id: string) {
  const r = (await db.query<AlertRow>(`${ALERT_SELECT} WHERE a.id = $1`, [id])).rows[0];
  return r ? alertView(r) : null;
}

/** The badge count: open (unclaimed) major alerts. */
export async function summary(db: Queryable) {
  const r = (await db.query<{ open_major: string; active: string; unrecognized: string }>(
    `SELECT count(*) FILTER (WHERE state = 'open' AND severity = 'major') AS open_major,
            count(*) FILTER (WHERE state <> 'resolved') AS active,
            count(*) FILTER (WHERE state <> 'resolved' AND issue_type_id IS NULL) AS unrecognized FROM alerts WHERE scope = 'fleet'`)).rows[0]!;
  return { openMajor: Number(r.open_major), active: Number(r.active), unrecognized: Number(r.unrecognized) };
}

type EventRow = { event_id: string; cabinet_id: string; kind: string; occurred_at: Date; received_at: Date; source: Event["source"] | null;
  detail: Event["detail"] | null; device: Event["device"] | null; severity_hint: string | null; alert_id: string | null; matched_rule: string | null; issue_name: string | null };

const EVENT_SELECT = `SELECT e.event_id, e.cabinet_id, e.kind, e.occurred_at, e.received_at, e.source, e.detail, e.device, e.severity_hint, e.alert_id, e.matched_rule, t.name AS issue_name
  FROM events e LEFT JOIN symptom_rules r ON r.id = e.matched_rule LEFT JOIN issue_types t ON t.id = r.issue_type_id`;

const eventView = (e: EventRow) => ({ eventId: e.event_id, cabinetId: e.cabinet_id, kind: e.kind, occurredAt: e.occurred_at.toISOString(), receivedAt: e.received_at.toISOString(),
  source: e.source, detail: e.detail, device: e.device, severityHint: e.severity_hint, alertId: e.alert_id, ruleId: e.matched_rule, issueName: e.issue_name });

/** One stored event with its alert and rule, for the detail view and Map to issue. */
export async function eventById(db: Queryable, eventId: string) {
  const e = (await db.query<EventRow>(`${EVENT_SELECT} WHERE e.event_id = $1`, [eventId])).rows[0];
  return e ? eventView(e) : null;
}

/** A cabinet's latest events, newest first, in one query. */
export async function cabinetEvents(db: Queryable, cabinetId: string, limit = 100) {
  return (await db.query<EventRow>(`${EVENT_SELECT} WHERE e.cabinet_id = $1 ORDER BY e.occurred_at DESC LIMIT $2`, [cabinetId, limit])).rows.map(eventView);
}

/** How many other cabinets reported the same log, source and event ID in the last 30 days (the event detail view). */
export async function sameErrorElsewhere(db: Queryable, cabinetId: string, log: string, source: string, eventId: number) {
  const r = (await db.query<{ cabinets: string; events: string }>(
    `SELECT count(DISTINCT cabinet_id) FILTER (WHERE cabinet_id <> $1) AS cabinets, count(*) AS events FROM events e
      WHERE e.kind = 'error' AND e.occurred_at > now() - interval '30 days' AND e.source->>'log' = $2
        AND lower(e.source->>'source') = lower($3) AND e.source->>'eventId' = $4`, [cabinetId, log, source, String(eventId)])).rows[0]!;
  const rule = (await db.query<{ name: string }>(
    `SELECT t.name FROM events e JOIN symptom_rules r ON r.id = e.matched_rule JOIN issue_types t ON t.id = r.issue_type_id
      WHERE e.kind = 'error' AND e.occurred_at > now() - interval '30 days'
        AND e.source->>'log' = $1 AND lower(e.source->>'source') = lower($2) AND e.source->>'eventId' = $3
      ORDER BY e.occurred_at DESC LIMIT 1`, [log, source, String(eventId)])).rows[0];
  return { otherCabinets: Number(r.cabinets), events: Number(r.events), issueName: rule?.name ?? null, days: 30 };
}

// ---- Claim and resolve -----------------------------------------------------------------

/** Atomic: the first claim wins; a later one is told who has it. Refused claims are audited too. */
export async function claimAlert(pool: pg.Pool, userId: string, alertId: string) {
  const outcome = await transaction(pool, async c => {
    const won = await c.query("UPDATE alerts SET state = 'claimed', claimed_by = $2, claimed_at = now() WHERE id = $1 AND state = 'open'", [alertId, userId]);
    const now = await alertById(c, alertId);
    if (!now) return null;
    await audit(c, { actorKind: "user", actorId: userId, action: "alert.claim", targetKind: "alert", targetId: alertId,
      outcome: won.rowCount === 1 ? "succeeded" : "refused", ...(won.rowCount === 1 ? {} : { details: { state: now.state, claimedBy: now.claimedBy?.id ?? null } }) });
    return { won: won.rowCount === 1, alert: now };
  });
  if (!outcome) throw new Refused("not_found", 404, "no such alert");
  if (outcome.won) return outcome.alert;
  if (outcome.alert.state === "claimed") throw new Refused("already_claimed", 409, "someone else claimed it first", { claimedBy: outcome.alert.claimedBy });
  throw new Refused("already_resolved", 409, "the alert is resolved");
}

/** The person who claimed an alert resolves it; an Admin may resolve any active alert. */
export async function resolveAlert(pool: pg.Pool, user: { userId: string; role: string }, alertId: string, note: string | undefined) {
  return transaction(pool, async c => {
    // No note typed: a fix this person saved from this alert is what fixed it, so its text becomes the resolution.
    if (!note) {
      const fix = (await c.query<{ solution: string }>("SELECT solution FROM known_fixes WHERE alert_id = $1 AND created_by = $2 AND removed_at IS NULL ORDER BY created_at DESC LIMIT 1", [alertId, user.userId])).rows[0];
      if (fix) note = [...fix.solution].map(ch => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("").trim().slice(0, 256) || undefined;
    }
    const r = await c.query(
      `UPDATE alerts SET state = 'resolved', resolved_by = $2, resolved_at = now(), resolution = $3
        WHERE id = $1 AND (state = 'claimed' AND claimed_by = $2 OR $4 AND state <> 'resolved')`,
      [alertId, user.userId, note ?? null, user.role === "admin"]);
    if (r.rowCount !== 1) {
      const now = await alertById(c, alertId);
      if (!now) throw new Refused("not_found", 404, "no such alert");
      throw new Refused(now.state === "resolved" ? "already_resolved" : "claim_first", 409, "only the person who claimed it can resolve it",
        now.claimedBy ? { claimedBy: now.claimedBy } : undefined);
    }
    await audit(c, { actorKind: "user", actorId: user.userId, action: "alert.resolve", targetKind: "alert", targetId: alertId, outcome: "succeeded",
      details: { note: note ?? null } });
    return (await alertById(c, alertId))!;
  });
}

// ---- Offline ---------------------------------------------------------------------------

export async function offlineAlertDays(db: Queryable): Promise<number> {
  return (await platformSettings(db)).offlineAlertDays;
}

/**
 * The threshold job: a cabinet offline longer than the setting gets a real alert; one that is back
 * resolves its own. Runs every minute, and the resolve half also runs on each heartbeat.
 */
export async function checkOffline(pool: pg.Pool): Promise<{ raised: number; resolved: number }> {
  return transaction(pool, async c => {
    const days = await offlineAlertDays(c);
    const issue = (await c.query<{ name: string; severity: string }>("SELECT name, severity FROM issue_types WHERE id = $1", [ISSUE.offline])).rows[0]!;
    const raised = await c.query(
      `INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen)
       SELECT k.id, $1, $2, $3, $4, COALESCE(k.last_heartbeat_at, k.created_at), now() FROM cabinets k
        WHERE k.status = 'active' AND COALESCE(k.last_heartbeat_at, k.created_at) < now() - make_interval(days => $5)
       ON CONFLICT (cabinet_id, signature) WHERE state <> 'resolved' DO UPDATE SET last_seen = now()
       RETURNING (xmax = 0) AS created`,
      [ISSUE.offline, issue.severity, `issue:${ISSUE.offline}`, issue.name, days]);
    const resolved = await resolveOfflineFor(c, null);
    return { raised: raised.rows.filter(r => r.created).length, resolved };
  });
}

/** Resolves offline alerts for cabinets heard from again (one cabinet, or all when null). */
export async function resolveOfflineFor(db: Queryable, cabinetId: string | null): Promise<number> {
  const r = await db.query(
    `UPDATE alerts a SET state = 'resolved', resolved_at = now(), resolution = 'The cabinet is back online.'
       FROM cabinets k WHERE k.id = a.cabinet_id AND a.issue_type_id = $1 AND a.state <> 'resolved'
        AND ($2::uuid IS NULL OR a.cabinet_id = $2) AND k.last_heartbeat_at > now() - make_interval(secs => $3)`,
    [ISSUE.offline, cabinetId, OFFLINE_AFTER_MS / 1000]);
  return r.rowCount ?? 0;
}

/** The offline filter: clients with offline cabinets, then one client's sites, then one site's cabinets. */
export async function offline(db: Queryable, f: { clientId?: string; siteId?: string }) {
  const days = await offlineAlertDays(db);
  const secs = OFFLINE_AFTER_MS / 1000;
  const offlineWhere = `k.status = 'active' AND (k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < now() - make_interval(secs => ${secs}))`;
  if (f.siteId) {
    const rows = (await db.query<{ id: string; name: string; last_heartbeat_at: Date | null; created_at: Date }>(
      `SELECT k.id, k.name, k.last_heartbeat_at, k.created_at FROM cabinets k WHERE k.site_id = $1 AND ${offlineWhere} ORDER BY k.last_heartbeat_at NULLS FIRST`, [f.siteId])).rows;
    return { level: "cabinets", thresholdDays: days, items: rows.map(r => ({ id: r.id, name: r.name, lastHeartbeatAt: r.last_heartbeat_at?.toISOString() ?? null,
      pastThreshold: Date.now() - (r.last_heartbeat_at ?? r.created_at).getTime() > days * 86_400_000 })) };
  }
  const [group, join, where, params] = f.clientId
    ? ["s.id, s.name", "", "WHERE s.client_id = $1", [f.clientId]]
    : ["c.id, c.name", "JOIN clients c ON c.id = s.client_id", "", []];
  const rows = (await db.query<{ id: string; name: string; offline: string; total: string }>(
    `SELECT ${group}, count(*) FILTER (WHERE ${offlineWhere}) AS offline, count(*) FILTER (WHERE k.status = 'active') AS total
       FROM cabinets k JOIN sites s ON s.id = k.site_id ${join} ${where}
      GROUP BY ${group} HAVING count(*) FILTER (WHERE ${offlineWhere}) > 0 ORDER BY offline DESC, name`, params)).rows;
  return { level: f.clientId ? "sites" : "clients", thresholdDays: days, items: rows.map(r => ({ id: r.id, name: r.name, offline: Number(r.offline), cabinets: Number(r.total) })) };
}
