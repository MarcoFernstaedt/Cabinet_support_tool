// Commands: issued by a person, delivered on the cabinet's long poll, answered by a result.
import { raiseSecurityAlert } from "./security.js";
import { randomUUID } from "node:crypto";
import { catalog, envelopes, isOperationName, operations, type CatalogEntry, type Command, type Event, type OperationName, type Result } from "../contracts.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { checkWriteAllowed, pauseOnWriteLimit } from "./writes.js";
import { audit, auditMany, HOT_PATH_TIMEOUT_MS, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { Refused } from "./errors.js";
import { checkRetentionCutoff, inBatches, RETENTION_BATCH, type BatchOptions } from "../db/batches.js";
import { ingestAndEvaluate, judgeProcesses } from "./config-service.js";
import { rememberCabinetModel } from "./config-ingest.js";
import { checkServiceRecovery, type ServiceWithRecovery } from "./service-recovery.js";
import { CONTROLLED_OPERATIONS } from "./controlled-targets.js";
import { adaptersFromNetworkConfig, followReportedAddress, lanAddress } from "./sync-cabinets.js";
import { searchText } from "./reading-search-text.js";

export const MAX_COMMANDS_PER_POLL = 50;

export interface WriteAuthority {
  /** The one-time step-up token for this operation on this cabinet, for operations confirmed with a code (the console). */
  stepUpToken?: string;
  /** The parameters the person confirmed (before the server filled in its own values); the token is bound to them. */
  confirmedParams?: unknown;
  /** The operator CLI on the server host issues writes without step-up; recorded as such in the audit log. */
  viaCli?: boolean;
  /**
   * A replacement's re-apply (replacement-reapply.ts): confirmed with the Admin's code when the approval named the cabinet it replaces,
   * so its steps take no token of their own. The replaced cabinet's id; recorded in the audit log. Its steps share one bulk id and count
   * once against the Admin's hourly limit.
   */
  viaReplacement?: { replaces: string; bulkId: string };
}

/**
 * Reads the platform no longer asks for (decision-log D152): the owner removed SMART. They stay in the catalog until the agent drops them,
 * so a cabinet on an older agent still answers one already queued; nothing issues a new one.
 */
export const RETIRED_OPERATIONS: ReadonlySet<string> = new Set(["disk.smart", "storage.health"]);
const refuseRetired = (operation: string): void => {
  if (RETIRED_OPERATIONS.has(operation)) throw new Refused("unknown_operation", 400, "the platform no longer reads drive health (SMART)");
};

/**
 * Records a command and its audit entry together (docs/spec/05-server-spec.md "Issuing a command").
 * A write also needs its authority (a step-up token for this operation on this cabinet, or the operator
 * CLI), and passes the fleet safety controls in the same transaction.
 */
export async function issueCommand(pool: Pool, userId: string, cabinetId: string, operation: string, params: unknown, auditAction = "command.issue",
  write?: WriteAuthority): Promise<Command> {
  if (!isOperationName(operation)) throw new Refused("unknown_operation", 400, "not a catalog operation");
  refuseRetired(operation);
  const entry = catalog.get(operation)!;
  // Confirmation levels (docs/spec/12-milestones-8-to-12.md): a code-level write needs a step-up token bound to its
  // parameters; a click-level write is confirmed in the console and takes no token; reads take none.
  if (needsCode(operation) && !write?.stepUpToken && !write?.viaCli && !write?.viaReplacement) throw new Refused("step_up_required", 403, "this change needs an authenticator code for these exact parameters");
  if (!needsCode(operation) && write?.stepUpToken) throw new Refused("invalid_request", 400, "this operation takes no step-up token");
  if (entry.kind === "write" && !write) throw new Refused("invalid_request", 400, "a write needs its authority");
  if (!operations[operation].params.is(params)) throw new Refused("invalid_params", 400, "parameters do not match the operation's schema");
  return pauseOnWriteLimit(pool, userId, () => issueInTransaction(pool, userId, cabinetId, operation, params, auditAction, entry, write));
}

/**
 * Whether a person confirms this operation with a fresh authenticator code. The catalog's level, raised to a code for the operations
 * that touch a running program (service.control is a click in the catalog the agent is built with, but an agent built before the
 * approved-applications list enforces nothing, so the server asks for the stronger confirmation).
 */
export function needsCode(operation: string): boolean {
  return catalog.get(operation as OperationName)?.confirm === "code" || CONTROLLED_OPERATIONS.has(operation);
}

/** The agent's package refusals, and which security alert each raises. */
const REFUSED_PACKAGE: Record<string, "signature_failure" | "package_refused"> = {
  signature_invalid: "signature_failure", hash_mismatch: "package_refused", publisher_not_trusted: "package_refused", verification_failed: "package_refused",
};

async function issueInTransaction(pool: Pool, userId: string, cabinetId: string, operation: OperationName, params: unknown, auditAction: string,
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
    await c.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, bulk_id) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8)`,
      [command.commandId, cabinetId, operation, safeJson(params), userId, issuedAt, new Date(command.expiresAt), write?.viaReplacement?.bulkId ?? null]);
    await audit(c, { actorKind: "user", actorId: userId, action: entry.kind === "write" ? "command.write" : auditAction, targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded",
      details: { commandId: command.commandId, operation, params, ...(write?.viaCli ? { via: "cli" } : {}),
        ...(write?.viaReplacement ? { via: "replacement", replaces: write.viaReplacement.replaces } : {}) } });
    return command;
  });
}

/** One command of a bulk change, as a fleet job or a bulk firewall change queues it (queueBulkCommand). */
export interface BulkCommand { commandId: string; cabinetId: string; operation: string; params: unknown; issuedBy: string; issuedAt: Date; expiresAt: Date; bulkId: string }

/**
 * Queues one command of a bulk change, in the caller's transaction (F21.R2, decision-log D102). The bulk callers check the person, the
 * fleet pause, the write limit and each cabinet, and audit what they queued; this is the insert they shared, checked here before the
 * database is touched as issueCommand checks a single command: a catalog write operation, its parameters against the operation's
 * schema, ids that are uuids, and an expiry after the issue time.
 */
export async function queueBulkCommand(c: Queryable, cmd: BulkCommand): Promise<void> {
  const isId = (v: unknown) => typeof v === "string" && CABINET_ID.test(v);
  if (!cmd || typeof cmd !== "object") throw new Error("a bulk command is required");
  for (const k of ["commandId", "cabinetId", "issuedBy", "bulkId"] as const) if (!isId(cmd[k])) throw new Error(`a bulk command's ${k} must be a uuid`);
  if (typeof cmd.operation !== "string" || !isOperationName(cmd.operation)) throw new Error("a bulk command's operation must be a catalog operation");
  if (catalog.get(cmd.operation)!.kind !== "write") throw new Error("a bulk command is a write");
  if (!operations[cmd.operation].params.is(cmd.params)) throw new Error("a bulk command's parameters do not match the operation's schema");
  if (!(cmd.issuedAt instanceof Date) || !(cmd.expiresAt instanceof Date) || Number.isNaN(cmd.issuedAt.getTime()) || !(cmd.expiresAt.getTime() > cmd.issuedAt.getTime()))
    throw new Error("a bulk command expires after it is issued");
  await c.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, bulk_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8)`,
    [cmd.commandId, cmd.cabinetId, cmd.operation, safeJson(cmd.params), cmd.issuedBy, cmd.issuedAt, cmd.expiresAt, cmd.bulkId]);
}

/** At most this many commands are withdrawn in one call: a fleet job covers at most 200 cabinets (fleet-job.schema.json). */
export const WITHDRAW_LIMIT = 200;

/** A command a fleet job withdrew: its id, cabinet, operation, the status it now has, and whether it had been delivered. */
export interface WithdrawnCommand { id: string; cabinet_id: string; operation: string; status: string; delivered: boolean | number }

/**
 * Withdraws a fleet job's outstanding commands, in the caller's transaction (F21.R2, decision-log D103). The statement is the one
 * fleet-jobs.ts ran: a queued or delivered command among `commandIds` is withdrawn once `batchMs` has passed since it was issued, or at
 * once while it is queued, undelivered and its cabinet has not been heard from within `offlineAfterSeconds`. One delivered, or whose
 * cabinet is offline, becomes expired (late results keep their handling); one still undelivered to an online cabinet becomes failed.
 * Its expiry is pulled in to now, kept above its issue time (commands_check). Each withdrawal is audited as command.expire by the
 * system, naming the job, in the same transaction. The job, every id and both windows are checked before the database is touched.
 */
export async function withdrawJobCommands(tx: Queryable, jobId: string, commandIds: readonly string[], offlineAfterSeconds: number, batchMs: number): Promise<WithdrawnCommand[]> {
  const isId = (v: unknown) => typeof v === "string" && CABINET_ID.test(v);
  if (!isId(jobId)) throw new Error("a fleet job's id is required to withdraw its commands");
  if (!Array.isArray(commandIds) || commandIds.length === 0 || commandIds.length > WITHDRAW_LIMIT || !commandIds.every(isId))
    throw new Error(`1 to ${WITHDRAW_LIMIT} command ids are required to withdraw them`);
  if (!Number.isInteger(offlineAfterSeconds) || offlineAfterSeconds < 1 || offlineAfterSeconds > 86_400)
    throw new Error("the offline window is 1 to 86400 whole seconds");
  if (!Number.isInteger(batchMs) || batchMs < 0 || batchMs > 86_400_000) throw new Error("a batch's answer budget is 0 to 86400000 whole milliseconds");
  const retired = (await tx.query<WithdrawnCommand>(
    `DECLARE @retired TABLE (id uniqueidentifier, cabinet_id uniqueidentifier, operation nvarchar(64), status varchar(16), delivered bit);
     -- At issued_at's own precision: a command issued now is stored rounded, up to half a millisecond ahead of SYSUTCDATETIME().
     DECLARE @now datetime2(3) = SYSUTCDATETIME();
     UPDATE commands SET status = CASE WHEN delivered_at IS NOT NULL OR NOT EXISTS
         (SELECT 1 FROM cabinets k WHERE k.id = commands.cabinet_id
           AND k.last_heartbeat_at > DATEADD(second, -$2, SYSUTCDATETIME())) THEN 'expired' ELSE 'failed' END, expires_at = CASE WHEN DATEADD(millisecond, 1, issued_at) > SYSUTCDATETIME() THEN DATEADD(millisecond, 1, issued_at)
         WHEN expires_at > SYSUTCDATETIME() THEN SYSUTCDATETIME() ELSE expires_at END
       OUTPUT inserted.id, inserted.cabinet_id, inserted.operation, inserted.status,
         CAST(CASE WHEN inserted.delivered_at IS NULL THEN 0 ELSE 1 END AS bit) INTO @retired
       WHERE id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1)) AND status IN ('queued', 'delivered')
         AND (issued_at <= DATEADD(millisecond, -$3, @now)
           OR (status = 'queued' AND delivered_at IS NULL AND NOT EXISTS
             (SELECT 1 FROM cabinets k WHERE k.id = commands.cabinet_id
               AND k.last_heartbeat_at > DATEADD(second, -$2, SYSUTCDATETIME()))));
     SELECT id, cabinet_id, operation, status, delivered FROM @retired`, [[...commandIds], offlineAfterSeconds, batchMs])).rows;
  if (retired.length > 0)
    await auditMany(tx, retired.map(r => ({ actorKind: "system", actorId: "command-expiry", action: "command.expire", targetKind: "command", targetId: r.id.toLowerCase(),
      outcome: "succeeded", details: { cabinetId: r.cabinet_id.toLowerCase(), operation: r.operation, jobId, status: r.status,
        why: "fleet-job-withdrawal", delivered: r.delivered === true || r.delivered === 1, automatic: true } })));
  return retired;
}

/** How long a command handed to a poll stays leased to it (docs/spec/03-protocol.md "Protocol 1.1"). */
export const LEASE_SECONDS = 30;

export interface TakenCommands {
  commands: Command[];
  /** When the earliest lease still running for this cabinet ends (a command handed out but not yet acknowledged), else null. */
  nextLeaseEnd: Date | null;
}

/**
 * Hands over the commands waiting for this cabinet (Protocol 1.1 leased delivery), after recording the acknowledgements the poll
 * carried. A command handed to a poll is leased for leaseSeconds; one neither acknowledged nor answered when its lease ends is offered
 * again while it has not expired, so a poll whose answer was lost on the way loses no command. Commands past their expiry are never
 * delivered; the minute job marks them expired (expireCommands). The acknowledgements count only for this cabinet's own commands.
 */
export async function takeLeasedCommands(pool: Queryable, cabinetId: string, acks: readonly string[] = [], leaseSeconds = LEASE_SECONDS): Promise<TakenCommands> {
  // One batch, one round trip: it runs for every long poll of every cabinet. At most MAX_COMMANDS_PER_POLL, oldest first.
  // READPAST skips rows another poll has locked.
  // The last SELECT always returns at least one row (the next lease end), with the taken commands joined to it.
  const rows = (await pool.query<{ id: string | null; operation: string; params: Record<string, unknown>; issued_by: string; issued_at: Date; expires_at: Date; next_lease: Date | null }>(
    `DECLARE @now datetime2(3) = SYSUTCDATETIME();
     DECLARE @until datetime2(3) = DATEADD(second, $3, @now);
     IF $2 IS NOT NULL
       UPDATE commands SET ack_at = @now
        WHERE cabinet_id = $1 AND status = 'delivered' AND ack_at IS NULL AND id IN (SELECT TRY_CAST([value] AS uniqueidentifier) FROM OPENJSON($2));
     -- Almost every poll finds nothing waiting: two seeks on the small filtered indexes say so, and then nothing else runs.
     IF EXISTS (SELECT 1 FROM commands WITH (FORCESEEK) WHERE cabinet_id = $1 AND status = 'queued')
        OR EXISTS (SELECT 1 FROM commands WITH (FORCESEEK) WHERE cabinet_id = $1 AND status = 'delivered' AND ack_at IS NULL AND result_at IS NULL)
     BEGIN
     -- A command past its expiry is never handed over (both halves below require expires_at > @now). Marking it expired is the minute
     -- job's (expireCommands), which audits each one (F4); doing it here would put a table variable on every poll.
     UPDATE commands SET status = 'delivered', delivered_at = COALESCE(delivered_at, @now), lease_until = @until
      WHERE id IN (SELECT TOP (${MAX_COMMANDS_PER_POLL}) w.id FROM (
                     SELECT id, issued_at FROM commands WITH (UPDLOCK, ROWLOCK, READPAST, FORCESEEK)
                      WHERE cabinet_id = $1 AND status = 'queued' AND expires_at > @now
                     UNION ALL
                     SELECT id, issued_at FROM commands WITH (UPDLOCK, ROWLOCK, READPAST, FORCESEEK)
                      WHERE cabinet_id = $1 AND status = 'delivered' AND ack_at IS NULL AND result_at IS NULL AND lease_until <= @now AND expires_at > @now) w
                    ORDER BY w.issued_at);
     END
     -- What this poll took is read back by its lease end (no table variable: commands has triggers, so OUTPUT would need one, and each
     -- one an ad-hoc batch declares is created in tempdb, which queued at 10,000 cabinets). Two polls of one cabinet in the same
     -- millisecond would both see the other's commands; the agent acknowledges and answers repeats, so that is harmless.
     SELECT t.id, t.operation, t.params, t.issued_by, t.issued_at, t.expires_at, n.next_lease
       FROM (SELECT MIN(lease_until) AS next_lease FROM commands WITH (FORCESEEK)
              WHERE cabinet_id = $1 AND status = 'delivered' AND ack_at IS NULL AND result_at IS NULL AND lease_until > @now AND expires_at > @now) n
       LEFT JOIN commands t WITH (FORCESEEK) ON t.cabinet_id = $1 AND t.status = 'delivered' AND t.lease_until = @until AND t.ack_at IS NULL AND t.result_at IS NULL;`,
    [cabinetId, acks.length > 0 ? JSON.stringify(acks) : null, leaseSeconds], { timeoutMs: HOT_PATH_TIMEOUT_MS })).rows;
  const commands = rows.filter(r => r.id !== null).sort((a, b) => a.issued_at.getTime() - b.issued_at.getTime()).map(r => ({
    commandId: r.id!, cabinetId, operation: r.operation as Command["operation"], params: r.params, issuedBy: r.issued_by,
    issuedAt: r.issued_at.toISOString(), expiresAt: r.expires_at.toISOString(),
  }));
  return { commands, nextLeaseEnd: rows[0]?.next_lease ?? null };
}

/** The waiting commands only (the demo simulator and tests, which stand in for an agent in this process). */
export async function takeQueuedCommands(pool: Queryable, cabinetId: string): Promise<Command[]> {
  return (await takeLeasedCommands(pool, cabinetId)).commands;
}

/**
 * Stores a result for a command this cabinet was given. The output is checked
 * against the operation's output schema using the server's own command record,
 * never the agent's say-so about which operation it ran.
 */
export async function storeResult(pool: Pool, cabinetId: string, result: Result): Promise<void> {
  let afterCommit: (() => Promise<unknown>) | null = null;
  await transaction(pool, async c => {
    afterCommit = null;
    const command = (await c.query<{ operation: string; status: string; delivered: number }>(
      "SELECT operation, status, CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END AS delivered FROM commands WITH (UPDLOCK, ROWLOCK) WHERE id = $1 AND cabinet_id = $2", [result.commandId, cabinetId])).rows[0];
    if (!command) throw new Refused("unknown_command", 404, "no such command for this cabinet");
    // A command offered again after its lease (Protocol 1.1) may reach an agent that already had it; an agent without a stored result
    // for it refuses the repeat as replayed. That says only that the cabinet had it: it counts as the acknowledgement, never as the
    // outcome, so the real result can still arrive.
    if (result.status === "rejected" && result.error?.code === "replayed" && command.status === "delivered") {
      await c.query("UPDATE commands SET ack_at = COALESCE(ack_at, SYSUTCDATETIME()) WHERE id = $1", [result.commandId]);
      return;
    }
    // A delivered command that went quiet is marked expired (expireCommands), but its result still counts if it arrives
    // later (the cabinet ran it, then lost the server): what really happened on the cabinet is never thrown away.
    if (!(command.status === "delivered" || (command.status === "expired" && command.delivered === 1)))
      throw new Refused("result_not_expected", 409, "this command already has a result or was never delivered");
    if (result.status === "succeeded") {
      const output = operations[command.operation as keyof typeof operations]?.output;
      if (!output || result.output === undefined || !output.is(result.output))
        throw new Refused("invalid_output", 400, "the output does not match the operation's output schema");
    }
    // The names the fleet's readings search matches, kept beside the result so a search does not read every stored JSON (D63).
    const text = result.status === "succeeded" ? searchText(command.operation, result.output) : null;
    await c.query("UPDATE commands SET status = $2, result = $3, result_at = SYSUTCDATETIME(), search_text = $4 WHERE id = $1",
      [result.commandId, result.status, safeJson(result), text]);
    // What the cabinet says about its make and model keeps the model baseline applying to it.
    // Those two columns are config-ingest.ts's (D119).
    if (result.status === "succeeded" && command.operation === "system.hardware")
      await rememberCabinetModel(c, cabinetId, result.output as { manufacturer?: unknown; model?: unknown });
    // A service set to restart the computer when it fails is an alert, named; a reading with none closes it (F14.R3).
    if (result.status === "succeeded" && command.operation === "services.list")
      await checkServiceRecovery(c, cabinetId, (result.output as { services: ServiceWithRecovery[] }).services);
    // A configuration read on demand is stored like one the agent sent (verified, change-only), after this result is safely recorded.
    if (result.status === "succeeded" && command.operation === "config.snapshot") {
      const out = result.output as { takenAt: string; categories: { category: string; hash: string; truncated: boolean; items: unknown[] }[] };
      if (out.categories.length > 0)
        afterCommit = () => ingestAndEvaluate(pool, cabinetId, out.categories.map(k => ({ observedAt: out.takenAt, ...k })) as never, "refresh").catch(() => undefined);
    }
    // A processes answer is what process expectations are judged on (D155), after it is safely recorded.
    if (result.status === "succeeded" && command.operation === "processes.list")
      afterCommit = () => judgeProcesses(pool, cabinetId).catch(() => undefined);
    // The address a cabinet reports in its network settings is kept on the cabinet, so lists of cabinets can show it.
    if (result.status === "succeeded" && command.operation === "network.config") {
      const adapters = (result.output as { adapters?: { connected: boolean; ipv4: { addresses: { address: string }[] } }[] }).adapters ?? [];
      const all = adapters.filter(a => a.connected).flatMap(a => a.ipv4.addresses.map(x => x.address));
      const address = all.find(a => !a.startsWith("169.254.")) ?? all[0];
      if (address) await c.query("UPDATE cabinets SET ipv4 = $2, ipv4_at = SYSUTCDATETIME() WHERE id = $1", [cabinetId, address]);
      // A sync cabinet that follows its own report takes the address its satellites reach from the same reading.
      await followReportedAddress(c, cabinetId, lanAddress(adaptersFromNetworkConfig(result.output)));
    }
    // A firewall write's before and after go into the cabinet's firewall history as a change made through the platform.
    if (result.status === "succeeded" && command.operation.startsWith("firewall.") && command.operation !== "firewall.state") {
      const out = result.output as { before?: unknown; after?: unknown };
      await c.query(`INSERT INTO firewall_changes (cabinet_id, command_id, explained, operation, [before], [after], detail, occurred_at) VALUES ($1, $2, 1, $3, $4, $5, $6, $7)`,
        [cabinetId, result.commandId, command.operation, out.before === undefined ? null : safeJson(out.before), out.after === undefined ? null : safeJson(out.after),
         safeJson(out), new Date(result.finishedAt)]);
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
  if (afterCommit) await (afterCommit as () => Promise<unknown>)();
}

export async function commandRecord(db: Queryable, commandId: string): Promise<{ status: string; operation: string; result: Result | null } | null> {
  return (await db.query<{ status: string; operation: string; result: Result | null }>(
    "SELECT status, operation, result FROM commands WHERE id = $1", [commandId])).rows[0] ?? null;
}

/** How long a delivered command may go unanswered: longer than the agent's longest limit (a package install, 29 minutes). */
export const UNANSWERED_AFTER_MINUTES = 35;

/**
 * The minute job's expiry, every command that can no longer run, each with its own audit entry in the same transaction (F4):
 * - queued and past its expiry, never handed over;
 * - handed to a poll that never confirmed it (its answer went into a dead connection), whose lifetime ran out before it could be
 *   offered again, so it is not left looking as if it were running;
 * - delivered and unanswered for UNANSWERED_AFTER_MINUTES (the long-poll answer was lost, or the cabinet went offline), so the console
 *   stops showing it as running.
 * A result that still arrives is kept (storeResult). The changed rows come back through a table variable (OUTPUT INTO), which SQL Server
 * allows whatever triggers the table carries.
 */
export async function expireCommands(pool: Pool): Promise<number> {
  return transaction(pool, async tx => {
    const expired = (await tx.query<{ id: string; cabinet_id: string; operation: string; why: string }>(
      `DECLARE @now datetime2(3) = SYSUTCDATETIME();
       DECLARE @o TABLE (id uniqueidentifier, cabinet_id uniqueidentifier, operation nvarchar(64), why varchar(16));
       UPDATE commands SET status = 'expired'
         OUTPUT inserted.id, inserted.cabinet_id, inserted.operation,
                CASE WHEN deleted.status = 'queued' THEN 'never_delivered'
                     WHEN deleted.delivered_at < DATEADD(minute, -$1, @now) THEN 'unanswered' ELSE 'unconfirmed' END
           INTO @o (id, cabinet_id, operation, why)
        WHERE (status = 'queued' AND expires_at <= @now)
           OR (status = 'delivered' AND ack_at IS NULL AND result_at IS NULL AND lease_until <= @now AND expires_at <= @now)
           OR (status = 'delivered' AND delivered_at < DATEADD(minute, -$1, @now));
       SELECT id, cabinet_id, operation, why FROM @o;`, [UNANSWERED_AFTER_MINUTES])).rows;
    if (expired.length > 0)
      await auditMany(tx, expired.map(r => ({ actorKind: "system", actorId: "command-expiry", action: "command.expire", targetKind: "command", targetId: r.id.toLowerCase(),
        outcome: "succeeded", details: { cabinetId: r.cabinet_id.toLowerCase(), operation: r.operation,
          why: r.why, ...(r.why === "unanswered" ? { unansweredMinutes: UNANSWERED_AFTER_MINUTES } : {}),
          automatic: true } })));
    return expired.length;
  });
}

// ---- Retention (F21.R2, decision-log D72) -----------------------------------------------------------------------------------------------

/**
 * Clears the stored answer, and its search text, of commands whose result arrived before `cutoff`. The command itself (what was asked,
 * who asked and when, its outcome) stays in the history. In batches, each batch audited; a repeat clears nothing more.
 */
export async function clearOldCommandResults(db: Queryable, cutoff: Date, o: BatchOptions = RETENTION_BATCH): Promise<number> {
  checkRetentionCutoff(cutoff);
  return inBatches(db, "UPDATE TOP ($1) commands SET result = NULL, search_text = NULL WHERE result IS NOT NULL AND result_at < $2", [cutoff], o,
    { table: "commands.result", cutoff });
}

/** Removes firewall changes that happened before `cutoff`, in batches, each batch audited; a repeat removes nothing more. */
export async function pruneFirewallChanges(db: Queryable, cutoff: Date, o: BatchOptions = RETENTION_BATCH): Promise<number> {
  checkRetentionCutoff(cutoff);
  return inBatches(db, "DELETE TOP ($1) FROM firewall_changes WHERE occurred_at < $2", [cutoff], o, { table: "firewall_changes", cutoff });
}

const CABINET_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * An agent's firewall_changed event, put into the cabinet's firewall history (F21.R2, decision-log D84). A change made through the
 * platform was already recorded from the write's own result; its first event confirms it by setting the event on that row. Any other
 * event (no command, or a later one for the same command: a profile's timer turning it back on, a safety-net rollback) is a further
 * change. Called by storeEvents in the batch's transaction, for an event it has just stored. The event is checked against its contract
 * and the cabinet id before the database is touched.
 */
export async function recordFirewallEvent(c: Queryable, cabinetId: string, event: Event): Promise<void> {
  if (typeof cabinetId !== "string" || !CABINET_ID.test(cabinetId)) throw new Error("a cabinet id is required to record a firewall change");
  const e = envelopes.event.parse(event);
  if (e.kind !== "firewall_changed") throw new Error(`only a firewall_changed event goes into the firewall history, not ${String(e.kind)}`);
  const linked = e.commandId ? await c.query("UPDATE firewall_changes SET event_id = $2 WHERE id = (SELECT TOP (1) id FROM firewall_changes WHERE command_id = $1 AND event_id IS NULL)",
    [e.commandId, e.eventId]) : null;
  if (!linked || linked.rowCount === 0)
    await c.query(`INSERT INTO firewall_changes (cabinet_id, command_id, event_id, explained, detail, occurred_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [cabinetId, e.commandId ?? null, e.eventId, !!e.commandId, e.detail ? safeJson(e.detail) : null, new Date(e.occurredAt)]);
}
