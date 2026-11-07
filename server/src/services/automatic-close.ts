// Automatic closes on the audit chain (finding F4): every alert the platform closes by itself is audited in the same transaction.
import { auditMany, Pool, type Queryable, type Tx } from "../db/db.js";
import { CLOSED_OUTPUT } from "./closed-output.js";

export { CLOSED_OUTPUT };

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
    if (rows.length > 0)
      await auditMany(tx, rows.map(r => ({ actorKind: "system", actorId: by, action: "alert.resolve", targetKind: "alert", targetId: r.id.toLowerCase(),
        outcome: "succeeded", details: { cabinetId: r.cabinet_id.toLowerCase(), resolution: r.resolution, automatic: true } })));
    return rows.map(r => ({ id: r.id, cabinetId: r.cabinet_id }));
  };
  // In the caller's transaction, or a new one when the caller holds only the pool.
  return db instanceof Pool ? db.transaction(run) : run(db as Tx);
}
