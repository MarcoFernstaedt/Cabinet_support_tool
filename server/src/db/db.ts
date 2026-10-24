// The platform database is Microsoft SQL Server (docs/spec/05-server-spec.md). This file is the only place that talks to the driver:
// everything else calls `query(sql, params)` with `$1`-style placeholders and gets `{ rows, rowCount }` back.
import { createHash } from "node:crypto";
import sql from "mssql";
import { JSON_COLUMNS } from "./json-columns.js";

export interface QueryResult<R> { rows: R[]; rowCount: number; }
export interface QueryOptions {
  /** Rows exactly as the driver returns them: no GUID lower-casing, no JSON parsing (the audit chain check hashes stored text). */
  raw?: boolean;
  /** Cancels the statement on the server after this many milliseconds (PostgreSQL's statement_timeout); the query then rejects with a QueryTimeout. */
  timeoutMs?: number;
}
/** A statement stopped because it ran past QueryOptions.timeoutMs. */
export class QueryTimeout extends Error {
  constructor(readonly timeoutMs: number) { super(`the statement was stopped after ${timeoutMs} ms`); this.name = "QueryTimeout"; }
}
export interface Queryable { query<R = any>(text: string, params?: readonly unknown[], options?: QueryOptions): Promise<QueryResult<R>>; }

/** A NULL for a varbinary column (a plain null binds as text, which SQL Server will not convert to binary). */
export const NULL_BINARY: unique symbol = Symbol("NULL_BINARY");


/** True when the text holds one statement: no semicolon outside quotes except a trailing one. */
export function singleStatement(text: string): boolean {
  let inString = false;
  const t = text.trimEnd().replace(/;$/, "");
  for (const ch of t) {
    if (ch === "'") inString = !inString;
    else if (ch === ";" && !inString) return false;
  }
  return true;
}

/** `$1` becomes `@p1`; text inside single quotes is left alone. */
export function placeholders(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    // A -- comment runs to the end of its line, untouched: an apostrophe in it is not a string.
    if (!inString && ch === "-" && text[i + 1] === "-") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += text.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (ch === "'") inString = !inString;
    if (!inString && ch === "$" && /\d/.test(text[i + 1] ?? "")) { out += "@p"; continue; }
    out += ch;
  }
  return out;
}

/** The value as a driver parameter: JavaScript types map to fixed SQL types, so a plan never depends on the value's content. */
function bind(request: sql.Request, index: number, value: unknown): void {
  const name = `p${index + 1}`;
  if (value === NULL_BINARY) request.input(name, sql.VarBinary(sql.MAX), null);
  else if (value === null || value === undefined) request.input(name, sql.NVarChar(sql.MAX), null);
  else if (typeof value === "boolean") request.input(name, sql.Bit, value);
  else if (typeof value === "number") {
    if (Number.isInteger(value)) request.input(name, Math.abs(value) < 2_147_483_648 ? sql.Int : sql.BigInt, value);
    else request.input(name, sql.Float, value);
  } else if (typeof value === "bigint") request.input(name, sql.BigInt, value);
  else if (value instanceof Date) request.input(name, sql.DateTime2(3), value);
  else if (Buffer.isBuffer(value)) request.input(name, sql.VarBinary(sql.MAX), value);
  else if (typeof value === "string") request.input(name, sql.NVarChar(value.length > 4000 ? sql.MAX : 4000), value); // two sizes only, so one cached plan per statement
  else request.input(name, sql.NVarChar(sql.MAX), safeJson(value));
}

/**
 * What the rest of the code expects: uniqueidentifier columns in lower case, and JSON columns as values rather than text. Decided by the
 * column's SQL type, never by what the text looks like: a name or an audit field that happens to look like a GUID stays as it was stored.
 */
function shape<R>(rows: Record<string, unknown>[], columns: sql.IColumnMetadata | undefined): R[] {
  const meta = columns as unknown as Record<string, { type?: unknown }> | undefined;
  const guid = new Set<string>(), json = new Set<string>();
  for (const [name, c] of Object.entries(meta ?? {})) {
    if (c.type === sql.UniqueIdentifier) guid.add(name);
    else if (JSON_COLUMNS.has(name) && (c.type === sql.NVarChar || c.type === sql.NChar || c.type === sql.VarChar)) json.add(name);
  }
  if (guid.size === 0 && json.size === 0) return rows as R[];
  for (const row of rows) {
    for (const key of guid) { const v = row[key]; if (typeof v === "string") row[key] = v.toLowerCase(); }
    for (const key of json) {
      const v = row[key];
      if (typeof v === "string" && (key === "value" || v.startsWith("{") || v.startsWith("["))) { try { row[key] = JSON.parse(v); } catch { /* not JSON: left as text */ } }
    }
  }
  return rows as R[];
}

/** The driver's own per-statement limit (the pool's requestTimeout) must not cut a statement short of the limit its caller gave. */
const overrides = (options?: QueryOptions): { requestTimeout: number } | undefined =>
  options?.timeoutMs && options.timeoutMs >= DEFAULT_REQUEST_TIMEOUT_MS ? { requestTimeout: options.timeoutMs + 1_000 } : undefined;

async function run<R>(make: (conf?: { requestTimeout: number }) => sql.Request, text: string, params: readonly unknown[], options?: QueryOptions): Promise<QueryResult<R>> {
  const request = make(overrides(options));
  params.forEach((v, i) => bind(request, i, v));
  let timedOut = false;
  const timer = options?.timeoutMs ? setTimeout(() => { timedOut = true; request.cancel(); }, options.timeoutMs) : undefined;
  let result: sql.IResult<any>;
  try { result = await request.query(placeholders(text)); }
  catch (e) { throw timedOut ? new QueryTimeout(options!.timeoutMs!) : e; }
  finally { clearTimeout(timer); }
  const recordset = (result.recordset ?? []) as Record<string, unknown>[];
  const rows = options?.raw ? recordset as R[] : shape<R>(recordset, result.recordset?.columns);
  return { rows, rowCount: result.recordset ? rows.length : result.rowsAffected.reduce((a, b) => a + b, 0) };
}

/** A transaction in progress: the same `query`, on one connection. */
export class Tx implements Queryable {
  constructor(private readonly tx: sql.Transaction) {}
  query<R = any>(text: string, params: readonly unknown[] = [], options?: QueryOptions): Promise<QueryResult<R>> {
    // mssql 12 takes per-request overrides ({ requestTimeout }); its type definitions do not list them yet.
    return run<R>(conf => new (sql.Request as unknown as new (parent: sql.Transaction, conf?: { requestTimeout: number }) => sql.Request)(this.tx, conf), text, params, options);
  }
}

export class Pool implements Queryable {
  /** When each waiting request asked for a connection, and the longest wait that ended in the current and the previous second. */
  private readonly asked = new Map<number, number>();
  private waited = [0, 0];
  private waitedSecond = 0;
  constructor(private readonly pool: sql.ConnectionPool) {
    // tarn (inside mssql) announces each request for a connection and its outcome.
    const tarn = (pool as unknown as { pool?: { on(event: string, f: (id: number) => void): void } }).pool;
    const ended = (id: number): void => {
      const at = this.asked.get(id);
      if (at === undefined) return;
      this.asked.delete(id);
      this.rollWaits();
      this.waited[1] = Math.max(this.waited[1]!, Date.now() - at);
    };
    tarn?.on("acquireRequest", id => { this.asked.set(id, Date.now()); });
    tarn?.on("acquireSuccess", ended);
    tarn?.on("acquireFail", ended);
  }
  private rollWaits(): void {
    const second = Math.floor(Date.now() / 1000);
    if (second === this.waitedSecond) return;
    this.waited = second === this.waitedSecond + 1 ? [this.waited[1]!, 0] : [0, 0];
    this.waitedSecond = second;
  }
  /**
   * How long requests are waiting for a connection: the longest wait that ended in the last second or two, or the age of the oldest
   * request still waiting. A long queue of 1 ms statements clears at once; a wait this long means the database is not keeping up.
   */
  get waitMs(): number {
    this.rollWaits();
    let oldest = 0;
    const now = Date.now();
    for (const at of this.asked.values()) { oldest = now - at; break; } // Map keeps insertion order: the first is the oldest
    return Math.max(this.waited[0]!, this.waited[1]!, oldest);
  }
  /**
   * One statement outside a transaction. SQL Server may pick it as a deadlock victim; it was rolled back whole, so it is run again (up to
   * three times). A batch of several statements is not retried: the ones before the victim have already committed.
   */
  async query<R = any>(text: string, params: readonly unknown[] = [], options?: QueryOptions): Promise<QueryResult<R>> {
    const retryable = singleStatement(text);
    for (let attempt = 1; ; attempt++) {
      try { return await run<R>(conf => (this.pool.request as (conf?: { requestTimeout: number }) => sql.Request).call(this.pool, conf), text, params, options); }
      catch (e) { if (!retryable || !isDeadlock(e) || attempt >= 3) throw e; }
    }
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
  /** Requests waiting for a free connection (tarn's numPendingAcquires): the first sign that the database cannot keep up. */
  get pending(): number { return this.pool.pending; }
}

/**
 * A Queryable whose statements are stopped once the whole operation has run for ms milliseconds (console queries that read the whole
 * fleet: rule preview, audit search, evidence export, drives at risk). The statement that runs out rejects with QueryTimeout.
 */
export function limited(db: Queryable, ms: number): Queryable {
  const started = Date.now();
  return {
    query<R = any>(text: string, params?: readonly unknown[], options?: QueryOptions): Promise<QueryResult<R>> {
      const left = ms - (Date.now() - started);
      if (left <= 0) return Promise.reject(new QueryTimeout(ms));
      return db.query<R>(text, params, { ...options, timeoutMs: Math.min(options?.timeoutMs ?? left, left) });
    },
  };
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

/** Every statement is stopped by the driver after this long unless its caller allows longer (QueryOptions.timeoutMs). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Statements on the agent hot path (authenticate, take commands, heartbeat) give up after this long: the agent retries later. */
export const HOT_PATH_TIMEOUT_MS = 3_000;

export interface PoolOptions {
  max?: number;
  /** Connections kept open while idle (default 4, at most max). */
  min?: number;
  /** How long a request waits for a free connection before it fails (default 3 s: fail fast rather than queue without end). */
  acquireTimeoutMs?: number;
  /** The driver's limit on one statement (default 10 s). */
  requestTimeoutMs?: number;
}

export async function createPool(connectionString: string, options: number | PoolOptions = 10): Promise<Pool> {
  const o: PoolOptions = typeof options === "number" ? { max: options } : options;
  const max = o.max ?? 10;
  const pool = new sql.ConnectionPool({ ...parseDatabaseUrl(connectionString), requestTimeout: o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    pool: { max, min: Math.min(o.min ?? 4, max), idleTimeoutMillis: 30_000, acquireTimeoutMillis: o.acquireTimeoutMs ?? 3_000 } });
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
/** What may be logged about an error: its kind, the driver's code and SQL Server's error number. Never the message, which can carry data. */
export function errorInfo(e: unknown): { type: string; code?: string; number?: number } {
  const x = e as { name?: string; code?: unknown; number?: unknown; constructor?: { name?: string } } | null;
  // Some libraries leave name as "Error" (tarn's pool TimeoutError), so the class name is used when it says more.
  const type = x?.name && x.name !== "Error" ? x.name : x?.constructor?.name && x.constructor.name !== "Object" ? x.constructor.name : x?.name ?? typeof e;
  return { type, ...(typeof x?.code === "string" ? { code: x.code } : {}), ...(typeof x?.number === "number" ? { number: x.number } : {}) };
}
/**
 * The database is too busy or briefly unavailable: no free connection within the acquire limit, a statement stopped by its time
 * limit, a dropped or refused connection, or a deadlock that outlived its retries.
 * The agent API answers these with 503 and a Retry-After rather than an error.
 */
export function isBusy(e: unknown, depth = 0): boolean {
  if (e instanceof QueryTimeout) return true;
  const x = e as { code?: string; name?: string; constructor?: { name?: string }; originalError?: unknown } | null;
  if (!x || typeof x !== "object" || depth > 3) return false;
  if (x.constructor?.name === "TimeoutError" || x.name === "TimeoutError") return true; // tarn: no connection within acquireTimeoutMillis
  if (x.code === "ETIMEOUT") return true; // the driver's requestTimeout
  // The database is unreachable or dropped the connection, or the pool is closing: transient, the caller tries again later.
  if (x.code === "ESOCKET" || x.code === "ECONNCLOSED" || x.code === "ENOTOPEN" || x.code === "ECONNRESET" || x.code === "EINSTLOOKUP") return true;
  if (isDeadlock(x) || x.name === "LockDeadlock") return true; // a deadlock victim still losing after its retries
  return x.originalError !== undefined && isBusy(x.originalError, depth + 1);
}

/** Wakes the other server processes (and this one) listening on a channel; see the notifications table and src/db/notifications.ts. */
export async function notify(db: Queryable, channel: string, payload: string): Promise<void> {
  await db.query("INSERT INTO notifications (channel, payload) VALUES ($1, $2)", [channel, payload.slice(0, 450)]);
}

export function transaction<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> { return pool.transaction(fn); }

/** How long lock() waits for a named lock before giving up. */
export const LOCK_TIMEOUT_MS = 5_000;

/** sp_getapplock chose this transaction as the victim of a deadlock between named locks: retryable like SQL Server's own deadlock (1205). */
export class LockDeadlock extends Error {
  readonly number = 1205;
  constructor(name: string) { super(`deadlock while waiting for the lock ${name}`); this.name = "LockDeadlock"; }
}

/**
 * Serializes a section of work by name until the transaction ends (replaces PostgreSQL's advisory locks). Waits at most LOCK_TIMEOUT_MS.
 * A deadlock (sp_getapplock returns -3) is reported as one, so transaction() runs the work again.
 */
export async function lock(db: Queryable, name: string): Promise<void> {
  try {
    await db.query(`DECLARE @r int; EXEC @r = sp_getapplock @Resource = $1, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = ${LOCK_TIMEOUT_MS};
                    IF @r = -3 THROW 50003, 'deadlock while waiting for the lock', 1; IF @r < 0 THROW 50001, 'could not take the lock', 1;`, [name]);
  } catch (e) {
    if (numberOf(e) === 50003) throw new LockDeadlock(name);
    throw e;
  }
}

export interface AuditEntry {
  actorKind: "user" | "agent" | "system";
  actorId: string;
  action: string;
  targetKind?: "cabinet" | "site" | "client" | "user" | "enrollment" | "command" | "token" | "alert" | "rule" | "issue_type" | "package" | "security_alert" | "release" | "rollout" | "job" | "known_fix" | "runbook" | "case_note" | "diagnosis" | "baseline";
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

/**
 * Appends several audit entries in one call, in order, inside the caller's transaction (audit_append_many chains them on the server with
 * the same hash as audit_append). Returns their sequence numbers.
 */
export async function auditMany(db: Queryable, entries: readonly AuditEntry[]): Promise<number[]> {
  if (entries.length === 0) return [];
  const list = entries.map(e => ({ actorKind: e.actorKind, actorId: e.actorId, action: e.action, targetKind: e.targetKind ?? null, targetId: e.targetId ?? null,
    outcome: e.outcome, details: safeJson(e.details ?? {}) }));
  const r = await db.query<{ first: string | null; last: string | null }>(
    "DECLARE @first bigint, @last bigint; EXEC audit_append_many $1, @first OUTPUT, @last OUTPUT; SELECT @first AS [first], @last AS [last];", [safeJson(list)]);
  const first = Number(r.rows[0]!.first), last = Number(r.rows[0]!.last);
  if (last - first + 1 !== entries.length) throw new Error("the audit log did not take every entry");
  return entries.map((_, i) => first + i);
}

/** JSON text for a column: the NUL character is removed from every string so the stored text is always plain. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "string" ? v.replaceAll("\u0000", "") : v));
}

/**
 * firstBadSeq is the earliest broken entry; badSeqs lists up to 100 of them, so damage after the first break is still found. A check that
 * went on from a checkpoint says from which entry (fromSeq) it started; entries counts what it checked. A check stopped by maxEntries says
 * so with more: true, and its lastSeq/lastHash are the tail it reached. behindHead says the chain ends before the anchored high-water mark:
 * entries at the end of the log are gone (deleted, or the log was restored from an older copy), which the chain's own hashes cannot show.
 */
export interface ChainCheck { ok: boolean; entries: number; firstBadSeq?: number; badSeqs?: number[]; fromSeq?: number; lastSeq?: number; lastHash?: string; more?: boolean; behindHead?: boolean; headSeq?: number;
  /** An answer that was not a new walk: it comes from a check that was already running, or from the one that just ran. */
  reused?: boolean; }

/** Where the last successful check ended (seq 0 and the all-zero hash before any). */
export interface ChainCheckpoint { seq: number; hash: string; }

/** The high-water mark the append path keeps, independent of the log: nothing the application's role does can move it back. */
export type ChainHead = ChainCheckpoint;

/**
 * Reads the anchored high-water mark. It lives in audit_chain_head, which the application's role may not read, so the only way to it is the
 * audit_head procedure (same owner, ownership chaining). A database that has not been migrated to it yet has no such procedure: the
 * statement then returns no row and null comes back, so verification goes on as before and the caller can see that there is no anchor.
 */
export async function auditChainHeadAnchor(db: Queryable): Promise<ChainHead | null> {
  const r = (await db.query<{ seq: string | null; hash: string | null }>(
    `IF OBJECT_ID('audit_head', 'P') IS NULL
       SELECT CAST(NULL AS bigint) AS [seq], CAST(NULL AS nvarchar(64)) AS [hash];
     ELSE
       EXEC audit_head;`, [], { raw: true })).rows[0];
  return r?.seq !== null && r?.seq !== undefined && typeof r.hash === "string" ? { seq: Number(r.seq), hash: r.hash } : null;
}


export async function auditCheckpoint(db: Queryable): Promise<ChainCheckpoint> {
  const r = (await db.query<{ seq: string; hash: string }>("SELECT [seq], [hash] FROM audit_checkpoint WHERE id = 1", [], { raw: true })).rows[0];
  return r ? { seq: Number(r.seq), hash: r.hash } : { seq: 0, hash: "0".repeat(64) };
}

/** Moves the checkpoint forward to a verified entry (the procedure refuses an entry that does not exist with that hash). */
export async function advanceAuditCheckpoint(db: Queryable, to: ChainCheckpoint): Promise<void> {
  await db.query("EXEC audit_checkpoint_advance $1, $2", [to.seq, to.hash]);
}

/** The text each entry's hash covers: the previous hash and the entry's own stored fields, joined by the unit separator. */
export function auditHashInput(prev: string, r: { seq: string | number; at_text: string; actor_kind: string; actor_id: string; action: string; target_kind: string | null; target_id: string | null; outcome: string; details_raw: string }): string {
  return [prev, String(r.seq), r.at_text, r.actor_kind, r.actor_id, r.action, r.target_kind ?? "", r.target_id ?? "", r.outcome, r.details_raw].join("\u001f");
}

/** How a check is bounded and anchored; both are optional, so a plain check is the whole-log one it always was. */
export interface ChainVerifyOptions {
  /** Stops after this many entries, so one request never walks a large log in one go; the result then says more: true. */
  maxEntries?: number;
  /** The anchored high-water mark (auditChainHeadAnchor) to compare the tail reached with; null when there is none. */
  head?: ChainHead | null;
}

/**
 * Recomputes every entry's hash from its stored fields and the previous hash. With `from` (a checkpoint), only the entries after it are
 * checked, starting from the checkpoint's hash; the checkpoint entry itself must still carry that hash. With `maxEntries` the walk stops
 * there and says more: true, so a large log is never walked in one go. With `head` the tail reached is compared with the append path's own
 * high-water mark: a hash chain that ends before it is a chain whose last entries are gone, which its own hashes cannot show.
 */
export async function verifyAuditChain(db: Queryable, batch = 10_000, from?: ChainCheckpoint, o: ChainVerifyOptions = {}): Promise<ChainCheck> {
  // The log is kept forever, so it is read in batches rather than all at once.
  const max = o.maxEntries !== undefined && o.maxEntries > 0 ? Math.trunc(o.maxEntries) : undefined;
  const head = o.head ?? null;
  let previous = from?.hash ?? "0".repeat(64);
  let expectedSeq = (from?.seq ?? 0) + 1;
  let entries = 0;
  const bad: number[] = [];
  if (from && from.seq > 0) {
    const anchor = (await db.query<{ hash: string }>("SELECT [hash] FROM audit_log WHERE seq = $1", [from.seq], { raw: true })).rows[0];
    if (anchor?.hash !== from.hash) bad.push(from.seq);
  }
  const done = (more = false): ChainCheck => {
    const tail = { fromSeq: (from?.seq ?? 0) + 1, lastSeq: expectedSeq - 1, lastHash: previous };
    // A walk that stopped at the limit has not reached the end of the log, so the anchored mark says nothing about where it did stop.
    const behindHead = !more && head !== null && tail.lastSeq < head.seq;
    const check: ChainCheck = { ok: bad.length === 0 && !behindHead, entries, ...tail };
    if (more) check.more = true;
    if (head !== null) check.headSeq = head.seq;
    if (behindHead) check.behindHead = true;
    if (bad.length || behindHead) { check.firstBadSeq = bad[0] ?? tail.lastSeq + 1; check.badSeqs = bad; }
    return check;
  };
  for (;;) {
    const rows = (await db.query<{ seq: string; at_text: string; actor_kind: string; actor_id: string; action: string; target_kind: string | null; target_id: string | null; outcome: string; details_raw: string; prev_hash: string; hash: string }>(
      `SELECT TOP (${Math.trunc(batch)}) seq, CONVERT(varchar(27), at, 126) AS at_text, actor_kind, actor_id, action, target_kind, target_id, outcome, details AS details_raw, prev_hash, hash
         FROM audit_log WHERE seq >= $1 ORDER BY seq`, [expectedSeq], { raw: true })).rows;
    for (const row of rows) {
      if (max !== undefined && entries >= max) return done(true);
      const seq = Number(row.seq);
      entries++;
      // SQL Server hashes the UTF-16 bytes of the text, so the same is done here.
      const hash = createHash("sha256").update(auditHashInput(previous, row), "utf16le").digest("hex");
      // A break is recorded and the check goes on from the stored hash, so a later, separate change is reported too.
      if (seq !== expectedSeq || row.prev_hash !== previous || row.hash !== hash) { if (bad.length < 100) bad.push(seq); }
      previous = row.hash;
      expectedSeq = seq + 1;
    }
    if (rows.length < batch) return done(false);
    if (max !== undefined && entries >= max) return done(true);
  }
}
