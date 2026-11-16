// Lifecycle only. No opening endpoint or relay is installed until grants, step-up and the agent are connected.
import { transaction, type Pool } from "../db/db.js";
import { closeSessionRecord, lockedSessionRecord, touchSessionRecord, type SessionActor, type SessionEnd } from "./session-records.js";

export const SESSION_IDLE_MS = 5 * 60_000;
export const SESSION_MAX_MS = 30 * 60_000;
const system: SessionActor = { actorKind: "system", actorId: "session-lifecycle" };

export function sessionExpiry(opened: Date, seen: Date, now: Date): { end: SessionEnd; reason: string } | null {
  if (now.getTime() - opened.getTime() >= SESSION_MAX_MS)
    return { end: "killed", reason: "Maximum session length reached" };
  if (now.getTime() - seen.getTime() >= SESSION_IDLE_MS)
    return { end: "idle", reason: "Session idle timeout" };
  return null;
}

export class SessionLifecycle {
  constructor(private readonly pool: Pool, private readonly release: (cabinetId: string, sessionId: string) => void) {}

  /** Every exchange re-reads and locks history; closed rows can never become live again. */
  async authorize(cabinetId: string, sessionId: string): Promise<boolean> {
    const allowed = await transaction(this.pool, async tx => {
      const row = await lockedSessionRecord(tx, sessionId);
      if (!row || row.cabinet_id !== cabinetId || row.closed_at) return false;
      const expired = sessionExpiry(row.opened_at, row.last_seen_at, row.now);
      if (expired) {
        await closeSessionRecord(tx, sessionId, expired.end, expired.reason, system);
        return false;
      }
      await touchSessionRecord(tx, sessionId);
      return true;
    });
    if (!allowed) this.release(cabinetId, sessionId);
    return allowed;
  }

  /** Free buffers only after the durable close and its audit commit. Callers authenticate the operator first. */
  async end(sessionId: string, end: "explicit" | "killed" | "error", reason: string, actor: SessionActor): Promise<boolean> {
    const result = await transaction(this.pool, async tx => {
      const row = await lockedSessionRecord(tx, sessionId);
      if (!row) return null;
      const changed = await closeSessionRecord(tx, sessionId, end, reason, actor);
      return { cabinetId: row.cabinet_id, changed };
    });
    if (!result) return false;
    this.release(result.cabinetId, sessionId);
    return result.changed;
  }

  /** Background expiry does not refresh activity. Recheck each row under lock, including after competing frames. */
  async expire(): Promise<number> {
    const candidates = (await this.pool.query<{ id: string }>(`SELECT id FROM remote_sessions WHERE closed_at IS NULL
      AND (last_seen_at <= DATEADD(millisecond, -$1, SYSUTCDATETIME()) OR opened_at <= DATEADD(millisecond, -$2, SYSUTCDATETIME()))`,
    [SESSION_IDLE_MS, SESSION_MAX_MS])).rows;
    let count = 0;
    for (const candidate of candidates) {
      const cabinet = await transaction(this.pool, async tx => {
        const row = await lockedSessionRecord(tx, candidate.id);
        if (!row || row.closed_at) return null;
        const expired = sessionExpiry(row.opened_at, row.last_seen_at, row.now);
        if (!expired) return null;
        await closeSessionRecord(tx, candidate.id, expired.end, expired.reason, system);
        return row.cabinet_id;
      });
      if (cabinet) { this.release(cabinet, candidate.id); count++; }
    }
    return count;
  }
}
