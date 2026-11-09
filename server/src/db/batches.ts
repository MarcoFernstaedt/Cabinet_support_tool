// Running one changing statement in batches, each with its own audit entry, and the cut-off a retention prune takes (F21.R2, decision-log
// D71, D73). This module imports nothing but db.ts: the tables' owners import their prunes' helpers from here, never from maintenance.ts,
// so a prune never puts an owner in an import cycle with the retention run.
import { audit, Pool, transaction, type Queryable } from "./db.js";

export interface BatchOptions {
  /** Rows per statement. */
  batch: number;
  /** Pause between two statements, so the agents' writes get their turn. */
  pauseMs: number;
  /** Each statement is stopped after this long (it has then changed nothing; the next run goes on). */
  timeoutMs: number;
}
export const RETENTION_BATCH: BatchOptions = { batch: 4_000, pauseMs: 200, timeoutMs: 30_000 };

const sleep = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

/** What a destructive batch leaves in the audit log beside the statement it just made (docs/spec/05-server-spec.md "Retention"). */
export interface BatchAudit {
  /** The table the statement changes, as the log entry names it. */
  table: string;
  /** The cut-off the batch used, so the entry says what it considered old. */
  cutoff?: unknown;
  /** The audit action; a retention batch by default. */
  action?: string;
}

/**
 * Runs one statement that changes at most `TOP (@batch)` rows (it must say `TOP ($1)`; its own parameters follow from $2) again and again,
 * each in its own autocommit transaction, until a run changes fewer rows than a batch. Returns how many rows it changed in all.
 * With `each`, a batch that changes anything runs in one transaction together with its own audit entry, so a run that stops half way (or is
 * killed) has left the log saying what it had already removed; a batch that changes nothing writes nothing.
 */
export async function inBatches(db: Queryable, statement: string, params: readonly unknown[], o: BatchOptions = RETENTION_BATCH, each?: BatchAudit): Promise<number> {
  const one = async (c: Queryable): Promise<number> => {
    const n = (await c.query(statement, [o.batch, ...params], { timeoutMs: o.timeoutMs })).rowCount ?? 0;
    if (each && n > 0)
      await audit(c, { actorKind: "system", actorId: "retention", action: each.action ?? "retention.batch", outcome: "succeeded",
        details: { table: each.table, rows: n, ...(each.cutoff === undefined ? {} : { cutoff: each.cutoff }) } });
    return n;
  };
  let total = 0;
  for (;;) {
    const n = each === undefined ? await one(db) : db instanceof Pool ? await transaction(db, one) : await one(db);
    total += n;
    if (n < o.batch) return total;
    await sleep(o.pauseMs);
  }
}

/**
 * A retention cut-off as each owner's prune takes it (F21.R2, decision-log D71): a real time, not in the future. A prune only ever removes
 * rows older than it, so running one again removes nothing more.
 */
export function checkRetentionCutoff(cutoff: unknown): asserts cutoff is Date {
  if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime()) || cutoff.getTime() > Date.now()) throw new Error("a retention cut-off is a time that has already passed");
}
