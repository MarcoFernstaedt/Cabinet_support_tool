// Fleet safety controls for writes (docs/spec/05-server-spec.md): the fleet-wide and per-client write
// pause, the per-user write limit (going over pauses that user's writes), and read-only cabinets.
// Checked inside the transaction that records the command, so two requests cannot both slip past a limit.
import { catalog } from "../contracts.js";
import { audit, lock, safeJson, transaction, type Pool, type Queryable, type Tx } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { Refused } from "./errors.js";

export const WRITE_OPERATIONS = [...catalog.values()].filter(e => e.kind === "write").map(e => e.name);

interface FleetPause { paused: boolean; reason: string | null; by: string | null; at: string | null }

export async function fleetPause(db: Queryable): Promise<FleetPause> {
  const v = (await db.query<{ value: FleetPause }>("SELECT [value] FROM settings WHERE [key] = 'writes.paused'")).rows[0]?.value;
  return v && typeof v.paused === "boolean" ? v : { paused: false, reason: null, by: null, at: null };
}

/** Refuses a write that a pause, the user's limit or a read-only cabinet forbids. Runs in the command's transaction. */
export async function checkWriteAllowed(c: Tx, userId: string, cabinetId: string): Promise<void> {
  // One writer at a time per user, so the hourly count cannot be raced.
  await lock(c, `writes:${userId}`);
  const k = (await c.query<{ write_paused: boolean; read_only: boolean | null; demo: number }>(
    `SELECT cl.write_paused, k.read_only, CASE WHEN k.demo_scenario IS NOT NULL THEN 1 ELSE 0 END AS demo FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id WHERE k.id = $1`, [cabinetId])).rows[0];
  if (!k) throw new Refused("not_found", 404, "no such cabinet");
  // A simulated cabinet changes nothing real: pauses and the hourly limit protect real cabinets, so the demo can be run as often as wanted.
  if (k.demo === 1) return;
  if ((await fleetPause(c)).paused) throw new Refused("writes_paused", 409, "writes are paused fleet-wide");
  if (k.write_paused) throw new Refused("writes_paused", 409, "writes are paused for this client");
  if (k.read_only) throw new Refused("read_only_cabinet", 409, "this cabinet was installed read-only");
  const u = (await c.query<{ writes_paused: boolean; write_limit: number }>("SELECT writes_paused, write_limit FROM users WHERE id = $1", [userId])).rows[0];
  if (!u) throw new Refused("forbidden", 403, "unknown user");
  if (u.writes_paused) throw new Refused("writes_paused_for_you", 409, "your writes are paused until an Admin resumes them");
  const used = Number((await c.query<{ n: string }>(
    // A bulk change's commands share a bulk_id and count once.
    "SELECT COUNT(DISTINCT COALESCE(m.bulk_id, m.id)) AS n FROM commands m JOIN cabinets t ON t.id = m.cabinet_id WHERE m.issued_by = $1 AND m.issued_at > DATEADD(hour, -1, SYSUTCDATETIME()) AND m.operation IN (SELECT value FROM OPENJSON($2)) AND t.demo_scenario IS NULL", [userId, WRITE_OPERATIONS])).rows[0]!.n);
  // Going over the limit pauses this user's writes until an Admin resumes them (recorded by the caller, after this rollback).
  if (used >= u.write_limit) throw new WriteLimitReached();
}

/** The command's transaction rolls back; the caller then records the pause in its own transaction so it sticks. */
export class WriteLimitReached extends Refused {
  constructor() { super("write_limit_reached", 429, "over the hourly write limit: your writes are paused until an Admin resumes them"); }
}

export async function setFleetPause(pool: Pool, adminId: string, paused: boolean, reason: string | null, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, paused ? "writes.pause" : "writes.resume", "fleet");
    const value: FleetPause = { paused, reason, by: adminId, at: new Date().toISOString() };
    await c.query(`MERGE settings WITH (HOLDLOCK) AS t USING (SELECT N'writes.paused' AS [key]) AS s ON t.[key] = s.[key]
                   WHEN MATCHED THEN UPDATE SET [value] = $1, changed_by = $2, changed_at = SYSUTCDATETIME()
                   WHEN NOT MATCHED THEN INSERT ([key], [value], changed_by) VALUES (N'writes.paused', $1, $2);`, [safeJson(value), adminId]);
    await audit(c, { actorKind: "user", actorId: adminId, action: paused ? "writes.pause" : "writes.resume", outcome: "succeeded", details: { scope: "fleet", reason } });
  });
}

export async function setClientPause(pool: Pool, adminId: string, clientId: string, paused: boolean, reason: string | null, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, paused ? "writes.pause" : "writes.resume", clientId);
    const r = await c.query("UPDATE clients SET write_paused = $2, write_pause_reason = $3 WHERE id = $1", [clientId, paused, paused ? reason : null]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such client");
    await audit(c, { actorKind: "user", actorId: adminId, action: paused ? "writes.pause" : "writes.resume", outcome: "succeeded", details: { scope: "client", clientId, reason } });
  });
}

/** What the console's banner shows: the fleet pause and every paused client. */
export async function writeStatus(db: Queryable) {
  const clients = (await db.query<{ id: string; name: string; write_pause_reason: string | null }>(
    "SELECT id, name, write_pause_reason FROM clients WHERE write_paused = 1 ORDER BY name")).rows;
  return { fleet: await fleetPause(db), clients: clients.map(c => ({ id: c.id, name: c.name, reason: c.write_pause_reason })) };
}
