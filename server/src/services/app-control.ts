// One control request from the console (docs/spec/13-roadmap.md milestone 10): a Tier 2 names one entry of the cabinet's
// approved-applications list and an action, and nothing else.
//
// Why the target is looked up and never sent: the whole point of the list is that only the owner decides which programs the
// platform may touch. A request that could still carry a service name, an image path or a command line would make the list a
// suggestion, so the body has no field for any of them and nothing here builds a target from caller text.
//
// Why a process ID alone is not a target: Windows reuses process IDs, so an ID from a person may name a different program by
// the time it is used. The ID is a pointer only: it is resolved against the process list the cabinet ITSELF reported last (the
// same processes.list reading the cabinet page already shows), and the program the cabinet says is running under it must be the
// entry's own path, character for character, before anything is issued. An ID the cabinet never reported is refused.
//
// Why step-up is bound to the request and not to the route: a token bought to confirm one entry would otherwise be spendable on
// another. Every request must carry a token confirmed for this exact entry, this action and this cabinet - the canonical hash
// of the body without the token - and a token that does not match is refused. See docs/spec/09-open-decisions.md.
//
// One audit row per request, refusals included: the actor, the cabinet, the entry key and action as they were sent, the
// outcome, the reason when refused, and the same before/after pair the platform's writes record. `before` is the state the
// cabinet last reported, `after` is the state the request asks for, so a later change can leave out rows where nothing moved.
import type { Pool, Queryable } from "../db/db.js";
import { audit, transaction } from "../db/db.js";
import type { AuditEntry } from "../db/db.js";
import type { Command } from "../contracts.js";
import { appLevels, rawEntry, type AppLevels } from "./approved-apps.js";
import { issueFromConsole, type Role } from "./console-commands.js";
import { Refused } from "./errors.js";
import { keyProblem } from "./filefacts-path.js";
import { reportedProcesses, reportedServices } from "./controlled-targets.js";

export { reportedProcesses, reportedServices, type ReportedProcess, type ReportedService } from "./controlled-targets.js";

/**
 * The refusals one control request can get, as codes a Tier 2 can act on. Each says what to do next, not just that something
 * was wrong: an entry that is not approved is a different conversation from an action the entry's kind does not allow.
 */
export const CONTROL_CODES = {
  /** The key is not shaped like an entry key at all (a path, a bare service name, an empty string, control characters). */
  entryInvalid: "control_entry_invalid",
  /** The key is well formed but is not on the list that applies to this cabinet. */
  entryNotApproved: "control_entry_not_approved",
  /** Not an action the platform defines for a control request. */
  actionUnknown: "control_action_unknown",
  /** An action the platform knows, but not one this entry's kind allows. */
  actionNotAllowed: "control_action_not_allowed",
  /** An action this entry's kind allows in principle but the platform does not do yet (restarting an application). */
  actionNotSupported: "control_action_not_supported",
  /** An end without the process ID the cabinet reported. */
  pidRequired: "control_pid_required",
  /** The cabinet has never reported its processes, so no ID can be resolved against anything. */
  processNoReading: "control_process_no_reading",
  /** The cabinet's last reported process list has no such ID. */
  processUnreported: "control_process_unreported",
  /** The ID exists, but the program under it is not the program this entry approves. */
  processNotApproved: "control_process_not_approved",
  /** The token is real but was confirmed for another entry, another action or another cabinet (or has expired, or was used). */
  stepUpWrongScope: "step_up_wrong_scope",
} as const;

/** The step-up action a service control's token is bound to: the operation's own name, as the rest of the platform names them. */
export const SERVICE_CONTROL_STEP_UP = "service.control";
/** The step-up action a process end's token is bound to. */
export const PROCESS_END_STEP_UP = "process.end";
/** The audit action every control request is recorded under, whatever the outcome. */
export const CONTROL_AUDIT_ACTION = "app.control";
/** What a control request may ask for. Which of these an entry allows is decided by its kind, below. */
export const CONTROL_ACTIONS = ["start", "stop", "restart", "end"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];
/** How much caller text one audit row keeps: a hostile key is still recorded, but it cannot bloat the row. */
export const MAX_ATTEMPTED = 64;

/** A control request as the route checked it against its contract. */
export interface ControlRequest {
  cabinetId: string;
  entryKey: string;
  action: string;
  processId?: number;
  stepUpToken: string;
}

/** What the platform will act on, as it was resolved here: never anything the caller wrote. */
export interface ControlTarget {
  operation: string;
  params: Record<string, unknown>;
  /** The state the cabinet last reported for the target, in the operation's own vocabulary; null when it reported none. */
  before: unknown;
  /** The state the request asks for, in the operation's own vocabulary. What actually happened comes back with the command's result. */
  after: unknown;
  /** When the cabinet reported the state used above, so a reader can see how fresh it is. */
  reportedAt: string | null;
}

/** What the platform did with one control request. */
export interface ControlOutcome {
  commandId: string;
  issuedAt: string;
  expiresAt: string;
  entryKey: string;
  action: string;
  operation: string;
  /** The service name, or the process ID and name, that the entry and the cabinet's own report resolved to. */
  target: Record<string, unknown>;
  /** The state the cabinet had last reported, so the console can show what this changes. */
  before: unknown;
}

/**
 * Everything a control request does to the outside world, in one place: the single audit row, the token, and the issue. The
 * real ones are the platform's own (audit, issueFromConsole, which spends the token); tests stand in for them, so the decisions
 * above can be exercised without a database while the route still goes through exactly these calls.
 */
export interface ControlEffects {
  /** One row per request, refusals included. */
  record(entry: AuditEntry): Promise<void>;
  /** Issues the operation through the one path every console command takes. `confirmed` is what the token was confirmed for. */
  issue(user: { userId: string; role: Role }, cabinetId: string, operation: string, params: Record<string, unknown>,
    token: string | undefined, confirmed: unknown): Promise<Command>;
}

export function controlEffects(pool: Pool): ControlEffects {
  return {
    record: (entry: AuditEntry) => transaction(pool, c => audit(c, entry)).then(() => undefined),
    issue: (user, cabinetId, operation, params, token, confirmed) => issueFromConsole(pool, user, cabinetId, operation, params, token, false, confirmed),
  };
}

/** Caller text as the audit row keeps it: printable and bounded. A hostile key is still recorded - that is what an audit log is for - but it cannot smuggle control characters in or fill the row. */
const asAttempted = (v: unknown): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, MAX_ATTEMPTED) : "");

/**
 * The body without the token: exactly what the person confirmed when they bought it. The console sends the canonical hash of
 * this object with the code, and the token then covers this entry, this action and this cabinet and nothing else.
 */
export const boundParams = (body: ControlRequest): Record<string, unknown> => {
  const { stepUpToken: _token, ...rest } = body;
  return rest;
};

/**
 * One control request, start to finish. The entry is resolved from the list that applies to this cabinet (its most specific
 * level, whole), the action is checked against the entry's kind, the target is looked up - never taken from the body - and the
 * operation is issued through issueFromConsole behind a token bound to this exact request. Every outcome, refusal included,
 * leaves one audit row.
 */
export async function controlApproved(db: Queryable, user: { userId: string; role: Role }, body: ControlRequest, effects: ControlEffects): Promise<ControlOutcome> {
  const asSent = { entryKey: asAttempted(body.entryKey), action: asAttempted(body.action) };
  const targetId = asAttempted(body.cabinetId);
  // The row is written first and the refusal thrown after, so a refusal is never silent: a control request that named
  // something it may not touch is exactly what someone reading the audit log wants to see. Throwing the answer keeps the
  // checks below plain `if ... throw` statements, so the compiler can see that nothing after them can still be reached.
  const refusal = async (code: string, status: number, why: string, extra: Record<string, unknown> = {}): Promise<Refused> => {
    await effects.record({ actorKind: "user", actorId: user.userId, action: CONTROL_AUDIT_ACTION, targetKind: "cabinet", targetId,
      outcome: "refused", details: { ...asSent, ...extra, reason: code, why } });
    return new Refused(code, status, why);
  };

  // The most specific level with a list wins whole: an entry approved for another cabinet, or sitting at a level this
  // cabinet's own list overrides, is not on the list that applies here, and that is the only list consulted.
  let levels: AppLevels;
  try {
    levels = await appLevels(db, body.cabinetId);
  } catch (e) {
    if (e instanceof Refused) throw await refusal(e.code, e.status, e.message);
    throw e;
  }

  const keyFault = keyProblem(body.entryKey);
  if (keyFault) throw await refusal(CONTROL_CODES.entryInvalid, 400, `the entry key is not an approved-list key (${keyFault}): an entry key looks like app:<name>`);
  const found = levels.effective?.entries.find(e => e.key === body.entryKey) ?? null;
  if (!found) {
    const where = levels.source === "none" ? "no level sets a list" : `the list from the ${levels.source} level applies`;
    const ignored = levels.rejected.length > 0 ? `; a list at ${levels.rejected.join(", ")} does not describe its own entries and was ignored` : "";
    throw await refusal(CONTROL_CODES.entryNotApproved, 403, `that entry is not on this cabinet's approved list (${where})${ignored}`,
      { listFrom: levels.source, rejected: levels.rejected });
  }

  if (!(CONTROL_ACTIONS as readonly string[]).includes(body.action))
    throw await refusal(CONTROL_CODES.actionUnknown, 400, `"${asSent.action}" is not a control action: a control request asks for start, stop, restart or end`, { listFrom: levels.source });
  const action = body.action as ControlAction;

  // An entry's kind decides what may be done with it. A service is controlled through the service control manager; an
  // application has no such handle, so it is ended as a process (and restarting one is a later change, not a silent shortcut).
  if (found.kind === "application" && (action === "start" || action === "stop"))
    throw await refusal(CONTROL_CODES.actionNotAllowed, 403, `an application entry is ended or restarted, not started or stopped: ${asSent.action} is a service action`, { kind: found.kind });
  if (found.kind === "application" && action === "restart")
    throw await refusal(CONTROL_CODES.actionNotSupported, 409, "restarting an application is not built yet: end the process, then start the program on the cabinet", { kind: found.kind });

  const approved = rawEntry(found);
  let target: ControlTarget;
  if (action === "end") {
    if (body.processId === undefined)
      throw await refusal(CONTROL_CODES.pidRequired, 400, "ending a process needs the process ID the cabinet itself reported: this request carries none", { kind: found.kind });
    const reported = await reportedProcesses(db, body.cabinetId);
    if (!reported)
      throw await refusal(CONTROL_CODES.processNoReading, 409, "this cabinet has never reported its processes, so no process ID can be resolved against its own account of what is running",
        { kind: found.kind, processId: body.processId });
    const row = reported.processes.find(p => p.processId === body.processId);
    if (!row)
      throw await refusal(CONTROL_CODES.processUnreported, 404, `the cabinet's own process list (${reported.at}) has no process ${body.processId}`,
        { kind: found.kind, processId: body.processId, reportedAt: reported.at });
    if (row.executablePath === null || row.executablePath !== approved.path)
      throw await refusal(CONTROL_CODES.processNotApproved, 403, `the program the cabinet reports under process ${body.processId} is not the program this entry approves, so it is not controlled`,
        { kind: found.kind, processId: body.processId, reportedPath: row.executablePath, approvedPath: approved.path });
    target = {
      operation: "process.end",
      // Both values come from the cabinet's own report: the name is what will be checked against the ID again when the
      // command runs, so a re-used ID names a different process and the agent refuses it.
      params: { processId: row.processId, name: row.name },
      before: { processId: row.processId, name: row.name, executablePath: row.executablePath },
      after: { processId: row.processId, name: row.name, ended: true },
      reportedAt: reported.at,
    };
  } else {
    const serviceName = approved.serviceName;
    // A service entry without its own name cannot be aimed at anything, and the list's own check refuses one, so this is a
    // broken invariant rather than a caller's mistake: fail loudly instead of controlling a service nobody named.
    if (!serviceName) throw new Error("an approved service entry without its service name passed the list's own check");
    const services = await reportedServices(db, body.cabinetId);
    const reported = services?.services.find(s => s.name === serviceName) ?? null;
    target = {
      operation: "service.control",
      params: { name: serviceName, action },
      before: reported?.state ?? null,
      after: action === "stop" ? "stopped" : "running",
      reportedAt: services?.at ?? null,
    };
  }

  const bound = boundParams(body);
  if (!body.stepUpToken)
    throw await refusal("step_up_required", 403, "every control action needs a fresh confirmation for this exact entry, action and cabinet", { kind: found.kind, operation: target.operation });

  let command: Command;
  try {
    // Both operations spend the request's token inside the command's own transaction, so the command and the token's use commit
    // together. The token was bought for this entry, action and cabinet (the body the hash covers), so a token bought for another
    // entry, or for the generic command route's {name, action} or {processId, name}, is not spendable here.
    command = await effects.issue(user, body.cabinetId, target.operation, target.params, body.stepUpToken, bound);
  } catch (e) {
    if (e instanceof Refused && e.code === "step_up_required")
      throw await refusal(CONTROL_CODES.stepUpWrongScope, 403, `the confirmation was not for exactly this entry and action, or it has expired, or it was already used: confirm ${asSent.action} on ${asSent.entryKey} again`,
        { operation: target.operation, stepUpAction: target.operation === "service.control" ? SERVICE_CONTROL_STEP_UP : PROCESS_END_STEP_UP });
    if (e instanceof Refused) throw await refusal(e.code, e.status, e.message, { operation: target.operation, kind: found.kind, params: target.params });
    await effects.record({ actorKind: "user", actorId: user.userId, action: CONTROL_AUDIT_ACTION, targetKind: "cabinet", targetId,
      outcome: "failed", details: { ...asSent, operation: target.operation, reason: "control_failed", why: e instanceof Error ? e.message : "the operation could not be issued" } });
    throw e;
  }

  await effects.record({ actorKind: "user", actorId: user.userId, action: CONTROL_AUDIT_ACTION, targetKind: "cabinet", targetId, outcome: "succeeded",
    details: { ...asSent, kind: found.kind, operation: target.operation, params: target.params, commandId: command.commandId,
      listFrom: levels.source, rejected: levels.rejected, before: target.before, after: target.after, reportedAt: target.reportedAt } });

  return { commandId: command.commandId, issuedAt: command.issuedAt, expiresAt: command.expiresAt, entryKey: asSent.entryKey, action,
    operation: target.operation, target: target.params, before: target.before };
}