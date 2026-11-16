// Persistence primitives only. Callers must enforce the catalog permission and step-up before inserting a record.
// Opening owns the grant and step-up checks; lifecycle owns every exchange and close.
import { randomUUID } from "node:crypto";
import { audit, notify, type AuditEntry, type Queryable, type Tx } from "../db/db.js";
import { Refused } from "./errors.js";

export type SessionEnd = "explicit" | "idle" | "killed" | "error";
export type SessionActor = Pick<AuditEntry, "actorKind" | "actorId">;
export interface SessionRecord {
  id: string;
  cabinet_id: string;
  operator_id: string;
  kind: string;
  open_reason: string;
  opened_at: Date;
  last_seen_at: Date;
  closed_at: Date | null;
  end_kind: SessionEnd | null;
  close_reason: string | null;
}

function text(value: string, limit: number): void {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new Refused("invalid_session_record", 400, "a bounded, non-empty session kind or reason is required");
}

export async function sessionRecord(db: Queryable, id: string): Promise<SessionRecord | null> {
  return (await db.query<SessionRecord>("SELECT * FROM remote_sessions WHERE id = $1", [id])).rows[0] ?? null;
}

/** Hold the row until its authorization/close transaction commits. Use database time on every server instance. */
export async function lockedSessionRecord(tx: Tx, id: string): Promise<(SessionRecord & { now: Date }) | null> {
  return (await tx.query<SessionRecord & { now: Date }>(
    "SELECT *, SYSUTCDATETIME() AS now FROM remote_sessions WITH (UPDLOCK, HOLDLOCK) WHERE id = $1", [id])).rows[0] ?? null;
}

/** Activity is not a state transition and deliberately adds no per-frame audit row. */
export async function touchSessionRecord(tx: Tx, id: string): Promise<void> {
  await tx.query("UPDATE remote_sessions SET last_seen_at = SYSUTCDATETIME() WHERE id = $1 AND closed_at IS NULL", [id]);
}

/** Insert and audit in the same caller-owned transaction; never use this as an authorization check. */
export async function insertSessionRecord(tx: Tx, input: { cabinetId: string; operatorId: string; kind: string; reason: string }): Promise<string> {
  text(input.kind, 64);
  text(input.reason, 1000);
  const id = randomUUID();
  await tx.query(`INSERT INTO remote_sessions (id, cabinet_id, operator_id, kind, open_reason, opened_at, last_seen_at)
    SELECT $1, $2, $3, $4, $5, t.at, t.at FROM (SELECT SYSUTCDATETIME() AS at) t`,
  [id, input.cabinetId, input.operatorId, input.kind, input.reason]);
  await audit(tx, { actorKind: "user", actorId: input.operatorId, action: "session.open", targetKind: "cabinet", targetId: input.cabinetId,
    outcome: "succeeded", details: { sessionId: id, kind: input.kind, reason: input.reason } });
  return id;
}

/** Idempotent close: a racing or repeated close neither overwrites history nor appends another transition. */
export async function closeSessionRecord(tx: Tx, id: string, end: SessionEnd, reason: string, actor: SessionActor): Promise<boolean> {
  text(reason, 1000);
  if (!["explicit", "idle", "killed", "error"].includes(end)) throw new Refused("invalid_session_record", 400, "unknown session ending");
  const result = await tx.query<{ cabinet_id: string }>(`UPDATE remote_sessions SET closed_at = SYSUTCDATETIME(), end_kind = $2, close_reason = $3
    OUTPUT inserted.cabinet_id WHERE id = $1 AND closed_at IS NULL`, [id, end, reason]);
  if (result.rowCount === 0) return false;
  await audit(tx, { ...actor, action: end === "killed" ? "session.kill" : "session.end", targetKind: "cabinet", targetId: result.rows[0]!.cabinet_id,
    outcome: "succeeded", details: { sessionId: id, end, reason } });
  // The feed delivers only committed rows, so console/jobs closes free every agent worker's buffers too.
  await notify(tx, "sessions_closed", `${result.rows[0]!.cabinet_id}|${id}`);
  return true;
}

/** Refusals commit separately from any failed action, so rolling the action back cannot erase the refusal. */
export async function recordSessionRefusal(db: Queryable, actor: SessionActor, cabinetId: string, reason: string, sessionId?: string): Promise<void> {
  text(reason, 1000);
  await audit(db, { ...actor, action: "session.refused", targetKind: "cabinet", targetId: cabinetId, outcome: "refused",
    details: { ...(sessionId ? { sessionId } : {}), reason } });
}

/** Called only for a failed session.open result, with parameters from the stored command, never from agent output. */
export async function refuseAgentSession(tx: Tx, cabinetId: string, sessionId: string, reason: string): Promise<boolean> {
  const row = await lockedSessionRecord(tx, sessionId);
  if (!row || row.cabinet_id !== cabinetId) throw new Refused("unknown_session", 404, "no such session for this cabinet");
  if (row.closed_at) return false;
  const actor: SessionActor = { actorKind: "agent", actorId: cabinetId };
  await recordSessionRefusal(tx, actor, cabinetId, reason, sessionId);
  await closeSessionRecord(tx, sessionId, "error", reason, actor);
  return true;
}
