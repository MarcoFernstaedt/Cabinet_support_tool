// Commands: issued by a person, delivered on the cabinet's long poll, answered by a result.
import { raiseSecurityAlert } from "./security.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { catalog, isOperationName, operations, type CatalogEntry, type Command, type OperationName, type Result } from "../contracts.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { checkWriteAllowed, WriteLimitReached } from "./writes.js";
import { audit, safeJson, transaction, type Queryable } from "../db/db.js";
import { Refused } from "./errors.js";

export const MAX_COMMANDS_PER_POLL = 50;

export interface WriteAuthority {
  /** The one-time step-up token for this operation on this cabinet, for operations confirmed with a code (the console). */
  stepUpToken?: string;
  /** The parameters the person confirmed (before the server filled in its own values); the token is bound to them. */
  confirmedParams?: unknown;
  /** The operator CLI on the server host issues writes without step-up; recorded as such in the audit log. */
  viaCli?: boolean;
}

/**
 * Records a command and its audit entry together (docs/spec/05-server-spec.md "Issuing a command").
 * A write also needs its authority (a step-up token for this operation on this cabinet, or the operator
 * CLI), and passes the fleet safety controls in the same transaction.
 */
export async function issueCommand(pool: pg.Pool, userId: string, cabinetId: string, operation: string, params: unknown, auditAction = "command.issue",
  write?: WriteAuthority): Promise<Command> {
  if (!isOperationName(operation)) throw new Refused("unknown_operation", 400, "not a catalog operation");
  const entry = catalog.get(operation)!;
  // Confirmation levels (docs/spec/12-milestones-8-to-12.md): a code-level write needs a step-up token bound to its
  // parameters; a click-level write is confirmed in the console and takes no token; reads take none.
  if (entry.confirm === "code" && !write?.stepUpToken && !write?.viaCli) throw new Refused("step_up_required", 403, "this change needs an authenticator code for these exact parameters");
  if (entry.confirm !== "code" && write?.stepUpToken) throw new Refused("invalid_request", 400, "this operation takes no step-up token");
  if (entry.kind === "write" && !write) throw new Refused("invalid_request", 400, "a write needs its authority");
  if (!operations[operation].params.is(params)) throw new Refused("invalid_params", 400, "parameters do not match the operation's schema");
  try {
    return await issueInTransaction(pool, userId, cabinetId, operation, params, auditAction, entry, write);
  } catch (e) {
    if (e instanceof WriteLimitReached) await recordLimitPause(pool, userId);
    throw e;
  }
}

/** The agent's package refusals, and which security alert each raises. */
const REFUSED_PACKAGE: Record<string, "signature_failure" | "package_refused"> = {
  signature_invalid: "signature_failure", hash_mismatch: "package_refused", publisher_not_trusted: "package_refused", verification_failed: "package_refused",
};

async function recordLimitPause(pool: pg.Pool, userId: string): Promise<void> {
  // The refused command's transaction rolled back; the pause itself must stick.
  await transaction(pool, async c => {
    const r = await c.query("UPDATE users SET writes_paused = true, writes_paused_reason = coalesce(writes_paused_reason, 'Went over the hourly write limit.') WHERE id = $1 AND NOT writes_paused", [userId]);
    if (r.rowCount === 1) {
      await audit(c, { actorKind: "system", actorId: "write-limit", action: "writes.user_paused", targetKind: "user", targetId: userId, outcome: "succeeded" });
      const who = (await c.query<{ username: string; write_limit: number }>("SELECT username, write_limit FROM users WHERE id = $1", [userId])).rows[0];
      await raiseSecurityAlert(c, { kind: "write_volume", signature: `write_volume|${userId}`, userId,
        title: `Unusual write volume from ${who?.username ?? "a user"}: over ${who?.write_limit ?? "the"} writes in an hour; their writes are paused`,
        detail: { writeLimit: who?.write_limit ?? null } });
    }
  });
}

async function issueInTransaction(pool: pg.Pool, userId: string, cabinetId: string, operation: OperationName, params: unknown, auditAction: string,
  entry: CatalogEntry, write?: WriteAuthority): Promise<Command> {
  return transaction(pool, async c => {
    const cabinet = (await c.query("SELECT 1 FROM cabinets WHERE id = $1 AND status = 'active'", [cabinetId])).rows[0];
    if (!cabinet) throw new Refused("not_found", 404, "no such active cabinet");
    const user = (await c.query("SELECT 1 FROM users WHERE id = $1 AND status = 'active'", [userId])).rows[0];
    if (!user) throw new Refused("forbidden", 403, "unknown or disabled user");
    if (entry.kind === "write") {
      if (write?.stepUpToken) await consumeStepUpToken(c, write.stepUpToken, userId, operation, cabinetId, write.confirmedParams ?? params);
      await checkWriteAllowed(c, userId, cabinetId);
    }
    // Second precision keeps the timestamps identical on both sides of the wire.
    const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const command: Command = {
      commandId: randomUUID(), cabinetId, operation, params: params as Record<string, unknown>, issuedBy: userId,
      issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + entry.expirySeconds * 1000).toISOString(),
    };
    await c.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')`,
      [command.commandId, cabinetId, operation, safeJson(params), userId, command.issuedAt, command.expiresAt]);
    await audit(c, { actorKind: "user", actorId: userId, action: entry.kind === "write" ? "command.write" : auditAction, targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded",
      details: { commandId: command.commandId, operation, params, ...(write?.viaCli ? { via: "cli" } : {}) } });
    return command;
  });
}

/** Hands over every waiting command for this cabinet, once. Commands past their expiry are marked expired instead. */
export async function takeQueuedCommands(pool: pg.Pool, cabinetId: string): Promise<Command[]> {
  // One statement, one round trip: it runs for every long poll of every cabinet. Commands past their expiry are marked
  // expired, never delivered; the rest are delivered oldest first, at most MAX_COMMANDS_PER_POLL.
  const rows = (await pool.query<{ id: string; operation: string; params: Record<string, unknown>; issued_by: string; issued_at: Date; expires_at: Date }>(
    `WITH expired AS (
       UPDATE commands SET status = 'expired' WHERE cabinet_id = $1 AND status = 'queued' AND expires_at <= now()
     )
     UPDATE commands SET status = 'delivered', delivered_at = now()
      WHERE id IN (SELECT id FROM commands WHERE cabinet_id = $1 AND status = 'queued' AND expires_at > now()
                    ORDER BY issued_at LIMIT ${MAX_COMMANDS_PER_POLL} FOR UPDATE SKIP LOCKED)
      RETURNING id, operation, params, issued_by, issued_at, expires_at`, [cabinetId])).rows;
  return rows.sort((a, b) => a.issued_at.getTime() - b.issued_at.getTime()).map(r => ({
    commandId: r.id, cabinetId, operation: r.operation as Command["operation"], params: r.params, issuedBy: r.issued_by,
    issuedAt: r.issued_at.toISOString(), expiresAt: r.expires_at.toISOString(),
  }));
}

/**
 * Stores a result for a command this cabinet was given. The output is checked
 * against the operation's output schema using the server's own command record,
 * never the agent's say-so about which operation it ran.
 */
export async function storeResult(pool: pg.Pool, cabinetId: string, result: Result): Promise<void> {
  await transaction(pool, async c => {
    const command = (await c.query<{ operation: string; status: string; delivered: boolean }>(
      "SELECT operation, status, delivered_at IS NOT NULL AS delivered FROM commands WHERE id = $1 AND cabinet_id = $2 FOR UPDATE", [result.commandId, cabinetId])).rows[0];
    if (!command) throw new Refused("unknown_command", 404, "no such command for this cabinet");
    // A delivered command that went quiet is marked expired (expireUnanswered), but its result still counts if it arrives
    // later (the cabinet ran it, then lost the server): what really happened on the cabinet is never thrown away.
    if (!(command.status === "delivered" || (command.status === "expired" && command.delivered)))
      throw new Refused("result_not_expected", 409, "this command already has a result or was never delivered");
    if (result.status === "succeeded") {
      const output = operations[command.operation as keyof typeof operations]?.output;
      if (!output || result.output === undefined || !output.is(result.output))
        throw new Refused("invalid_output", 400, "the output does not match the operation's output schema");
    }
    await c.query("UPDATE commands SET status = $2, result = $3, result_at = now() WHERE id = $1", [result.commandId, result.status, safeJson(result)]);
    // The address a cabinet reports in its network settings is kept on the cabinet, so lists of cabinets can show it.
    if (result.status === "succeeded" && command.operation === "network.config") {
      const adapters = (result.output as { adapters?: { connected: boolean; ipv4: { addresses: { address: string }[] } }[] }).adapters ?? [];
      const all = adapters.filter(a => a.connected).flatMap(a => a.ipv4.addresses.map(x => x.address));
      const address = all.find(a => !a.startsWith("169.254.")) ?? all[0];
      if (address) await c.query("UPDATE cabinets SET ipv4 = $2, ipv4_at = now() WHERE id = $1", [cabinetId, address]);
    }
    // A firewall write's before and after go into the cabinet's firewall history as a change made through the platform.
    if (result.status === "succeeded" && command.operation.startsWith("firewall.") && command.operation !== "firewall.state") {
      const out = result.output as { before?: unknown; after?: unknown };
      await c.query(`INSERT INTO firewall_changes (cabinet_id, command_id, explained, operation, before, after, detail, occurred_at) VALUES ($1, $2, true, $3, $4, $5, $6, $7)`,
        [cabinetId, result.commandId, command.operation, out.before === undefined ? null : safeJson(out.before), out.after === undefined ? null : safeJson(out.after),
         safeJson(out), result.finishedAt]);
    }
    // A package the cabinet refused (its own checks found it changed, unsigned or from an unlisted publisher) is a security alert.
    if (command.operation === "package.install" && result.error && REFUSED_PACKAGE[result.error.code]) {
      const kind = REFUSED_PACKAGE[result.error.code]!;
      await raiseSecurityAlert(c, { kind, signature: `${kind}|${cabinetId}`, cabinetId,
        title: kind === "signature_failure" ? "A cabinet refused a package whose signature failed its check" : "A cabinet refused a package from the software library",
        detail: { commandId: result.commandId, code: result.error.code, message: result.error.message } });
    }
    await audit(c, { actorKind: "agent", actorId: cabinetId, action: "command.result", targetKind: "command", targetId: result.commandId, outcome: "succeeded",
      details: { operation: command.operation, status: result.status, ...(result.error ? { error: result.error.code } : {}) } });
  });
}

export async function commandRecord(db: Queryable, commandId: string): Promise<{ status: string; operation: string; result: Result | null } | null> {
  return (await db.query<{ status: string; operation: string; result: Result | null }>(
    "SELECT status, operation, result FROM commands WHERE id = $1", [commandId])).rows[0] ?? null;
}

/** How long a delivered command may go unanswered: longer than the agent's longest limit (a package install, 29 minutes). */
export const UNANSWERED_AFTER_MINUTES = 35;

/**
 * Marks delivered commands that never got a result as expired, so the console stops showing them as running (the
 * long-poll answer may have been lost on the way, or the cabinet went offline). Runs with the minute job.
 */
export async function expireUnanswered(pool: pg.Pool): Promise<number> {
  return (await pool.query(
    `UPDATE commands SET status = 'expired' WHERE status = 'delivered' AND delivered_at < now() - make_interval(mins => $1)`, [UNANSWERED_AFTER_MINUTES])).rowCount ?? 0;
}
