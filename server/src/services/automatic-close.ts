// Automatic closes on the audit chain (finding F4): every alert the platform closes by itself is audited in the same transaction.
import { auditMany, Pool, type Queryable, type Tx } from "../db/db.js";
import { CLOSED_OUTPUT } from "./closed-output.js";
import { ISSUE } from "./rules.js";

export { CLOSED_OUTPUT };

/**
 * The platform writes that fix each issue type (F18.R1), so a close found by the cabinet's own reading can name the fix it verifies. Built
 * when called, not when loaded: rules.ts imports this module, and ISSUE lives there.
 */
export function fixingOperations(): Record<string, readonly string[]> {
  return {
    [ISSUE.timeZone]: ["time.setZone"], [ISSUE.clock]: ["time.sync"], [ISSUE.firewallPolicy]: ["firewall.applyPolicy", "firewall.setProfile"],
    [ISSUE.serviceFailing]: ["service.control"], [ISSUE.serviceWatch]: ["service.control", "service.setStartType"],
    [ISSUE.networkBaseline]: ["network.setIp", "network.setDns", "network.renewLease"],
  };
}

/** The fix a close verifies: the newest platform write for the issue since the alert opened, with its before and after as the cabinet reported them. */
export interface VerifiedFix { commandId: string; operation: string; by: string | null; at: string; before: unknown; after: unknown }

/**
 * The before and after a write reported, from its own result. Each fixing operation names its pair one of these ways (the test reads
 * every one's output schema): most return {before, after}; time.sync the last successful syncs; network.renewLease the address.
 */
export const BEFORE_AFTER_PAIRS = [["before", "after"], ["lastSuccessfulSyncBefore", "lastSuccessfulSyncAfter"], ["addressBefore", "addressAfter"]] as const;
export function beforeAfter(output: Record<string, unknown> | undefined): { before: unknown; after: unknown } {
  if (!output) return { before: null, after: null };
  const pair = BEFORE_AFTER_PAIRS.find(([b, a]) => b in output || a in output);
  return pair ? { before: output[pair[0]] ?? null, after: output[pair[1]] ?? null } : { before: null, after: null };
}

/** At most this many closes in one call look up the fix they verify; a fleet-wide sweep that closes more audits the rest without it. */
export const FIX_LOOKUPS = 100;

async function fixesFor(tx: Queryable, closed: readonly { id: string; cabinet_id: string }[]): Promise<Map<string, VerifiedFix>> {
  const found = new Map<string, VerifiedFix>();
  const ops = fixingOperations();
  const alerts = (await tx.query<{ id: string; issue_type_id: string | null; first_seen: Date }>(
    "SELECT id, LOWER(CONVERT(nvarchar(64), issue_type_id)) AS issue_type_id, first_seen FROM alerts WHERE id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))",
    [JSON.stringify(closed.slice(0, FIX_LOOKUPS).map(r => r.id))])).rows;
  const cabinetOf = new Map(closed.map(r => [r.id.toLowerCase(), r.cabinet_id]));
  for (const a of alerts) {
    const operations = a.issue_type_id ? ops[a.issue_type_id] : undefined;
    if (!operations) continue;
    const c = (await tx.query<{ id: string; operation: string; name: string | null; result: { output?: Record<string, unknown> } | null; result_at: Date }>(
      `SELECT TOP (1) c.id, c.operation, u.name, c.result, c.result_at FROM commands c LEFT JOIN users u ON u.id = c.issued_by
        WHERE c.cabinet_id = $1 AND c.status = 'succeeded' AND c.result_at >= $2 AND c.operation IN (SELECT value FROM OPENJSON($3)) ORDER BY c.result_at DESC`,
      [cabinetOf.get(a.id.toLowerCase()), a.first_seen, JSON.stringify(operations)])).rows[0];
    if (c) found.set(a.id.toLowerCase(), { commandId: c.id.toLowerCase(), operation: c.operation, by: c.name, at: c.result_at.toISOString(), ...beforeAfter(c.result?.output) });
  }
  return found;
}

/**
 * Closes alerts the platform found fixed, and audits each close as alert.resolve (actor system, `by`, automatic: true) in the same
 * transaction as the close (F4, docs/spec/05-server-spec.md). `update` is one UPDATE of alerts that carries CLOSED_OUTPUT; the audit
 * sweep test (test/audit-sweep.test.ts) refuses an automatic close that does not come through here or audit on its own.
 * Nothing is written to the audit log when nothing closed.
 */
export async function closeAutomatically(db: Queryable, by: string, update: string, params: readonly unknown[]): Promise<{ id: string; cabinetId: string }[]> {
  if (!update.includes(CLOSED_OUTPUT)) throw new Error("an automatic close must OUTPUT its rows with CLOSED_OUTPUT");
  const run = async (tx: Tx) => {
    const rows = (await tx.query<{ id: string; cabinet_id: string; resolution: string | null }>(
      `DECLARE @closed TABLE (id uniqueidentifier, cabinet_id uniqueidentifier, resolution nvarchar(max));
       ${update};
       SELECT id, cabinet_id, resolution FROM @closed;`, [...params])).rows;
    if (rows.length > 0) {
      // A close found by the cabinet's reading names the platform fix it verifies, with that fix's before and after (F18.R1); null when
      // nothing the platform did since the alert opened explains it (the cabinet put itself right, or someone did on the cabinet).
      const fixes = await fixesFor(tx, rows);
      await auditMany(tx, rows.map(r => ({ actorKind: "system", actorId: by, action: "alert.resolve", targetKind: "alert", targetId: r.id.toLowerCase(),
        outcome: "succeeded", details: { cabinetId: r.cabinet_id.toLowerCase(), resolution: r.resolution, automatic: true, verifiedFix: fixes.get(r.id.toLowerCase()) ?? null } })));
    }
    return rows.map(r => ({ id: r.id, cabinetId: r.cabinet_id }));
  };
  // In the caller's transaction, or a new one when the caller holds only the pool.
  return db instanceof Pool ? db.transaction(run) : run(db as Tx);
}
