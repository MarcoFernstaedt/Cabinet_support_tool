// Agent-originated events: stored, then run through the alerts engine in the same transaction,
// so an event is never stored without its alert or alerted without being stored.
import { CRASH_ISSUES, syncCrashIncident } from "./crash-incidents.js";
import { checkFleetSoon } from "./fleet-patterns.js";
import { raiseSecurityAlert } from "./security.js";
import type { Event, EventBatch } from "../contracts.js";
import { audit, isUniqueViolation, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { checkRetentionCutoff, inBatches, RETENTION_BATCH, type BatchOptions } from "../db/batches.js";
import { upsertSetting } from "./settings.js";
import { crashArgs, crashPredicate } from "./crashes.js";
import { processBatch, type Outcome } from "./alerts.js";
import { Refused } from "./errors.js";
import { countRuleHits, RULES_STAMP_SQL } from "./rules.js";

/** Which checks in an agent's security event raise which security alert (a safety-net rollback is reported, but is not one of them). */
const AGENT_SECURITY: Record<string, "agent_self_check" | "package_refused" | "signature_failure"> = {
  self_check: "agent_self_check", package_refused: "package_refused", hash_mismatch: "package_refused", publisher_not_trusted: "package_refused",
  signature_invalid: "signature_failure", signature: "signature_failure",
};
const AGENT_SECURITY_TITLE = {
  agent_self_check: "A cabinet agent failed its self-check", package_refused: "A cabinet refused a package", signature_failure: "A cabinet reported a signature failure",
} as const;

const FIREWALL_WRITES = ["firewall.setProfile", "firewall.setRule", "firewall.restore"];

/**
 * Stores a batch; a repeated eventId (in the batch, or stored before) is ignored, so agent retries never duplicate or count twice. The batch is
 * inserted with one statement, which also reads the rules stamp, and judged by the set-based engine (alerts.ts processBatch) in the same
 * transaction. How often each rule matched is counted only once the transaction committed (a deadlock victim runs again).
 */
export async function storeEvents(pool: Pool, cabinetId: string, batch: EventBatch): Promise<{ stored: number; outcomes: Outcome[] }> {
  // The first of two events with one id wins, as it would have one by one. Times are normalized to what the column keeps.
  const unique = new Map<string, Event>();
  for (const e of batch.events) {
    if (Number.isNaN(new Date(e.occurredAt).getTime())) throw new Refused("invalid_request", 400, "an event's time is not a real date");
    if (!unique.has(e.eventId.toLowerCase())) unique.set(e.eventId.toLowerCase(), e);
  }
  const result = await transaction(pool, async c => {
    let events = [...unique.values()];
    // A firewall change claims a platform command: it must be a firewall write this cabinet was sent; otherwise it is unexplained.
    const claimed = events.filter(e => e.kind === "firewall_changed" && e.commandId).map(e => e.commandId!.toLowerCase());
    if (claimed.length > 0) {
      const ok = new Set((await c.query<{ id: string }>(
        `SELECT id FROM commands WHERE cabinet_id = $1 AND id IN (SELECT TRY_CAST(value AS uniqueidentifier) FROM OPENJSON($2))
            AND operation IN (SELECT value FROM OPENJSON($3))`, [cabinetId, JSON.stringify(claimed), JSON.stringify(FIREWALL_WRITES)])).rows.map(r => r.id));
      events = events.map(e => {
        if (e.kind !== "firewall_changed" || !e.commandId || ok.has(e.commandId.toLowerCase())) return e;
        const { commandId: _ignored, ...rest } = e;
        return rest;
      });
    }
    // An absent value is left out of the JSON (OPENJSON reads it as NULL).
    const rows = events.map(e => ({ eventId: e.eventId, kind: e.kind, occurredAt: new Date(e.occurredAt).toISOString(), source: e.source, commandId: e.commandId,
      severityHint: e.severityHint, detail: e.detail, device: e.device }));
    // No ON CONFLICT on SQL Server: insert the ones not already there (locked while checking). A race to the primary key with another
    // batch carrying the same event is "already there": the statement is run again and the other batch's row is skipped.
    let inserted: { event_id: string; version: string | null }[] = [];
    for (let attempt = 1; ; attempt++) {
      try { inserted = (await c.query<{ event_id: string; version: string | null }>(INSERT_EVENTS, [cabinetId, safeJson(rows)])).rows; break; }
      catch (err) { if (!isUniqueViolation(err) || attempt >= 2) throw err; }
    }
    const fresh = new Set(inserted.map(r => r.event_id.toLowerCase()));
    const stored = events.filter(e => fresh.has(e.eventId.toLowerCase()));
    for (const e of stored) {
      // An agent's own security report: a failed self-check, a refused package or a signature failure goes to Admins.
      const check = e.kind === "security" ? e.detail?.fields?.check : undefined;
      const kind = check ? AGENT_SECURITY[check] : undefined;
      if (kind)
        await raiseSecurityAlert(c, { kind, signature: `${kind}|${cabinetId}`, cabinetId, title: AGENT_SECURITY_TITLE[kind],
          detail: { eventId: e.eventId, check, message: e.detail?.message ?? null, fields: e.detail?.fields ?? {} } });
      if (e.kind === "firewall_changed") {
        // The write's own result already recorded the change; the agent's event confirms it. Later events for the
        // same command (a profile's timer turning it back on, a safety-net rollback) are further changes.
        const linked = e.commandId ? await c.query("UPDATE firewall_changes SET event_id = $2 WHERE id = (SELECT TOP (1) id FROM firewall_changes WHERE command_id = $1 AND event_id IS NULL)",
          [e.commandId, e.eventId]) : null;
        if (!linked || linked.rowCount === 0)
          await c.query(`INSERT INTO firewall_changes (cabinet_id, command_id, event_id, explained, detail, occurred_at) VALUES ($1, $2, $3, $4, $5, $6)`,
            [cabinetId, e.commandId ?? null, e.eventId, !!e.commandId, e.detail ? safeJson(e.detail) : null, new Date(e.occurredAt)]);
      }
    }
    const processed = await processBatch(c, cabinetId, stored, inserted[0]?.version ?? null);
    return { stored: stored.length, outcomes: processed.outcomes, ruleHits: processed.ruleHits };
  });
  countRuleHits(pool, result.ruleHits);
  // A crash alert this batch raised opens or extends the cabinet's crash incident (D21). It never fails the batch: the one-minute sweep
  // brings the incident in line if this does not.
  if (result.outcomes.some(o => o.kind === "issue" && CRASH_ISSUES.includes(o.issueTypeId.toLowerCase())) || batch.events.some(e => e.kind === "short_uptime" || e.kind === "change"))
    await syncCrashIncident(pool, cabinetId).catch(() => undefined);
  // A new alert may be the one that makes a problem fleet-wide: check within seconds, not at the next minute (D23).
  if (result.outcomes.some(o => (o.kind === "issue" || o.kind === "unrecognized") && o.created)) void checkFleetSoon(pool);
  return { stored: result.stored, outcomes: result.outcomes };
}

// One statement for the whole batch; the rows come back with the rules stamp, so the engine knows whether its rules in memory are current.
const INSERT_EVENTS = `
  DECLARE @o TABLE (event_id uniqueidentifier NOT NULL);
  INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, command_id, severity_hint, detail, device)
    OUTPUT inserted.event_id INTO @o
    SELECT j.event_id, $1, j.kind, j.occurred_at, j.source, j.command_id, j.severity_hint, j.detail, j.device
      FROM OPENJSON($2) WITH (event_id uniqueidentifier '$.eventId', kind nvarchar(64) '$.kind', occurred_at datetime2(3) '$.occurredAt',
             source nvarchar(max) '$.source' AS JSON, command_id uniqueidentifier '$.commandId', severity_hint nvarchar(64) '$.severityHint',
             detail nvarchar(max) '$.detail' AS JSON, device nvarchar(max) '$.device' AS JSON) j
     WHERE NOT EXISTS (SELECT 1 FROM events e WITH (UPDLOCK, HOLDLOCK) WHERE e.event_id = j.event_id);
  SELECT o.event_id, v.stamp AS [version] FROM @o o CROSS JOIN (SELECT ${RULES_STAMP_SQL} AS stamp) v;`;

// ---- Retention (F21.R2, decision-log D75) -----------------------------------------------------------------------------------------------

const sleep = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

/** Removes events received before `cutoff`, in batches, each batch audited. A cut-off that is not a past time is refused; a repeat removes nothing more. */
export async function pruneOldEvents(db: Queryable, cutoff: Date, o: BatchOptions = RETENTION_BATCH): Promise<number> {
  checkRetentionCutoff(cutoff);
  return inBatches(db, "DELETE TOP ($1) FROM events WHERE received_at < $2", [cutoff], o, { table: "events", cutoff });
}

/**
 * Unlinks events from resolved alerts last seen before `cutoff`, so the alert can go while its events, kept longer, stay. In batches, each
 * batch audited; a repeat changes nothing more.
 */
export async function unlinkEventsOfOldAlerts(db: Queryable, cutoff: Date, o: BatchOptions = RETENTION_BATCH): Promise<number> {
  checkRetentionCutoff(cutoff);
  return inBatches(db, `UPDATE TOP ($1) e SET alert_id = NULL FROM events e JOIN alerts a ON a.id = e.alert_id
                         WHERE e.alert_id IS NOT NULL AND a.state = 'resolved' AND a.last_seen < $2`, [cutoff], o, { table: "events.alert_id", cutoff });
}

/** After this many days an event that has no alert loses its bulky detail and source JSON (the row, its kind, time, cabinet and device stay). */
export const EVENT_DETAIL_DAYS = 30;
/** Where the clearing stopped, as an event sequence number, so each night only looks at events it has not seen. */
const DETAIL_CURSOR = "maintenance.eventDetailSeq";

/**
 * Clears `detail` and `source` of events older than EVENT_DETAIL_DAYS that have no alert, so the database keeps every event for the whole
 * retention period (90 days by default) within SQL Server Express's 10 GB. Events with an alert stay whole, as do security events and the
 * crash records (BugCheck, Kernel-Power 41, unexpected shutdown) the crash timelines read. Walks the events in sequence order from a stored
 * cursor in batches (a clustered-key range each, never a scan from the start), so a night's work is only the day that just became old.
 */
export async function clearOldEventDetail(pool: Pool, now = Date.now(), o: BatchOptions = RETENTION_BATCH, days = EVENT_DETAIL_DAYS): Promise<number> {
  const cut = new Date(now - days * 86_400_000);
  const stored = (await pool.query<{ value: unknown }>("SELECT [value] FROM settings WHERE [key] = $1", [DETAIL_CURSOR])).rows[0]?.value;
  let last = typeof stored === "number" && Number.isInteger(stored) && stored >= 0 ? stored : 0;
  let cleared = 0;
  for (;;) {
    // The end of the next batch of old events, in sequence order.
    const hi = (await pool.query<{ hi: string | number | null }>(
      "SELECT MAX(seq) AS hi FROM (SELECT TOP ($1) seq FROM events WHERE seq > $2 AND received_at < $3 ORDER BY seq) x", [o.batch, last, cut], { timeoutMs: o.timeoutMs })).rows[0]?.hi;
    if (hi === null || hi === undefined) break;
    // The clearing and the cursor that accounts for it are one transaction: a run that stops here cannot leave cleared rows that no cursor
    // ever marked. Every batch that cleared anything leaves its own audit entry, in that same transaction.
    let batch = 0;
    await transaction(pool, async c => {
      batch = (await c.query(
        `UPDATE events SET detail = NULL, source = NULL
          WHERE seq > $1 AND seq <= $2 AND received_at < $3 AND alert_id IS NULL AND (detail IS NOT NULL OR source IS NOT NULL) AND kind <> 'security'
            AND NOT ${crashPredicate("events", 4)}`, [last, Number(hi), cut, ...crashArgs], { timeoutMs: o.timeoutMs })).rowCount ?? 0;
      last = Number(hi);
      await upsertSetting(c, DETAIL_CURSOR, last, null);
      if (batch > 0)
        await audit(c, { actorKind: "system", actorId: "retention", action: "retention.batch", outcome: "succeeded",
          details: { table: "events.detail", rows: batch, cutoff: cut, to: last } });
    });
    cleared += batch;
    await sleep(o.pauseMs);
  }
  return cleared;
}

