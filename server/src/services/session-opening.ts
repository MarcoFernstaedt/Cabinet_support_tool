import { queueSessionOpen } from "./commands.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { transaction, type Pool } from "../db/db.js";
import { insertSessionRecord, recordSessionRefusal } from "./session-records.js";
import { requireCabinetPermission } from "./user-permissions.js";
import { Refused } from "./errors.js";
import { checkWriteAllowed, pauseOnWriteLimit } from "./writes.js";

export const SESSION_FLEET_CAP = 8;

/** A distinct entry point: generic console/CLI command issuance must never bypass scoped permission. */
export async function openSession(pool: Pool, operatorId: string, cabinetId: string,
  input: { kind: "diagnostic"; reason: string; stepUpToken: string }): Promise<{ sessionId: string }> {
  try {
    return await pauseOnWriteLimit(pool, operatorId, () => transaction(pool, async tx => {
      await requireCabinetPermission(tx, operatorId, cabinetId, "session.open");
      await consumeStepUpToken(tx, input.stepUpToken, operatorId, "session.open", cabinetId);
      await checkWriteAllowed(tx, operatorId, cabinetId);
      // Serializable range locks serialize admissions across all server processes, not just this relay.
      const live = (await tx.query<{ cabinet_id: string }>(
        "SELECT cabinet_id FROM remote_sessions WITH (UPDLOCK, HOLDLOCK) WHERE closed_at IS NULL")).rows;
      if (live.some(row => row.cabinet_id === cabinetId)) throw new Refused("session_live", 409, "a session is already live on this cabinet");
      if (live.length >= SESSION_FLEET_CAP) throw new Refused("session_capacity", 503, "the session fleet limit is reached");
      const sessionId = await insertSessionRecord(tx, { cabinetId, operatorId, kind: input.kind, reason: input.reason });
      await queueSessionOpen(tx, operatorId, cabinetId, sessionId);
      return { sessionId };
    }));
  } catch (error) {
    if (error instanceof Refused) await recordSessionRefusal(pool, { actorKind: "user", actorId: operatorId }, cabinetId, error.code);
    throw error;
  }
}
