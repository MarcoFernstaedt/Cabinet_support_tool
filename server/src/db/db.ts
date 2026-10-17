// The platform database is Microsoft SQL Server (docs/spec/05-server-spec.md). This file is the only place that talks to the driver:
// everything else calls `query(sql, params)` with `$1`-style placeholders and gets `{ rows, rowCount }` back.
import { createHash } from "node:crypto";
import sql from "mssql";
import { JSON_COLUMNS } from "./json-columns.js";

export interface QueryResult<R> { rows: R[]; rowCount: number; }
export interface Queryable { query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>; }

const GUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

/** `$1` becomes `@p1`; text inside single quotes is left alone. */
export function placeholders(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") inString = !inString;
    if (!inString && ch === "$" && /\d/.test(text[i + 1] ?? "")) { out += "@p"; continue; }
    out += ch;
  }
  return out;
}

/** The value as a driver parameter: JavaScript types map to fixed SQL types, so a plan never depends on the value's content. */
function bind(request: sql.Request, index: number, value: unknown): void {
  const name = `p${index + 1}`;
  if (value === null || value === undefined) request.input(name, sql.NVarChar(sql.MAX), null);
  else if (typeof value === "boolean") request.input(name, sql.Bit, value);
  else if (typeof value === "number") {
    if (Number.isInteger(value)) request.input(name, Math.abs(value) < 2_147_483_648 ? sql.Int : sql.BigInt, value);
    else request.input(name, sql.Float, value);
  } else if (typeof value === "bigint") request.input(name, sql.BigInt, value);
  else if (value instanceof Date) request.input(name, sql.DateTime2(3), value);
  else if (Buffer.isBuffer(value)) request.input(name, sql.VarBinary(sql.MAX), value);
  else if (typeof value === "string") request.input(name, sql.NVarChar(value.length > 4000 ? sql.MAX : Math.max(1, value.length)), value);
  else request.input(name, sql.NVarChar(sql.MAX), safeJson(value));
}

/** What the rest of the code expects: GUIDs in lower case, and JSON columns as values rather than text. */
function shape<R>(rows: Record<string, unknown>[]): R[] {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const v = row[key];
      if (typeof v !== "string") continue;
      if (GUID.test(v)) row[key] = v.toLowerCase();
      else if (JSON_COLUMNS.has(key) && (key === "value" || v.startsWith("{") || v.startsWith("["))) { try { row[key] = JSON.parse(v); } catch { /* not JSON: left as text */ } }
    }
  }
  return rows as R[];
}

async function run<R>(make: () => sql.Request, text: string, params: readonly unknown[]): Promise<QueryResult<R>> {
  const request = make();
  params.forEach((v, i) => bind(request, i, v));
  const result = await request.query(placeholders(text));
  const rows = shape<R>((result.recordset ?? []) as Record<string, unknown>[]);
  return { rows, rowCount: result.recordset ? rows.length : result.rowsAffected.reduce((a, b) => a + b, 0) };
}

/** A transaction in progress: the same `query`, on one connection. */
export class Tx implements Queryable {
  constructor(private readonly tx: sql.Transaction) {}
  query<R = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    return run<R>(() => new sql.Request(this.tx), text, params);
  }
}

export class Pool implements Queryable {
  constructor(private readonly pool: sql.ConnectionPool) {}
  query<R = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    return run<R>(() => this.pool.request(), text, params);
  }
  /**
   * Runs fn in one transaction: the action and its audit entry commit or fail together. If SQL Server picks the transaction as a
   * deadlock victim it is rolled back and run again (up to three times), so fn must not change anything outside the database.
   */
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const tx = new sql.Transaction(this.pool);
      await tx.begin();
      try {
        const result = await fn(new Tx(tx));
        await tx.commit();
        return result;
      } catch (e) {
        await tx.rollback().catch(() => undefined);
        if (!isDeadlock(e) || attempt >= 3) throw e;
      }
    }
  }
  end(): Promise<void> { return this.pool.close(); }
}

/** `sqlserver://user:password@host:1433/database?encrypt=true&trustServerCertificate=false` */
export function parseDatabaseUrl(connectionString: string): sql.config {
  const u = new URL(connectionString);
  if (u.protocol !== "sqlserver:") throw new Error("The database URL must start with sqlserver://");
  const flag = (name: string, fallback: boolean) => { const v = u.searchParams.get(name); return v === null ? fallback : v === "true"; };
  return {
    server: decodeURIComponent(u.hostname), port: u.port ? Number(u.port) : 1433, database: decodeURIComponent(u.pathname.slice(1)) || "master",
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    options: { encrypt: flag("encrypt", true), trustServerCertificate: flag("trustServerCertificate", false), useUTC: true, enableArithAbort: true },
    requestTimeout: 30_000,
  };
}

export async function createPool(connectionString: string, max = 10): Promise<Pool> {
  const pool = new sql.ConnectionPool({ ...parseDatabaseUrl(connectionString), pool: { max, min: 0, idleTimeoutMillis: 30_000 } });
  pool.on("error", () => { /* a broken idle connection is dropped and replaced; requests surface their own errors */ });
  await pool.connect();
  return new Pool(pool);
}

const numberOf = (e: unknown): number | undefined => (e as { number?: number } | null)?.number;
/** A UNIQUE or PRIMARY KEY rule refused the row (PostgreSQL's 23505). */
export const isUniqueViolation = (e: unknown): boolean => numberOf(e) === 2601 || numberOf(e) === 2627;
/** A FOREIGN KEY or CHECK rule refused the row (23503 and 23514). */
export const isConstraintViolation = (e: unknown): boolean => numberOf(e) === 547;
export const isDeadlock = (e: unknown): boolean => numberOf(e) === 1205;

/** Wakes the other server processes (and this one) listening on a channel; see the notifications table and src/db/notifications.ts. */
export async function notify(db: Queryable, channel: string, payload: string): Promise<void> {
  await db.query("INSERT INTO notifications (channel, payload) VALUES ($1, $2)", [channel, payload.slice(0, 450)]);
}

export function transaction<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> { return pool.transaction(fn); }

/** Serializes a section of work by name until the transaction ends (replaces PostgreSQL's advisory locks). */
export async function lock(db: Queryable, name: string): Promise<void> {
  await db.query("DECLARE @r int; EXEC @r = sp_getapplock @Resource = $1, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 30000; IF @r < 0 THROW 50001, 'could not take the lock', 1;", [name]);
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

/** Appends one audit entry inside the caller's transaction, through the insert-only audit procedure. */
export async function audit(db: Queryable, e: AuditEntry): Promise<number> {
  const r = await db.query<{ seq: string }>("DECLARE @seq bigint; EXEC audit_append $1, $2, $3, $4, $5, $6, $7, @seq OUTPUT; SELECT @seq AS seq;",
    [e.actorKind, e.actorId, e.action, e.targetKind ?? null, e.targetId ?? null, e.outcome, safeJson(e.details ?? {})]);
  return Number(r.rows[0]!.seq);
}

/** JSON text for a column: the NUL character is removed from every string so the stored text is always plain. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "string" ? v.replaceAll("\u0000", "") : v));
}

export interface ChainCheck { ok: boolean; entries: number; firstBadSeq?: number; }

/** The text each entry's hash covers: the previous hash and the entry's own stored fields, joined by the unit separator. */
export function auditHashInput(prev: string, r: { seq: string | number; at_text: string; actor_kind: string; actor_id: string; action: string; target_kind: string | null; target_id: string | null; outcome: string; details_raw: string }): string {
  return [prev, String(r.seq), r.at_text, r.actor_kind, r.actor_id, r.action, r.target_kind ?? "", r.target_id ?? "", r.outcome, r.details_raw].join("\u001f");
}

/** Recomputes every entry's hash from its stored fields and the previous hash. */
export async function verifyAuditChain(db: Queryable, batch = 10_000): Promise<ChainCheck> {
  // The log is kept forever, so it is read in batches rather than all at once.
  let previous = "0".repeat(64);
  let expectedSeq = 1;
  let entries = 0;
  for (;;) {
    const rows = (await db.query<{ seq: string; at_text: string; actor_kind: string; actor_id: string; action: string; target_kind: string | null; target_id: string | null; outcome: string; details_raw: string; prev_hash: string; hash: string }>(
      `SELECT TOP (${Math.trunc(batch)}) seq, CONVERT(varchar(27), at, 126) AS at_text, actor_kind, actor_id, action, target_kind, target_id, outcome, details AS details_raw, prev_hash, hash
         FROM audit_log WHERE seq >= $1 ORDER BY seq`, [expectedSeq])).rows;
    for (const row of rows) {
      const seq = Number(row.seq);
      entries++;
      // SQL Server hashes the UTF-16 bytes of the text, so the same is done here.
      const hash = createHash("sha256").update(auditHashInput(previous, row), "utf16le").digest("hex");
      if (seq !== expectedSeq || row.prev_hash !== previous || row.hash !== hash) return { ok: false, entries, firstBadSeq: seq };
      previous = row.hash;
      expectedSeq++;
    }
    if (rows.length < batch) return { ok: true, entries };
  }
}
