import { createHash } from "node:crypto";
import pg from "pg";

export type Queryable = Pick<pg.PoolClient, "query">;

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, statement_timeout: 30_000, idleTimeoutMillis: 30_000 });
  pool.on("error", () => { /* a broken idle connection is dropped and replaced; requests surface their own errors */ });
  return pool;
}

/** Runs fn in one transaction: the action and its audit entry commit or fail together. */
export async function transaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export interface AuditEntry {
  actorKind: "user" | "agent" | "system";
  actorId: string;
  action: string;
  targetKind?: "cabinet" | "site" | "client" | "user" | "enrollment" | "command" | "token" | "alert" | "rule" | "issue_type" | "package" | "security_alert" | "release" | "rollout" | "job" | "known_fix";
  targetId?: string;
  outcome: "succeeded" | "failed" | "refused";
  /** Request details with secrets removed. Callers never put tokens, keys or passwords here. */
  details?: Record<string, unknown>;
}

/** Appends one audit entry inside the caller's transaction, through the insert-only audit function. */
export async function audit(db: Queryable, e: AuditEntry): Promise<number> {
  const r = await db.query<{ seq: string }>("SELECT audit_append($1, $2, $3, $4, $5, $6, $7) AS seq",
    [e.actorKind, e.actorId, e.action, e.targetKind ?? null, e.targetId ?? null, e.outcome, safeJson(e.details ?? {})]);
  return Number(r.rows[0]!.seq);
}

/** JSON for a jsonb column: PostgreSQL cannot store the NUL character, so it is removed from every string. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "string" ? v.replaceAll("\u0000", "") : v));
}

export interface ChainCheck { ok: boolean; entries: number; firstBadSeq?: number; }

/** Recomputes every entry's hash from its stored fields and the previous hash. */
export async function verifyAuditChain(db: Queryable, batch = 10_000): Promise<ChainCheck> {
  // The log is kept forever, so it is read in batches rather than all at once.
  let previous = "0".repeat(64);
  let expectedSeq = 1;
  let entries = 0;
  for (;;) {
    const rows = (await db.query<{ seq: string; input_tail: string; prev_hash: string; hash: string }>(
      `SELECT seq, prev_hash, hash,
              audit_hash_input('', seq, at, actor_kind, actor_id, action, target_kind, target_id, outcome, details) AS input_tail
         FROM audit_log WHERE seq >= $1 ORDER BY seq LIMIT $2`, [expectedSeq, batch])).rows;
    for (const row of rows) {
      const seq = Number(row.seq);
      entries++;
      // The stored input starts with the previous hash; recompute it with the hash this check carried forward.
      const input = previous + row.input_tail;
      const hash = createHash("sha256").update(input, "utf8").digest("hex");
      if (seq !== expectedSeq || row.prev_hash !== previous || row.hash !== hash) return { ok: false, entries, firstBadSeq: seq };
      previous = row.hash;
      expectedSeq++;
    }
    if (rows.length < batch) return { ok: true, entries };
  }
}
