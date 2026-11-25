// The USB layer's data side: the four scope rows, the versioned write with its step-up token and audit entry, and the
// alert rows one report produces.
//
// The policies live in the settings table (key `usb.policy` for the fleet, `usb.policy.<level>.<id>` otherwise, value
// `{ version, policy }`), which is already a key/value store with a JSON check on the value and a 450-character key, so
// nothing here needs a migration. Ids are lowered on both sides of every key, so a mixed-case uuid finds its row.
//
// Every number and rule lives in usb-policy.ts and usb-rules.ts, which take no database; this file only reads, writes
// and hands over. The statements themselves live in usb-sql.ts, which imports no driver, so they can be checked against
// the migration by a test without a SQL Server — this file stays the only one in the layer that needs a live database.
import { audit, transaction, type Pool, type Queryable } from "../db/db.js";
import { normalizeSignature, upsertAlert } from "./alerts.js";
import { closeAutomatically } from "./automatic-close.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { Refused } from "./errors.js";
import { upsertSetting } from "./settings.js";
import { ROLE_RANK, type Role } from "./roles.js";
import {
  UsbPolicyError, UsbPolicyMemory, checkStoredUsbPolicy, issuesText, nextUsbPolicyVersion, parseUsbWatchPolicy,
  usbPolicyAuditEntry, usbPolicySettingKey, usbStepUpAction, type UsbPolicy, type UsbPolicyLevel, type UsbScopeLevel,
} from "./usb-policy.js";
import {
  checkUsbDeviceReport, evaluateUsbWatch, usbAlertWork, type UsbDeviceReport, type UsbIssueTypeInfo,
  type UsbOpenIncident, type UsbWatchResult,
} from "./usb-rules.js";
import {
  usbIssueCatalogParams, usbIssueCatalogSql, usbOpenIncidentsParams, usbOpenIncidentsSql, usbPolicyDeleteParams,
  usbPolicyDeleteSql, usbPolicyLevelsParams, usbPolicyLevelsSql, usbPolicyRowParams, usbPolicyRowSql,
  usbResolveIncidentParams, usbResolveIncidentSql, usbScopeExistsParams, usbScopeExistsSql,
} from "./usb-sql.js";

/** The last policy that validated at each level, for the life of the process (usb-policy.ts explains what it is for). */
const memory = new UsbPolicyMemory();

/**
 * The four rows for a cabinet in one read, which is what runs on every heartbeat: the cabinet's own policy, its site's,
 * its client's and the fleet's, ids lowered to match the keys written below.
 */
export async function usbPolicyLevels(db: Queryable, cabinetId: string): Promise<UsbPolicyLevel[]> {
  const r = await db.query<{ cabinet: string | null; site: string | null; client: string | null; fleet: string | null; site_id: string | null; client_id: string | null }>(
    usbPolicyLevelsSql, usbPolicyLevelsParams(cabinetId));
  const row = r.rows[0];
  if (!row) throw new Refused("not_found", 404, "no such cabinet");
  return [
    { level: "cabinet", scopeId: cabinetId.toLowerCase(), stored: row.cabinet },
    { level: "site", scopeId: row.site_id, stored: row.site },
    { level: "client", scopeId: row.client_id, stored: row.client },
    { level: "fleet", scopeId: null, stored: row.fleet },
  ];
}

/** The settings row for one scope, or null when nothing is stored there. */
export async function readUsbPolicyRow(db: Queryable, level: UsbScopeLevel, scopeId: string | null): Promise<unknown> {
  const r = await db.query<{ value: string | null }>(usbPolicyRowSql, usbPolicyRowParams(level, scopeId));
  return r.rows[0]?.value ?? null;
}

/** Who may change a USB watch policy: an Admin, as for every other fleet, client, site or cabinet setting. */
function assertAdmin(role: string): void {
  if (ROLE_RANK[role as Role] !== ROLE_RANK.admin) throw new Refused("forbidden", 403, "only an Admin changes a USB watch policy");
}

/** What the step-up token for a USB policy write is bound to: the level, the scope and the policy exactly as the person sent it. */
export const usbPolicyConfirmed = (level: UsbScopeLevel, scopeId: string | null, policy: unknown): Record<string, unknown> =>
  ({ level, scopeId: scopeId === null ? null : scopeId.toLowerCase(), policy });

/**
 * Stores a policy for one scope: an Admin only, the level has to exist, the request has to meet the contract (or it is refused with
 * the field and the rule that failed), the version is one more than what is in force, and the change, its step-up token and its audit
 * entry commit together. The token is required and is bound to {level, scopeId, policy} as sent, so it confirms this policy for this
 * scope and nothing else.
 */
export async function setUsbPolicy(pool: Pool, user: { userId: string; role: string }, level: UsbScopeLevel, scopeId: string | null, input: unknown, stepUpToken: string): Promise<UsbPolicy> {
  assertAdmin(user.role);
  const userId = user.userId;
  if (typeof stepUpToken !== "string" || stepUpToken.length === 0) throw new Refused("step_up_required", 403, "a USB policy change needs an authenticator code");
  let policy: UsbPolicy;
  try {
    policy = parseUsbWatchPolicy(input);
  } catch (e) {
    if (e instanceof UsbPolicyError) throw new Refused("invalid_request", 400, `usb policy: ${issuesText(e.issues)}`, { issues: e.issues });
    throw e;
  }
  await transaction(pool, async c => {
    if (level !== "fleet") {
      if (scopeId === null) throw new Refused("invalid_request", 400, `a ${level} policy needs an id`);
      const r = await c.query(usbScopeExistsSql[level], usbScopeExistsParams(scopeId));
      if (r.rowCount !== 1) throw new Refused("not_found", 404, `no such ${level}`);
    }
    const current = await readUsbPolicyRow(c, level, scopeId);
    const version = nextUsbPolicyVersion(current);
    await consumeStepUpToken(c, stepUpToken, userId, usbStepUpAction(level), scopeId?.toLowerCase() ?? "fleet", usbPolicyConfirmed(level, scopeId, input));
    await upsertSetting(c, usbPolicySettingKey(level, scopeId), { version, policy }, userId);
    await audit(c, usbPolicyAuditEntry({ level, scopeId, userId, version, before: beforePolicy(current), after: policy }));
  });
  return policy;
}

/** Removes a scope's policy, which leaves the broader scope in force again: an Admin with a token bound to {level, scopeId, policy: null}. The audit entry carries what was removed. */
export async function clearUsbPolicy(pool: Pool, user: { userId: string; role: string }, level: UsbScopeLevel, scopeId: string | null, stepUpToken: string): Promise<void> {
  assertAdmin(user.role);
  const userId = user.userId;
  if (typeof stepUpToken !== "string" || stepUpToken.length === 0) throw new Refused("step_up_required", 403, "a USB policy change needs an authenticator code");
  await transaction(pool, async c => {
    if (level !== "fleet" && scopeId === null) throw new Refused("invalid_request", 400, `a ${level} policy needs an id`);
    const current = await readUsbPolicyRow(c, level, scopeId);
    await consumeStepUpToken(c, stepUpToken, userId, usbStepUpAction(level), scopeId?.toLowerCase() ?? "fleet", usbPolicyConfirmed(level, scopeId, null));
    await c.query(usbPolicyDeleteSql, usbPolicyDeleteParams(level, scopeId));
    await audit(c, usbPolicyAuditEntry({ level, scopeId, userId, version: null, before: beforePolicy(current), after: null }));
  });
}

/** The policy a stored row held, for the "before" side of an audit entry; null when the row was empty or unusable. */
function beforePolicy(raw: unknown): UsbPolicy | null {
  const checked = checkStoredUsbPolicy(raw);
  return checked.ok ? checked.stored.policy : null;
}

/** The three issue types the rules raise, by key. A rule whose key is not here cannot open an alert (usb-rules.ts). */
export async function usbIssueCatalog(db: Queryable): Promise<Map<string, UsbIssueTypeInfo>> {
  const r = await db.query<{ key: string | null; id: string; name: string; severity: string }>(usbIssueCatalogSql, usbIssueCatalogParams());
  const catalog = new Map<string, UsbIssueTypeInfo>();
  for (const row of r.rows) if (row.key !== null) catalog.set(row.key, { id: row.id, name: row.name, severity: row.severity === "major" ? "major" : "minor" });
  return catalog;
}

/** The USB incidents this cabinet is already carrying, so a repeat updates its own row instead of opening another. */
export async function openUsbIncidents(db: Queryable, cabinetId: string): Promise<Map<string, UsbOpenIncident>> {
  const r = await db.query<{ signature: string; severity: string; occurrences: number; last_seen: Date | null }>(usbOpenIncidentsSql, usbOpenIncidentsParams(cabinetId));
  const incidents = new Map<string, UsbOpenIncident>();
  for (const row of r.rows) incidents.set(row.signature, { severity: row.severity === "major" ? "major" : "minor", occurrences: row.occurrences, lastUpdateAt: row.last_seen });
  return incidents;
}

/**
 * Takes one report from a cabinet: validates it, resolves the policy per unit, evaluates the three rules against the
 * incidents already open, opens or updates those alerts and closes the ones whose condition is gone. Returns what it
 * did, for the heartbeat's own log line.
 */
export async function applyUsbReport(pool: Pool, cabinetId: string, body: unknown): Promise<{ decisions: number; opened: number; updated: number; resolved: number; silent: number; holds: number; suppressed: number; unwatched: number }> {
  const checked = checkUsbDeviceReport(body);
  if (!checked.ok) throw new Refused("invalid_request", 400, `usb report: ${issuesText(checked.issues)}`, { issues: checked.issues });
  const report: UsbDeviceReport = checked.report;
  if (report.cabinetId.toLowerCase() !== cabinetId.toLowerCase()) throw new Refused("invalid_request", 400, "the report names another cabinet");
  return transaction(pool, async c => {
    const levels = await usbPolicyLevels(c, cabinetId);
    const issueTypes = await usbIssueCatalog(c);
    const incidents = await openUsbIncidents(c, cabinetId);
    const result: UsbWatchResult = evaluateUsbWatch({ cabinetId, now: new Date(), report, levels, memory, incidents, issueTypes });
    const work = usbAlertWork(cabinetId, result.decisions);
    for (const write of work.writes) await upsertAlert(c, { ...write, signature: normalizeSignature(write.signature) });
    for (const done of work.resolutions) {
      await closeAutomatically(c, "usb-watch", usbResolveIncidentSql, usbResolveIncidentParams(cabinetId, normalizeSignature(done.signature), done.resolution));
    }
    return {
      decisions: result.decisions.length,
      opened: result.decisions.filter(d => d.action === "open").length,
      updated: result.decisions.filter(d => d.action === "update").length,
      resolved: work.resolutions.length,
      silent: work.silent.length,
      holds: result.holds.length,
      suppressed: result.suppressedDependencies,
      unwatched: result.resolutions.filter(r => r.resolution === null).length,
    };
  });
}
