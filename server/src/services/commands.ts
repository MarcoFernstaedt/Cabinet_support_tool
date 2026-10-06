// Commands: issued by a person, delivered on the cabinet's long poll, answered by a result.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { catalog, isOperationName, operations, type Command, type Result } from "../contracts.js";
import { audit, safeJson, transaction, type Queryable } from "../db/db.js";
import { Refused } from "./errors.js";

export const MAX_COMMANDS_PER_POLL = 50;

/**
 * Records a command and its audit entry together (docs/spec/05-server-spec.md
 * "Issuing a command" steps 1, 5 and 6). Role checks arrive with console
 * sign-in (milestone 3); write operations need step-up and the safety
 * controls of milestone 5, so they are refused here for now.
 */
export async function issueCommand(pool: pg.Pool, userId: string, cabinetId: string, operation: string, params: unknown, auditAction = "command.issue"): Promise<Command> {
  if (!isOperationName(operation)) throw new Refused("unknown_operation", 400, "not a catalog operation");
  const entry = catalog.get(operation)!;
  if (entry.kind !== "read") throw new Refused("writes_unavailable", 403, "write operations arrive in milestone 5");
  if (!operations[operation].params.is(params)) throw new Refused("invalid_params", 400, "parameters do not match the operation's schema");
  return transaction(pool, async c => {
    const cabinet = (await c.query("SELECT 1 FROM cabinets WHERE id = $1 AND status = 'active'", [cabinetId])).rows[0];
    if (!cabinet) throw new Refused("not_found", 404, "no such active cabinet");
    const user = (await c.query("SELECT 1 FROM users WHERE id = $1 AND status = 'active'", [userId])).rows[0];
    if (!user) throw new Refused("forbidden", 403, "unknown or disabled user");
    // Second precision keeps the timestamps identical on both sides of the wire.
    const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const command: Command = {
      commandId: randomUUID(), cabinetId, operation, params: params as Record<string, unknown>, issuedBy: userId,
      issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + entry.expirySeconds * 1000).toISOString(),
    };
    await c.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')`,
      [command.commandId, cabinetId, operation, safeJson(params), userId, command.issuedAt, command.expiresAt]);
    await audit(c, { actorKind: "user", actorId: userId, action: auditAction, targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded",
      details: { commandId: command.commandId, operation, params } });
    return command;
  });
}

/** Hands over every waiting command for this cabinet, once. Commands past their expiry are marked expired instead. */
export async function takeQueuedCommands(pool: pg.Pool, cabinetId: string): Promise<Command[]> {
  return transaction(pool, async c => {
    await c.query("UPDATE commands SET status = 'expired' WHERE cabinet_id = $1 AND status = 'queued' AND expires_at <= now()", [cabinetId]);
    const rows = (await c.query<{ id: string; operation: string; params: Record<string, unknown>; issued_by: string; issued_at: Date; expires_at: Date }>(
      `UPDATE commands SET status = 'delivered', delivered_at = now()
        WHERE id IN (SELECT id FROM commands WHERE cabinet_id = $1 AND status = 'queued' ORDER BY issued_at LIMIT ${MAX_COMMANDS_PER_POLL} FOR UPDATE SKIP LOCKED)
        RETURNING id, operation, params, issued_by, issued_at, expires_at`, [cabinetId])).rows;
    return rows.sort((a, b) => a.issued_at.getTime() - b.issued_at.getTime()).map(r => ({
      commandId: r.id, cabinetId, operation: r.operation as Command["operation"], params: r.params, issuedBy: r.issued_by,
      issuedAt: r.issued_at.toISOString(), expiresAt: r.expires_at.toISOString(),
    }));
  });
}

/**
 * Stores a result for a command this cabinet was given. The output is checked
 * against the operation's output schema using the server's own command record,
 * never the agent's say-so about which operation it ran.
 */
export async function storeResult(pool: pg.Pool, cabinetId: string, result: Result): Promise<void> {
  await transaction(pool, async c => {
    const command = (await c.query<{ operation: string; status: string }>(
      "SELECT operation, status FROM commands WHERE id = $1 AND cabinet_id = $2 FOR UPDATE", [result.commandId, cabinetId])).rows[0];
    if (!command) throw new Refused("unknown_command", 404, "no such command for this cabinet");
    if (command.status !== "delivered") throw new Refused("result_not_expected", 409, "this command already has a result or was never delivered");
    if (result.status === "succeeded") {
      const output = operations[command.operation as keyof typeof operations]?.output;
      if (!output || result.output === undefined || !output.is(result.output))
        throw new Refused("invalid_output", 400, "the output does not match the operation's output schema");
    }
    await c.query("UPDATE commands SET status = $2, result = $3, result_at = now() WHERE id = $1", [result.commandId, result.status, safeJson(result)]);
    await audit(c, { actorKind: "agent", actorId: cabinetId, action: "command.result", targetKind: "command", targetId: result.commandId, outcome: "succeeded",
      details: { operation: command.operation, status: result.status, ...(result.error ? { error: result.error.code } : {}) } });
  });
}

export async function commandRecord(db: Queryable, commandId: string): Promise<{ status: string; operation: string; result: Result | null } | null> {
  return (await db.query<{ status: string; operation: string; result: Result | null }>(
    "SELECT status, operation, result FROM commands WHERE id = $1", [commandId])).rows[0] ?? null;
}
