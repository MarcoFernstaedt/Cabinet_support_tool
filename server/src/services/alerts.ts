// The alerts engine (docs/spec/05-server-spec.md "Alerts engine" and "Offline handling").
// Each new event is checked against the live rules; a match raises or updates the issue's alert,
// anything else becomes a minor unrecognized alert. Repeats fold into one active alert per
// cabinet; the same issue on several cabinets at one site within an hour is a site-wide pattern.
import { platformSettings } from "./settings.js";
import { createHash } from "node:crypto";
import type { AlertFilter, Event } from "../contracts.js";
import { audit, isUniqueViolation, lock, LOCK_TIMEOUT_MS, Pool, transaction, type Queryable, type Tx } from "../db/db.js";
import { OFFLINE_AFTER_MS } from "./cabinets.js";
import { Refused } from "./errors.js";
import { countRuleHits, decide, ISSUE, liveNow, ruleConfig, type RuleConfig } from "./rules.js";
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

/** What one batch led to: an outcome per event, and how often each rule matched (counted into memory once the batch committed). */
export interface Processed { outcomes: Outcome[]; ruleHits: Map<string, number> }

/**
 * Runs the engine over newly stored events, inside the transaction that stored them. Rule matches are counted at once (callers that may
 * run the transaction again use processBatch and count after the commit).
 */
export async function processEvents(c: Tx, cabinetId: string, events: readonly Event[]): Promise<Outcome[]> {
  const r = await processBatch(c, cabinetId, events);
  countRuleHits(c, r.ruleHits);
  return r.outcomes;
}

// One step of a batch, in event order. Alert writes between two resolves are folded per signature and written together.
type Step =
  | { kind: "write"; index: number; write: AlertWrite; outcome: "issue" | "unrecognized"; issueTypeId: string | null; sitePattern: boolean }
  | { kind: "resolve"; index: number; by: "issue" | "signature"; key: string; resolution: string };

/**
 * The engine, set-based: the rules come from memory (rules.ts ruleConfig), each event is judged in memory, repeats of one signature in the
 * batch become one write, the alerts of a run of writes are written in one statement (locks, fold, insert and the site pattern), and the
 * events learn their alert and rule in one more. Semantics are those of judging the events one by one in order.
 */
export async function processBatch(c: Tx, cabinetId: string, events: readonly Event[], rulesVersion?: string | null): Promise<Processed> {
  const ruleHits = new Map<string, number>();
  if (events.length === 0) return { outcomes: [], ruleHits };
  const config = await ruleConfig(c, rulesVersion);
  const rules = liveNow(config);
  const outcomes: (Outcome | undefined)[] = new Array(events.length);
  const links = new Map<string, { e: string; a: string | null; r: string | null }>();
  const steps: Step[] = [];
  const hit = (ruleId: string) => ruleHits.set(ruleId, (ruleHits.get(ruleId) ?? 0) + 1);
  const now = Date.now();
  // An agent clock far in the future cannot push last_seen past now.
  const seenAt = (e: Event) => new Date(Math.min(new Date(e.occurredAt).getTime(), now));

  for (const [index, e] of events.entries()) {
    // A firewall change carrying a platform command's ID is an approved change, not an alert.
    if (e.kind === "firewall_changed" && e.commandId) { outcomes[index] = { kind: "platform_change" }; continue; }
    // The scanner watcher says when the scanner works again; its alert resolves itself.
    if (e.kind === "scanner" && e.device?.state === "recovered") {
      steps.push({ kind: "resolve", index, by: "issue", key: ISSUE.scanner, resolution: "The scanner recovered on its own." });
      continue;
    }
    if (e.kind === "service") {
      // Events from the broker's service watcher (docs/spec/12-milestones-8-to-12.md): an automatic restart opens a minor alert per service,
      // 3 failed restarts a major one, recovery resolves it, and a missing or disabled watched service a minor one.
      const service = e.detail?.fields?.service, change = e.detail?.fields?.change;
      if (!service || !SERVICE_NAME.test(service) || !change) { outcomes[index] = { kind: "stored" }; continue; }
      if (change === "recovered") {
        steps.push({ kind: "resolve", index, by: "signature", key: normalizeSignature(`service:failing:${service}`), resolution: "The service is running again." });
        continue;
      }
      const kind = change === "restarted" ? { issue: ISSUE.serviceRestarted, key: "restarted" } : change === "failing" ? { issue: ISSUE.serviceFailing, key: "failing" }
        : change === "missing" || change === "disabled" ? { issue: ISSUE.serviceWatch, key: "watch" } : null;
      const issue = kind ? config.issues.get(kind.issue) : undefined;
      if (!kind || !issue) { outcomes[index] = { kind: "stored" }; continue; }
      steps.push({ kind: "write", index, outcome: "issue", issueTypeId: issue.id, sitePattern: false, write: { cabinetId, issueTypeId: issue.id, severity: issue.severity,
        signature: `service:${kind.key}:${service}`, title: `${issue.name}: ${service}`, seenAt: seenAt(e), ruleId: null, eventId: e.eventId } });
      continue;
    }
    // A system change is kept for the crash timeline and the fleet comparison; it never raises an alert. Windows starting is a boot.
    if (e.kind === "change") {
      if (e.source && isBootRecord(e.source.source, e.source.eventId)) await recordBoot(c, cabinetId, new Date(e.occurredAt), "event");
      outcomes[index] = { kind: "stored" };
      continue;
    }
    const rule = decide(rules, e);
    if (rule?.kind === "suppress") {
      links.set(e.eventId, { e: e.eventId, a: null, r: rule.id });
      hit(rule.id);
      outcomes[index] = { kind: "suppressed", ruleId: rule.id };
      continue;
    }
    // Warnings are collected because they are often the first sign of a failing drive or controller, but only one a rule
    // recognizes raises an alert; the rest stay on the cabinet's event list, where anyone can map them to an issue.
    if (!rule && e.kind === "error" && e.source && e.source.level !== "error" && e.source.level !== "critical") { outcomes[index] = { kind: "stored" }; continue; }
    if (rule) hit(rule.id);
    const issue = rule?.issueTypeId ? config.issues.get(rule.issueTypeId) : undefined;
    steps.push({ kind: "write", index, outcome: issue ? "issue" : "unrecognized", issueTypeId: issue?.id ?? null, sitePattern: !!issue, write: {
      // The rule's own severity overrides the issue type's: an early sign of an issue can be minor, a real failure major.
      cabinetId, issueTypeId: issue?.id ?? null, severity: (issue && rule?.severity) || issue?.severity || "minor", signature: issue ? `issue:${issue.id}` : unrecognizedSignature(e),
      title: issue?.name ?? unrecognizedTitle(e), seenAt: seenAt(e), ruleId: rule?.id ?? null, eventId: e.eventId } });
  }

  // The steps in order: a run of writes is one statement; a resolve is its own (a write after it must open a new alert).
  for (let i = 0; i < steps.length;) {
    const step = steps[i]!;
    if (step.kind === "resolve") {
      const r = await c.query<{ id: string }>(
        `DECLARE @o TABLE (id uniqueidentifier);
         UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME(), resolution = $3
           OUTPUT inserted.id INTO @o
          WHERE cabinet_id = $1 AND state <> 'resolved' AND ${step.by === "issue" ? "issue_type_id = CAST($2 AS uniqueidentifier)" : "signature = $2"};
         SELECT id FROM @o;`, [cabinetId, step.key, step.resolution]);
      const e = events[step.index]!;
      links.set(e.eventId, { e: e.eventId, a: r.rows[0]?.id ?? null, r: null });
      outcomes[step.index] = { kind: "resolved", alertIds: r.rows.map(x => x.id) };
      i++;
      continue;
    }
    const run: Extract<Step, { kind: "write" }>[] = [];
    while (i < steps.length && steps[i]!.kind === "write") run.push(steps[i++] as Extract<Step, { kind: "write" }>);
    const written = await writeAlerts(c, cabinetId, run.map(s => ({ write: s.write, sitePattern: s.sitePattern })), config);
    for (const [k, s] of run.entries()) {
      const a = written[k]!;
      const e = events[s.index]!;
      links.set(e.eventId, { e: e.eventId, a: a.id, r: s.write.ruleId });
      outcomes[s.index] = s.outcome === "issue" ? { kind: "issue", alertId: a.id, issueTypeId: s.issueTypeId!, created: a.created } : { kind: "unrecognized", alertId: a.id, created: a.created };
    }
  }

  // Every event that got an alert or a rule learns it in one statement.
  const linked = [...links.values()].filter(l => l.a !== null || l.r !== null);
  if (linked.length > 0)
    await c.query(`UPDATE e SET alert_id = j.a, matched_rule = j.r FROM events e
                     JOIN OPENJSON($1) WITH (e uniqueidentifier '$.e', a uniqueidentifier '$.a', r uniqueidentifier '$.r') j ON e.event_id = j.e`, [JSON.stringify(linked)]);
  return { outcomes: outcomes.map(o => o ?? { kind: "stored" }), ruleHits };
}

const SERVICE_NAME = /^[A-Za-z0-9_.$-](?:[A-Za-z0-9_.$ -]{0,78}[A-Za-z0-9_.$-])?$/;

const alertLockName = (cabinetId: string, signature: string) => `alert:${cabinetId}:${createHash("sha256").update(signature).digest("hex").slice(0, 32)}`;

/**
 * Writes a run of alert writes for one cabinet in one statement. Writes with the same signature (compared as SQL Server does, ignoring case)
 * fold into one: as many occurrences, the earliest first and latest last time, the latest event and rule, major if any was. The statement
 * takes the alert locks (and the site-pattern locks) in name order, folds into the active alerts, inserts the rest, and flags site patterns.
 * Returns, for each write in order, its alert and whether this write created it (only the first write of a new alert did).
 */
async function writeAlerts(c: Tx, cabinetId: string, writes: readonly { write: AlertWrite; sitePattern: boolean }[], config: RuleConfig): Promise<{ id: string; created: boolean }[]> {
  interface Group { n: number; lock: string; site: string | null; issue_type_id: string | null; severity: string; signature: string; title: string; first_seen: string;
    last_seen: string; rule_id: string | null; event_id: string | null; occurrences: number; scope: string; members: number[] }
  const groups = new Map<string, Group>();
  for (const [k, { write: w, sitePattern }] of writes.entries()) {
    const signature = normalizeSignature(w.signature);
    const key = signature.toLowerCase();
    const seen = w.seenAt.toISOString();
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { n: 0, lock: alertLockName(w.cabinetId, signature), site: sitePattern ? createHash("sha256").update(signature).digest("hex").slice(0, 32) : null,
        issue_type_id: w.issueTypeId, severity: w.severity, signature, title: w.title, first_seen: seen, last_seen: seen, rule_id: w.ruleId, event_id: w.eventId, occurrences: 1,
        scope: (w.issueTypeId && config.issues.get(w.issueTypeId)?.scope) || "fleet", members: [k] });
      continue;
    }
    g.occurrences++;
    if (seen < g.first_seen) g.first_seen = seen;
    if (seen > g.last_seen) g.last_seen = seen;
    if (w.eventId) g.event_id = w.eventId;
    if (w.ruleId) g.rule_id = w.ruleId;
    if (w.severity === "major") g.severity = "major";
    g.members.push(k);
  }
  // Locks are taken in name order, so two batches never wait for each other in a circle.
  const list = [...groups.values()].sort((a, b) => (a.lock < b.lock ? -1 : a.lock > b.lock ? 1 : 0));
  list.forEach((g, n) => { g.n = n; });
  const rows = (await c.query<{ n: number; id: string; created: boolean }>(WRITE_ALERTS,
    [cabinetId, JSON.stringify(list.map(({ members: _m, ...g }) => g)), LOCK_TIMEOUT_MS, SITE_PATTERN_WINDOW_MS / 1000])).rows;
  const byN = new Map(rows.map(r => [Number(r.n), r]));
  const out: { id: string; created: boolean }[] = new Array(writes.length);
  for (const g of list) {
    const r = byN.get(g.n);
    if (!r) throw new Error("an alert write returned no alert");
    g.members.forEach((k, i) => { out[k] = { id: r.id, created: !!r.created && i === 0 }; });
  }
  return out;
}

// Fixed text: the groups arrive as JSON ($2), nothing here is built from input.
const WRITE_ALERTS = `

  DECLARE @g TABLE (n int PRIMARY KEY, lock_name nvarchar(255) NOT NULL, site_hash nvarchar(32) NULL, issue_type_id uniqueidentifier NULL, severity nvarchar(64) NOT NULL,
    signature nvarchar(450) NOT NULL, title nvarchar(max) NOT NULL, first_seen datetime2(3) NOT NULL, last_seen datetime2(3) NOT NULL, rule_id uniqueidentifier NULL,
    event_id uniqueidentifier NULL, occurrences int NOT NULL, scope nvarchar(64) NOT NULL);
  INSERT INTO @g SELECT * FROM OPENJSON($2) WITH (n int '$.n', lock_name nvarchar(255) '$.lock', site_hash nvarchar(32) '$.site', issue_type_id uniqueidentifier '$.issue_type_id',
    severity nvarchar(64) '$.severity', signature nvarchar(450) '$.signature', title nvarchar(max) '$.title', first_seen datetime2(3) '$.first_seen', last_seen datetime2(3) '$.last_seen',
    rule_id uniqueidentifier '$.rule_id', event_id uniqueidentifier '$.event_id', occurrences int '$.occurrences', scope nvarchar(64) '$.scope');
  DECLARE @r int, @i int = 0, @count int = (SELECT COUNT(*) FROM @g), @name nvarchar(255);
  WHILE @i < @count
  BEGIN
    SELECT @name = lock_name FROM @g WHERE n = @i;
    EXEC @r = sp_getapplock @Resource = @name, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = $3;
    IF @r = -3 THROW 50003, 'deadlock while waiting for the lock', 1;
    IF @r < 0 THROW 50001, 'could not take the lock', 1;
    SET @i = @i + 1;
  END
  DECLARE @res TABLE (n int NOT NULL, id uniqueidentifier NOT NULL, created bit NOT NULL);
  DECLARE @ins TABLE (signature nvarchar(450) NOT NULL, id uniqueidentifier NOT NULL);
  UPDATE a SET occurrences = a.occurrences + g.occurrences,
         first_seen = CASE WHEN g.first_seen < a.first_seen THEN g.first_seen ELSE a.first_seen END,
         last_seen = CASE WHEN g.last_seen > a.last_seen THEN g.last_seen ELSE a.last_seen END,
         last_event_id = COALESCE(g.event_id, a.last_event_id), rule_id = COALESCE(g.rule_id, a.rule_id),
         -- A more serious symptom of the same issue makes the alert major; it never drops back on its own.
         severity = CASE WHEN g.severity = 'major' OR a.severity = 'major' THEN 'major' ELSE 'minor' END
    OUTPUT g.n, inserted.id, 0 INTO @res
    FROM alerts a JOIN @g g ON a.signature = g.signature
   WHERE a.cabinet_id = $1 AND a.state <> 'resolved';
  BEGIN TRY
    INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, occurrences, first_seen, last_seen, rule_id, last_event_id, scope)
      OUTPUT inserted.signature, inserted.id INTO @ins
      SELECT $1, g.issue_type_id, g.severity, g.signature, g.title, g.occurrences, g.first_seen, g.last_seen, g.rule_id, g.event_id, g.scope
        FROM @g g WHERE NOT EXISTS (SELECT 1 FROM @res r WHERE r.n = g.n);
  END TRY
  BEGIN CATCH
    IF ERROR_NUMBER() NOT IN (2601, 2627) THROW;
    -- A writer outside the locks raised one of these alerts first: fold into it.
    UPDATE a SET occurrences = a.occurrences + g.occurrences,
           first_seen = CASE WHEN g.first_seen < a.first_seen THEN g.first_seen ELSE a.first_seen END,
           last_seen = CASE WHEN g.last_seen > a.last_seen THEN g.last_seen ELSE a.last_seen END,
           last_event_id = COALESCE(g.event_id, a.last_event_id), rule_id = COALESCE(g.rule_id, a.rule_id),
           severity = CASE WHEN g.severity = 'major' OR a.severity = 'major' THEN 'major' ELSE 'minor' END
      OUTPUT g.n, inserted.id, 0 INTO @res
      FROM alerts a JOIN @g g ON a.signature = g.signature
     WHERE a.cabinet_id = $1 AND a.state <> 'resolved' AND NOT EXISTS (SELECT 1 FROM @res r WHERE r.n = g.n);
  END CATCH
  INSERT INTO @res (n, id, created) SELECT g.n, i.id, 1 FROM @ins i JOIN @g g ON g.signature = i.signature;
  -- The same issue on two or more cabinets of the site within the window: every active alert for it there is a site pattern.
  DECLARE @site uniqueidentifier = (SELECT site_id FROM cabinets WHERE id = $1);
  IF @site IS NOT NULL AND EXISTS (SELECT 1 FROM @g WHERE site_hash IS NOT NULL)
  BEGIN
    DECLARE @s TABLE (k int IDENTITY(0, 1) PRIMARY KEY, lock_name nvarchar(255) NOT NULL);
    INSERT INTO @s (lock_name) SELECT DISTINCT CONCAT(N'site-pattern:', LOWER(CONVERT(nvarchar(36), @site)), N':', site_hash) FROM @g WHERE site_hash IS NOT NULL ORDER BY 1;
    SELECT @i = 0, @count = COUNT(*) FROM @s;
    WHILE @i < @count
    BEGIN
      SELECT @name = lock_name FROM @s WHERE k = @i;
      EXEC @r = sp_getapplock @Resource = @name, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = $3;
      IF @r = -3 THROW 50003, 'deadlock while waiting for the lock', 1;
      IF @r < 0 THROW 50001, 'could not take the lock', 1;
      SET @i = @i + 1;
    END
    UPDATE a SET site_pattern = 1
      FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id JOIN @g g ON g.signature = a.signature AND g.site_hash IS NOT NULL
     WHERE k.site_id = @site AND a.state <> 'resolved' AND a.site_pattern = 0 AND a.last_seen > DATEADD(second, -$4, SYSUTCDATETIME())
       AND (SELECT COUNT(DISTINCT p.cabinet_id) FROM alerts p JOIN cabinets pk ON pk.id = p.cabinet_id
             WHERE pk.site_id = @site AND p.signature = g.signature AND p.state <> 'resolved' AND p.last_seen > DATEADD(second, -$4, SYSUTCDATETIME())) >= 2;
  END
  SELECT n, id, created FROM @res;`;

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

/** The longest an agent waits between attempts to reach the server (docs/spec/03-protocol.md: backoff capped at 5 minutes). */
export const MAX_AGENT_BACKOFF_MS = 5 * 60_000;

/** How the fleet is reaching the server right now (simulated demo cabinets left out): what the offline judgements are weighed against. */
export interface ContactReading { recent: number; newestAgeMs: number | null }

export async function readFleetContact(db: Queryable): Promise<ContactReading> {
  const r = (await db.query<{ recent: number | null; newest_age_ms: string | null }>(
    `SELECT SUM(CASE WHEN last_heartbeat_at > DATEADD(second, -$1, SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS recent,
            DATEDIFF_BIG(millisecond, MAX(last_heartbeat_at), SYSUTCDATETIME()) AS newest_age_ms
       FROM cabinets WHERE status = 'active' AND demo_scenario IS NULL`, [OFFLINE_AFTER_MS / 1000])).rows[0];
  return { recent: Number(r?.recent ?? 0), newestAgeMs: r?.newest_age_ms === null || r?.newest_age_ms === undefined ? null : Number(r.newest_age_ms) };
}

/**
 * Whether "not heard from" can be trusted as "offline" right now. When the server or its database was down, every cabinet looks silent
 * when it comes back, though nothing happened at the cabinets: offline and site-outage alerts would fire across the fleet. So judgements
 * are held after this process last saw the fleet normally (its start, a gap in its own checks, no heartbeat from anyone, or fleet-wide
 * contact falling below half of what it was in the last hour) until the offline window plus the agents' longest backoff has passed, so
 * every cabinet has had the chance to report again. Simulated demo cabinets are judged regardless. Fleet-wide signals need a fleet of at
 * least minFleet cabinets, so a small installation (and a test database) is judged as before.
 */
export interface FleetContactOptions {
  /** The offline window, and the agents' longest backoff: how long judgements wait after the fleet was last seen normally. */
  windowMs: number; backoffMs: number;
  /** Fleet-wide signals (no heartbeat at all, contact halved) count only with at least this many cabinets reporting in the last hour. */
  minFleet: number;
  /** A gap this long between two checks means the server or its database was away (only once start() was called). */
  maxRunGapMs: number;
  /** No heartbeat from any cabinet for this long means heartbeats are not getting through. */
  quietIngestMs: number;
  /** How far back the usual contact (the highest count) is remembered. */
  baselineMs: number;
}

export class FleetContact {
  private holdUntil = 0;
  private armed = false;
  private lastRun = 0;
  private history: { at: number; recent: number }[] = [];
  /** Why judgements are held (null when they are not); for logs and tests. */
  reason: string | null = null;

  constructor(private readonly overrides: Partial<FleetContactOptions> = {}) {}

  /** Read when used, not when the module loads (cabinets.ts, which defines the offline window, imports this module in a cycle). */
  get options(): FleetContactOptions {
    return { windowMs: OFFLINE_AFTER_MS, backoffMs: MAX_AGENT_BACKOFF_MS, minFleet: 20, maxRunGapMs: 3 * 60_000, quietIngestMs: 3 * 60_000, baselineMs: 60 * 60_000,
      ...this.overrides };
  }

  /** The server process started: hold, and from now on treat a gap in the checks (the database was away) as an outage too. */
  start(now = Date.now()): void {
    this.armed = true;
    this.lastRun = now;
    this.hold(now, "the server started");
  }

  private hold(now: number, reason: string): void {
    this.holdUntil = Math.max(this.holdUntil, now + this.options.windowMs + this.options.backoffMs);
    this.reason = reason;
  }

  /** Called by each judging job with what it just read. True when offline judgements may be made now. */
  judge(reading: ContactReading, now = Date.now()): boolean {
    const o = this.options;
    if (this.armed && now - this.lastRun > o.maxRunGapMs) this.hold(now, "the checks did not run (the server or its database was away)");
    this.lastRun = now;
    this.history = this.history.filter(h => now - h.at <= o.baselineMs);
    const baseline = this.history.reduce((m, h) => Math.max(m, h.recent), 0);
    if (baseline >= o.minFleet && reading.newestAgeMs !== null && reading.newestAgeMs > o.quietIngestMs) this.hold(now, "no cabinet has reported for minutes");
    else if (baseline >= o.minFleet && reading.recent < baseline / 2) this.hold(now, "fleet-wide contact fell by more than half");
    else this.history.push({ at: now, recent: reading.recent });
    if (now >= this.holdUntil) { this.reason = null; return true; }
    return false;
  }
}

/** The one guard of this server process (main.ts starts it). */
export const fleetContact = new FleetContact();

/**
 * The threshold job: a cabinet offline longer than the setting gets a real alert; one that is back
 * resolves its own. Runs every minute, and the resolve half also runs on each heartbeat. While the
 * fleet's contact is in doubt (FleetContact) no new alert is raised, except on simulated cabinets.
 */
export async function checkOffline(pool: Pool, guard: FleetContact = fleetContact): Promise<{ raised: number; resolved: number }> {
  return transaction(pool, async c => {
    const days = await offlineAlertDays(c);
    const judge = guard.judge(await readFleetContact(c));
    const issue = (await c.query<{ name: string; severity: string }>("SELECT name, severity FROM issue_types WHERE id = $1", [ISSUE.offline])).rows[0]!;
    // An open alert is only kept up to date (one statement for the fleet); a cabinet without one gets one.
    await c.query(
      `UPDATE a SET last_seen = SYSUTCDATETIME() FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id
        WHERE a.issue_type_id = $1 AND a.state <> 'resolved' AND k.status = 'active' AND COALESCE(k.last_heartbeat_at, k.created_at) < DATEADD(day, -$2, SYSUTCDATETIME())`,
      [ISSUE.offline, days]);
    const due = (await c.query<{ id: string; since: Date }>(
      `SELECT k.id, COALESCE(k.last_heartbeat_at, k.created_at) AS since FROM cabinets k
        WHERE k.status = 'active' AND COALESCE(k.last_heartbeat_at, k.created_at) < DATEADD(day, -$1, SYSUTCDATETIME())
          AND ($2 = 1 OR k.demo_scenario IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.issue_type_id = $3 AND a.cabinet_id = k.id AND a.state <> 'resolved')`, [days, judge, ISSUE.offline])).rows;
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

/**
 * Resolves offline alerts for cabinets heard from again (one cabinet, or all when null). Two fixed statements, so the one-cabinet case
 * (every heartbeat after a silence) never runs with the plan made for the whole fleet; both use the open-alerts index.
 */
export async function resolveOfflineFor(db: Queryable, cabinetId: string | null): Promise<number> {
  const r = cabinetId === null
    ? await db.query(
      `UPDATE a SET state = 'resolved', resolved_at = SYSUTCDATETIME(), resolution = 'The cabinet is back online.'
         FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id WHERE a.issue_type_id = $1 AND a.state <> 'resolved'
          AND k.last_heartbeat_at > DATEADD(second, -$2, SYSUTCDATETIME())`, [ISSUE.offline, OFFLINE_AFTER_MS / 1000])
    : await db.query(
      `UPDATE a SET state = 'resolved', resolved_at = SYSUTCDATETIME(), resolution = 'The cabinet is back online.'
         FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id WHERE a.issue_type_id = $1 AND a.cabinet_id = $3 AND a.state <> 'resolved'
          AND k.last_heartbeat_at > DATEADD(second, -$2, SYSUTCDATETIME())`, [ISSUE.offline, OFFLINE_AFTER_MS / 1000, cabinetId]);
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
