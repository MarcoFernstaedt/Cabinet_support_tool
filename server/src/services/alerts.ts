// The alerts engine (docs/spec/05-server-spec.md "Alerts engine" and "Offline handling").
// Each new event is checked against the live rules; a match raises or updates the issue's alert,
// anything else becomes a minor unrecognized alert. Repeats fold into one active alert per
// cabinet; the same issue on several cabinets at one site within an hour is a site-wide pattern.
import { platformSettings } from "./settings.js";
import { createHash } from "node:crypto";
import type { AlertFilter, Event } from "../contracts.js";
import { audit, isUniqueViolation, lock, Pool, transaction, type Queryable, type Tx } from "../db/db.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";
import { Refused } from "./errors.js";
import { decide, ISSUE, liveRules, type LiveRule } from "./rules.js";
import { isBootRecord, recordBoot } from "./crashes.js";

export const SITE_PATTERN_WINDOW_MS = 60 * 60 * 1000;

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
  return normalizeSignature(e.kind === "error" && e.source ? `unrecognized:${e.source.log}|${e.source.source.toLowerCase()}|${e.source.eventId}` : `unrecognized:${e.kind}`);
}

/** The alerts table keeps a signature in 450 characters (an index key). A longer one is cut and ends in a hash of the whole, so two long ones stay apart. */
export const SIGNATURE_MAX = 450;
export function normalizeSignature(signature: string): string {
  if (signature.length <= SIGNATURE_MAX) return signature;
  return `${signature.slice(0, SIGNATURE_MAX - 17)}#${createHash("sha256").update(signature).digest("hex").slice(0, 16)}`;
}

function unrecognizedTitle(e: Pick<Event, "kind" | "source">): string {
  if (e.kind === "error" && e.source) return `Unrecognized ${e.source.level}: ${e.source.source || "(no source)"} event ${e.source.eventId} in ${e.source.log}`.slice(0, 300);
  return `Unrecognized ${e.kind.replace("_", " ")} event`;
}

/** Runs the engine over newly stored events, inside the transaction that stored them. */
export async function processEvents(c: Tx, cabinetId: string, events: readonly Event[]): Promise<Outcome[]> {
  if (events.length === 0) return [];
  const rules = await liveRules(c);
  const outcomes: Outcome[] = [];
  for (const e of events) outcomes.push(await processOne(c, cabinetId, e, rules));
  return outcomes;
}

async function processOne(c: Tx, cabinetId: string, e: Event, rules: readonly LiveRule[]): Promise<Outcome> {
  // A firewall change carrying a platform command's ID is an approved change, not an alert (its history arrives with milestone 5's writes).
  if (e.kind === "firewall_changed" && e.commandId) return { kind: "platform_change" };

  // The scanner watcher says when the scanner works again; its alert resolves itself.
  if (e.kind === "scanner" && e.device?.state === "recovered") {
    const r = await c.query<{ id: string }>(
      `DECLARE @o TABLE (id uniqueidentifier);
       UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME(), resolution = 'The scanner recovered on its own.'
         OUTPUT inserted.id INTO @o
        WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved';
       SELECT id FROM @o;`, [cabinetId, ISSUE.scanner]);
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
async function processService(c: Tx, cabinetId: string, e: Event): Promise<Outcome> {
  const service = e.detail?.fields?.service, change = e.detail?.fields?.change;
  if (!service || !SERVICE_NAME.test(service) || !change) return { kind: "stored" };
  if (change === "recovered") {
    const r = await c.query<{ id: string }>(
      `DECLARE @o TABLE (id uniqueidentifier);
       UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME(), resolution = 'The service is running again.'
         OUTPUT inserted.id INTO @o
        WHERE cabinet_id = $1 AND signature = $2 AND state <> 'resolved';
       SELECT id FROM @o;`, [cabinetId, normalizeSignature(`service:failing:${service}`)]);
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

type AlertWrite = { cabinetId: string; issueTypeId: string | null; severity: string; signature: string; title: string; seenAt: Date; ruleId: string | null; eventId: string | null };

// How a repeat folds into the active alert. Fixed statements: nothing here is built from input.
const FOLD_EVENT = `
  UPDATE alerts SET occurrences = occurrences + 1,
         first_seen = CASE WHEN $6 < first_seen THEN $6 ELSE first_seen END,
         last_seen = CASE WHEN $6 > last_seen THEN $6 ELSE last_seen END,
         last_event_id = COALESCE(CAST($8 AS uniqueidentifier), last_event_id),
         rule_id = COALESCE(CAST($7 AS uniqueidentifier), rule_id),
         -- A more serious symptom of the same issue makes the alert major; it never drops back on its own.
         severity = CASE WHEN $3 = 'major' OR severity = 'major' THEN 'major' ELSE 'minor' END
    OUTPUT inserted.id INTO @o
   WHERE cabinet_id = $1 AND signature = $4 AND state <> 'resolved'`;
const FOLD_SEEN = `
  UPDATE alerts SET last_seen = $6 OUTPUT inserted.id INTO @o WHERE cabinet_id = $1 AND signature = $4 AND state <> 'resolved'`;
const FOLD_REGROUP = `
  UPDATE alerts SET occurrences = occurrences + $9,
         first_seen = CASE WHEN $5 < first_seen THEN $5 ELSE first_seen END,
         last_seen = CASE WHEN $6 > last_seen THEN $6 ELSE last_seen END
    OUTPUT inserted.id INTO @o
   WHERE cabinet_id = $1 AND signature = $4 AND state <> 'resolved'`;
const INSERT_ALERT = (scope: string) => `
  INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, occurrences, first_seen, last_seen, rule_id, last_event_id, scope)
    OUTPUT inserted.id INTO @o
  VALUES ($1, CAST($2 AS uniqueidentifier), $3, $4, $10, $9, $5, $6, CAST($7 AS uniqueidentifier), CAST($8 AS uniqueidentifier), ${scope})`;
const SCOPE_OF_ISSUE = `COALESCE((SELECT scope FROM issue_types WHERE id = CAST($2 AS uniqueidentifier)), 'fleet')`;

/**
 * One active alert per cabinet and signature. SQL Server has no ON CONFLICT: the repeat is folded in with an UPDATE, and when
 * there is none the alert is inserted, all under a lock named for the cabinet and signature. Anything that still collides
 * with the unique index (a writer outside the lock) is retried once.
 */
export async function foldAlert(tx: Tx, a: { cabinetId: string; issueTypeId: string | null; severity: string; signature: string; title: string; firstSeen: Date; lastSeen: Date;
  ruleId: string | null; eventId: string | null; occurrences: number }, how: "event" | "seen" | "regroup"): Promise<{ id: string; created: boolean }> {
  const signature = normalizeSignature(a.signature);
  await lock(tx, `alert:${a.cabinetId}:${createHash("sha256").update(signature).digest("hex").slice(0, 32)}`);
  const params = [a.cabinetId, a.issueTypeId, a.severity, signature, a.firstSeen, a.lastSeen, a.ruleId, a.eventId, a.occurrences, a.title];
  const fold = how === "event" ? FOLD_EVENT : how === "seen" ? FOLD_SEEN : FOLD_REGROUP;
  const insert = INSERT_ALERT(how === "event" ? SCOPE_OF_ISSUE : "'fleet'");
  for (let attempt = 1; ; attempt++) {
    const updated = await tx.query<{ id: string }>(`DECLARE @o TABLE (id uniqueidentifier); ${fold}; SELECT id FROM @o;`, params);
    if (updated.rows[0]) return { id: updated.rows[0].id, created: false };
    try {
      const inserted = await tx.query<{ id: string }>(`DECLARE @o TABLE (id uniqueidentifier); ${insert}; SELECT id FROM @o;`, params);
      return { id: inserted.rows[0]!.id, created: true };
    } catch (e) {
      if (!isUniqueViolation(e) || attempt >= 2) throw e;
    }
  }
}

export async function upsertAlert(c: Queryable, a: AlertWrite): Promise<{ id: string; created: boolean }> {
  // An agent clock far in the future cannot push last_seen past now.
  const seen = new Date(Math.min(a.seenAt.getTime(), Date.now()));
  return inTransaction(c, tx => foldAlert(tx, { ...a, firstSeen: seen, lastSeen: seen, occurrences: 1 }, "event"));
}

/** Runs fn in the caller's transaction, or in a new one when the caller holds only the pool (the alert locks need a transaction). */
export function inTransaction<T>(db: Queryable, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db instanceof Pool ? db.transaction(fn) : fn(db as Tx);
}

/** Flags every active alert for this issue at the cabinet's site when two or more cabinets there saw it within the hour. */
async function flagSitePattern(c: Tx, cabinetId: string, signature: string): Promise<void> {
  const site = (await c.query<{ site_id: string }>("SELECT site_id FROM cabinets WHERE id = $1", [cabinetId])).rows[0];
  if (!site) return;
  await lock(c, `site-pattern:${site.site_id}:${createHash("sha256").update(signature).digest("hex").slice(0, 32)}`);
  await c.query(
    `WITH peers AS (
       SELECT a.id, a.cabinet_id FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id
        WHERE k.site_id = $1 AND a.signature = $2 AND a.state <> 'resolved' AND a.last_seen > DATEADD(second, -$3, SYSUTCDATETIME()))
     UPDATE alerts SET site_pattern = 1
      WHERE id IN (SELECT id FROM peers) AND site_pattern = 0 AND (SELECT COUNT(DISTINCT cabinet_id) FROM peers) >= 2`,
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
     WHERE ($1 = 'active' AND a.state <> 'resolved' OR a.state = $1)
       AND ($2 IS NULL OR a.severity = $2) AND ($3 IS NULL OR a.issue_type_id = CAST($3 AS uniqueidentifier))
       AND ($4 IS NULL OR (CASE WHEN a.issue_type_id IS NULL THEN 1 ELSE 0 END) = CAST($4 AS bit))
       AND ($5 IS NULL OR c.id = CAST($5 AS uniqueidentifier)) AND ($6 IS NULL OR s.id = CAST($6 AS uniqueidentifier)) AND ($7 IS NULL OR k.id = CAST($7 AS uniqueidentifier))
       AND ($8 IS NULL OR a.claimed_by = CAST($8 AS uniqueidentifier))
       AND (a.scope = 'fleet' OR $7 IS NOT NULL)
     ORDER BY CASE WHEN a.state = 'resolved' THEN 1 ELSE 0 END, CASE WHEN a.severity = 'major' THEN 0 ELSE 1 END, a.last_seen DESC
     OFFSET 0 ROWS FETCH NEXT 500 ROWS ONLY`,
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
    `SELECT COALESCE(SUM(CASE WHEN state = 'open' AND severity = 'major' THEN 1 ELSE 0 END), 0) AS open_major,
            COALESCE(SUM(CASE WHEN state <> 'resolved' THEN 1 ELSE 0 END), 0) AS active,
            COALESCE(SUM(CASE WHEN state <> 'resolved' AND issue_type_id IS NULL THEN 1 ELSE 0 END), 0) AS unrecognized FROM alerts WHERE scope = 'fleet'`)).rows[0]!;
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
  return (await db.query<EventRow>(`${EVENT_SELECT} WHERE e.cabinet_id = $1 ORDER BY e.occurred_at DESC OFFSET 0 ROWS FETCH NEXT $2 ROWS ONLY`, [cabinetId, limit])).rows.map(eventView);
}

/** How many other cabinets reported the same log, source and event ID in the last 30 days (the event detail view). */
export async function sameErrorElsewhere(db: Queryable, cabinetId: string, log: string, source: string, eventId: number) {
  const r = (await db.query<{ cabinets: string; events: string }>(
    `SELECT COUNT(DISTINCT CASE WHEN cabinet_id <> CAST($1 AS uniqueidentifier) THEN cabinet_id END) AS cabinets, COUNT(*) AS events FROM events e
      WHERE e.kind = 'error' AND e.occurred_at > DATEADD(day, -30, SYSUTCDATETIME()) AND JSON_VALUE(e.source, '$.log') COLLATE Latin1_General_100_BIN2 = $2
        AND JSON_VALUE(e.source, '$.source') = $3 AND JSON_VALUE(e.source, '$.eventId') = $4`, [cabinetId, log, source, String(eventId)])).rows[0]!;
  const rule = (await db.query<{ name: string }>(
    `SELECT TOP (1) t.name FROM events e JOIN symptom_rules r ON r.id = e.matched_rule JOIN issue_types t ON t.id = r.issue_type_id
      WHERE e.kind = 'error' AND e.occurred_at > DATEADD(day, -30, SYSUTCDATETIME())
        AND JSON_VALUE(e.source, '$.log') COLLATE Latin1_General_100_BIN2 = $1 AND JSON_VALUE(e.source, '$.source') = $2 AND JSON_VALUE(e.source, '$.eventId') = $3
      ORDER BY e.occurred_at DESC`, [log, source, String(eventId)])).rows[0];
  return { otherCabinets: Number(r.cabinets), events: Number(r.events), issueName: rule?.name ?? null, days: 30 };
}

// ---- Claim and resolve -----------------------------------------------------------------

/** Atomic: the first claim wins; a later one is told who has it. Refused claims are audited too. */
export async function claimAlert(pool: Pool, userId: string, alertId: string) {
  const outcome = await transaction(pool, async c => {
    const won = await c.query("UPDATE alerts SET state = 'claimed', claimed_by = $2, claimed_at = SYSUTCDATETIME() WHERE id = $1 AND state = 'open'", [alertId, userId]);
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
export async function resolveAlert(pool: Pool, user: { userId: string; role: string }, alertId: string, note: string | undefined) {
  return transaction(pool, async c => {
    // No note typed: a fix this person saved from this alert is what fixed it, so its text becomes the resolution.
    if (!note) {
      const fix = (await c.query<{ solution: string }>("SELECT TOP (1) solution FROM known_fixes WHERE alert_id = $1 AND created_by = $2 AND removed_at IS NULL ORDER BY created_at DESC", [alertId, user.userId])).rows[0];
      if (fix) note = [...fix.solution].map(ch => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("").trim().slice(0, 256) || undefined;
    }
    const r = await c.query(
      `UPDATE alerts SET state = 'resolved', resolved_by = $2, resolved_at = SYSUTCDATETIME(), resolution = $3
        WHERE id = $1 AND (state = 'claimed' AND claimed_by = $2 OR $4 = 1 AND state <> 'resolved')`,
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
export async function checkOffline(pool: Pool): Promise<{ raised: number; resolved: number }> {
  return transaction(pool, async c => {
    const days = await offlineAlertDays(c);
    const issue = (await c.query<{ name: string; severity: string }>("SELECT name, severity FROM issue_types WHERE id = $1", [ISSUE.offline])).rows[0]!;
    const due = (await c.query<{ id: string; since: Date }>(
      `SELECT k.id, COALESCE(k.last_heartbeat_at, k.created_at) AS since FROM cabinets k
        WHERE k.status = 'active' AND COALESCE(k.last_heartbeat_at, k.created_at) < DATEADD(day, -$1, SYSUTCDATETIME())`, [days])).rows;
    const now = new Date();
    let raised = 0;
    for (const k of due) {
      const a = await foldAlert(c, { cabinetId: k.id, issueTypeId: ISSUE.offline, severity: issue.severity, signature: `issue:${ISSUE.offline}`, title: issue.name,
        firstSeen: k.since, lastSeen: now, ruleId: null, eventId: null, occurrences: 1 }, "seen");
      if (a.created) raised++;
    }
    const resolved = await resolveOfflineFor(c, null);
    return { raised, resolved };
  });
}

/** Resolves offline alerts for cabinets heard from again (one cabinet, or all when null). */
export async function resolveOfflineFor(db: Queryable, cabinetId: string | null): Promise<number> {
  const r = await db.query(
    `UPDATE a SET state = 'resolved', resolved_at = SYSUTCDATETIME(), resolution = 'The cabinet is back online.'
       FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id WHERE a.issue_type_id = $1 AND a.state <> 'resolved'
        AND ($2 IS NULL OR a.cabinet_id = CAST($2 AS uniqueidentifier)) AND k.last_heartbeat_at > DATEADD(second, -$3, SYSUTCDATETIME())`,
    [ISSUE.offline, cabinetId, OFFLINE_AFTER_MS / 1000]);
  return r.rowCount ?? 0;
}

/** The offline filter: clients with offline cabinets, then one client's sites, then one site's cabinets. */
export async function offline(db: Queryable, f: { clientId?: string; siteId?: string }) {
  const days = await offlineAlertDays(db);
  const secs = OFFLINE_AFTER_MS / 1000;
  const offlineWhere = `k.status = 'active' AND (k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < DATEADD(second, -${secs}, SYSUTCDATETIME()))`;
  if (f.siteId) {
    const rows = (await db.query<{ id: string; name: string; last_heartbeat_at: Date | null; created_at: Date }>(
      `SELECT k.id, k.name, k.last_heartbeat_at, k.created_at FROM cabinets k WHERE k.site_id = $1 AND ${offlineWhere} ORDER BY k.last_heartbeat_at`, [f.siteId])).rows;
    return { level: "cabinets", thresholdDays: days, items: rows.map(r => ({ id: r.id, name: r.name, lastHeartbeatAt: r.last_heartbeat_at?.toISOString() ?? null,
      pastThreshold: Date.now() - (r.last_heartbeat_at ?? r.created_at).getTime() > days * 86_400_000 })) };
  }
  const [group, join, where, params] = f.clientId
    ? ["s.id, s.name", "", "WHERE s.client_id = $1", [f.clientId]]
    : ["c.id, c.name", "JOIN clients c ON c.id = s.client_id", "", []];
  const rows = (await db.query<{ id: string; name: string; offline: string; total: string }>(
    `SELECT ${group}, SUM(CASE WHEN ${offlineWhere} THEN 1 ELSE 0 END) AS offline, SUM(CASE WHEN k.status = 'active' THEN 1 ELSE 0 END) AS total
       FROM cabinets k JOIN sites s ON s.id = k.site_id ${join} ${where}
      GROUP BY ${group} HAVING SUM(CASE WHEN ${offlineWhere} THEN 1 ELSE 0 END) > 0 ORDER BY offline DESC, name`, params)).rows;
  return { level: f.clientId ? "sites" : "clients", thresholdDays: days, items: rows.map(r => ({ id: r.id, name: r.name, offline: Number(r.offline), cabinets: Number(r.total) })) };
}
