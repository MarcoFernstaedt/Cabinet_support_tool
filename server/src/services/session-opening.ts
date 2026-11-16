import { createHash } from "node:crypto";
import { audit } from "../db/db.js";
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
  input: { kind: "diagnostic" | "shell"; reason: string; stepUpToken: string }): Promise<{ sessionId: string }> {
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
      if (input.kind === "shell") {
        const capable = (await tx.query("SELECT id FROM cabinets WHERE id = $1 AND development_shell = 1 AND read_only = 0 AND last_heartbeat_at > DATEADD(minute, -10, SYSUTCDATETIME())", [cabinetId])).rows[0];
        if (!capable) throw new Refused("shell_unavailable", 403, "agent has not reported the development shell capability");
      }
      const sessionId = await insertSessionRecord(tx, { cabinetId, operatorId, kind: input.kind, reason: input.reason });
      if (input.kind === "shell") await audit(tx, { actorKind: "user", actorId: operatorId, action: "shell.authorized", targetKind: "cabinet", targetId: cabinetId,
        outcome: "succeeded", details: { sessionId, stepUpTokenHash: createHash("sha256").update(input.stepUpToken.split(".")[0]!).digest("hex") } });
      await queueSessionOpen(tx, operatorId, cabinetId, sessionId, input.kind);
      return { sessionId };
    }));
  } catch (error) {
    if (error instanceof Refused) await recordSessionRefusal(pool, { actorKind: "user", actorId: operatorId }, cabinetId, error.code);
    throw error;
  }
}
