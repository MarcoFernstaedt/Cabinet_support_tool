// One writer per background job across server instances (F21.R1, decision-log D49). Inside one host the primary process already runs the
// jobs alone (main.ts, node:cluster); with two instances on two hosts every job would run twice. Each job is leased by name in job_leases:
// an instance runs a job only while it holds its lease, renews it every run, and another instance takes it over only once the holder has
// stopped renewing and the lease has run out. Taking and renewing is one statement under a key-range lock, so two instances asking at the
// same moment cannot both get it.
import { randomUUID } from "node:crypto";
import type { Pool, Queryable } from "../db/db.js";

/** This process's name as a lease holder. */
export const INSTANCE_ID = `${process.pid}-${randomUUID()}`;

/**
 * Takes or renews the lease on `name` for `ms` milliseconds: true when this holder now holds it (it was free, had run out, or was already
 * this holder's), false when another holder's lease is still running.
 */
export async function takeLease(db: Queryable, name: string, ms: number, holder: string = INSTANCE_ID): Promise<boolean> {
  const r = await db.query<{ act: string }>(
    `DECLARE @o TABLE (act nvarchar(10));
     MERGE job_leases WITH (HOLDLOCK) AS t
     USING (SELECT CAST($1 AS nvarchar(64)) AS name) AS s ON t.name = s.name
      WHEN MATCHED AND (t.holder = $2 OR t.until < SYSUTCDATETIME())
        THEN UPDATE SET holder = $2, until = DATEADD(millisecond, $3, SYSUTCDATETIME()), taken_at = CASE WHEN t.holder = $2 THEN t.taken_at ELSE SYSUTCDATETIME() END
      WHEN NOT MATCHED THEN INSERT (name, holder, until) VALUES ($1, $2, DATEADD(millisecond, $3, SYSUTCDATETIME()))
      OUTPUT $action INTO @o (act);
     SELECT act FROM @o;`, [name, holder, Math.max(1_000, Math.floor(ms))]);
  return r.rows.length > 0;
}

/**
 * A job that runs only while this instance holds its lease. The lease lasts `ms`, longer than the job's interval so the holder keeps it
 * from run to run; if the holder stops (crash, shutdown), another instance's next run takes it over after at most `ms`. A failure to
 * read the lease is "not held": the job is skipped this time, never run by two.
 */
export function leased(db: Queryable, name: string, ms: number, job: () => Promise<unknown> | void, holder: string = INSTANCE_ID): () => Promise<boolean> {
  return async () => {
    if (!(await takeLease(db, name, ms, holder).catch(() => false))) return false;
    await job();
    return true;
  };
}

/** Fence every statement/transaction, including verification reads and writes, with the owner's lease row lock.
 * Renewal cannot resurrect an expired owner. Holding the lock until commit prevents takeover during a write.
 * No transaction or connection is held while waiting for a cabinet. */
export function ownedPool(pool: Pool, name: string, holder: string, ms: number): Pool {
  const guarded: Pool["transaction"] = fn => pool.transaction(async c => {
    const held = await c.query(
      `UPDATE job_leases WITH (UPDLOCK, HOLDLOCK) SET until = DATEADD(millisecond, $3, SYSUTCDATETIME())
        OUTPUT inserted.name WHERE name = $1 AND holder = $2 AND until > SYSUTCDATETIME()`,
      [name, holder, ms]);
    if (held.rows.length === 0) throw new Error("job ownership expired or was lost");
    return fn(c);
  });
  const query: Pool["query"] = (text, params, options) => guarded(c => c.query(text, params, options));
  return new Proxy(pool, { get(target, key) {
    if (key === "query") return query;
    if (key === "transaction") return guarded;
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
