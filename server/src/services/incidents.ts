// The unified incident record (docs/platform/archive/diagnostic-engine-execution.md, "The foundation in detail", item 2; migration 0017). One
// incident follows one problem on one cabinet from its symptom to a verified repair or a stated outcome. Steps are appended in order and
// never changed, and each one is written to the audit log in the same transaction. The incident's state follows from the steps:
//
//   open --proposed_repair--> awaiting_approval --approval--> approved --execution--> repairing --verification passed--> resolved
//                                                                                        `--verification failed or incomplete--> open
//   any state that is not closed --close--> resolved or unresolved
//
// An approval is always a person's: the system never approves its own proposal. An execution names the command it sent, which must be
// a command to this incident's cabinet. A closed incident takes no more steps. Links name alerts, diagnoses, commands, case notes and
// fleet jobs of the same cabinet. Nothing here runs anything on a cabinet: it records what other services did.
import { randomUUID } from "node:crypto";
import { audit, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { Refused } from "./errors.js";

export type IncidentState = "open" | "awaiting_approval" | "approved" | "repairing" | "resolved" | "unresolved";
export type StepKind = "symptom" | "evidence" | "hypothesis" | "proposed_repair" | "approval" | "execution" | "verification" | "note" | "close";
export type LinkKind = "alert" | "diagnosis" | "command" | "case_note" | "fleet_job";
export type Actor = { kind: "user"; userId: string } | { kind: "system"; name: string };
/** A step's own small record: at most 20 fields of short text, numbers, true or false, or nothing. */
export type StepDetail = Record<string, string | number | boolean | null>;

export interface StepInput {
  kind: Exclude<StepKind, "symptom">;
  summary: string;
  detail?: StepDetail;
  /** For an execution: the command it sent. */
  commandId?: string;
  /** For a verification: what it showed. For a close: how the incident ended. */
  result?: "passed" | "failed" | "incomplete" | "resolved" | "unresolved";
}

export interface Step { position: number; kind: StepKind; actor: Actor; at: string; summary: string; detail: StepDetail | null }
export interface Link { kind: LinkKind; refId: string; linkedAt: string }
export interface Incident {
  id: string; cabinetId: string; state: IncidentState; symptom: string; module: { id: string; version: number } | null;
  openedBy: Actor; openedAt: string; updatedAt: string; closedAt: string | null; outcome: string | null; steps: Step[]; links: Link[];
}

const CLOSED: readonly IncidentState[] = ["resolved", "unresolved"];
const STEP_KINDS: readonly StepKind[] = ["evidence", "hypothesis", "proposed_repair", "approval", "execution", "verification", "note", "close"];
const LINK_KINDS: readonly LinkKind[] = ["alert", "diagnosis", "command", "case_note", "fleet_job"];
const MAX_DETAIL_FIELDS = 20;
const MAX_DETAIL_BYTES = 8192;

/** The state an incident moves to when this step is appended, or why the step is not allowed now. Pure. */
export function nextState(state: IncidentState, step: Pick<StepInput, "kind" | "result">, actor: Actor): { state: IncidentState } | { refused: string } {
  if (CLOSED.includes(state)) return { refused: "the incident is closed" };
  switch (step.kind) {
    case "evidence": case "hypothesis": case "note":
      return { state };
    case "proposed_repair":
      return state === "open" || state === "awaiting_approval" ? { state: "awaiting_approval" } : { refused: "a repair can be proposed only while the incident is open or awaiting approval" };
    case "approval":
      if (actor.kind !== "user") return { refused: "only a person approves a repair" };
      return state === "awaiting_approval" ? { state: "approved" } : { refused: "there is no proposed repair waiting for approval" };
    case "execution":
      return state === "approved" ? { state: "repairing" } : { refused: "a repair runs only after it is approved" };
    case "verification":
      if (state !== "repairing") return { refused: "only a repair that ran can be verified" };
      if (step.result === "passed") return { state: "resolved" };
      if (step.result === "failed" || step.result === "incomplete") return { state: "open" };
      return { refused: "a verification says passed, failed or incomplete" };
    case "close":
      if (step.result === "resolved" || step.result === "unresolved") return { state: step.result };
      return { refused: "a close says resolved or unresolved" };
  }
}

// ---- Checks on what is stored ------------------------------------------------------------------------------------------------------

const isControl = (code: number) => code < 32 || code === 127 || (code >= 0x80 && code < 0xa0) || code === 0x2028 || code === 0x2029;
/** One line of text, 1 to `max` characters, no control characters. Refused rather than cleaned: these come from the platform's own code. */
function plainText(value: unknown, max: number, what: string): string {
  if (typeof value !== "string") throw new Refused("invalid_request", 400, `${what} must be text`);
  const text = value.trim();
  if (text.length === 0 || text.length > max) throw new Refused("invalid_request", 400, `${what} must be 1 to ${max} characters`);
  for (const ch of text) if (isControl(ch.codePointAt(0)!)) throw new Refused("invalid_request", 400, `${what} must be one line of plain text`);
  return text;
}
const isLetter = (c: string) => c >= "a" && c <= "z";
const isKeyChar = (c: string) => isLetter(c) || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9");
function isUuid(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 36) return false;
  for (let i = 0; i < 36; i++) {
    const c = value[i]!;
    if (i === 8 || i === 13 || i === 18 || i === 23) { if (c !== "-") return false; }
    else if (!((c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F"))) return false;
  }
  return true;
}
function uuid(value: unknown, what: string): string {
  if (!isUuid(value)) throw new Refused("invalid_request", 400, `${what} must be an id`);
  return value.toLowerCase();
}

/** A step's detail: a plain object of at most 20 named fields, each short text, a finite number, true or false, or nothing. */
export function checkDetail(detail: unknown): StepDetail {
  if (typeof detail !== "object" || detail === null || Array.isArray(detail) || Object.getPrototypeOf(detail) !== Object.prototype)
    throw new Refused("invalid_request", 400, "a step's detail must be a plain object");
  const entries = Object.entries(detail);
  if (entries.length > MAX_DETAIL_FIELDS) throw new Refused("invalid_request", 400, `a step's detail has at most ${MAX_DETAIL_FIELDS} fields`);
  const out: StepDetail = Object.create(null) as StepDetail;
  for (const [key, value] of entries) {
    if (key.length < 1 || key.length > 40 || !isLetter(key[0]!) || ![...key].every(isKeyChar)) throw new Refused("invalid_request", 400, "a detail field's name must be a short word");
    if (value === null || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number") { if (!Number.isFinite(value)) throw new Refused("invalid_request", 400, "a detail number must be finite"); out[key] = value; }
    else if (typeof value === "string") out[key] = plainText(value, 300, "a detail field");
    else throw new Refused("invalid_request", 400, "a detail field must be text, a number, true or false, or nothing");
  }
  if (Buffer.byteLength(safeJson(out)) > MAX_DETAIL_BYTES) throw new Refused("invalid_request", 400, "a step's detail is too large");
  return { ...out };
}

function actorOf(a: Actor): { kind: "user" | "system"; id: string } {
  if (a.kind === "user") return { kind: "user", id: uuid(a.userId, "the person") };
  return { kind: "system", id: plainText(a.name, 64, "the system actor's name") };
}
const auditActor = (a: { kind: "user" | "system"; id: string }) => ({ actorKind: a.kind, actorId: a.id });

// ---- Writing --------------------------------------------------------------------------------------------------------------------

/** Opens an incident on a cabinet with its symptom as the first step. Returns its id. */
export async function openIncident(pool: Pool, o: { cabinetId: string; symptom: string; module?: { id: string; version: number }; by: Actor }): Promise<string> {
  const cabinetId = uuid(o.cabinetId, "the cabinet");
  const symptom = plainText(o.symptom, 200, "the symptom");
  const by = actorOf(o.by);
  const module = o.module === undefined ? null : { id: plainText(o.module.id, 64, "the module"), version: o.module.version };
  if (module && (!Number.isInteger(module.version) || module.version < 1 || module.version > 1_000_000)) throw new Refused("invalid_request", 400, "the module version must be a whole number from 1");
  const id = randomUUID();
  await transaction(pool, async c => {
    const cabinet = (await c.query<{ id: string }>("SELECT id FROM cabinets WHERE id = $1", [cabinetId])).rows[0];
    if (!cabinet) throw new Refused("not_found", 404, "No such cabinet");
    await mustExist(c, by);
    await c.query(`INSERT INTO incidents (id, cabinet_id, symptom, module_id, module_version, opened_by_kind, opened_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, cabinetId, symptom, module?.id ?? null, module?.version ?? null, by.kind, by.id]);
    await c.query(`INSERT INTO incident_steps (incident_id, position, kind, actor_kind, actor_id, summary) VALUES ($1, 1, 'symptom', $2, $3, $4)`, [id, by.kind, by.id, symptom]);
    await audit(c, { ...auditActor(by), action: "incident.open", targetKind: "incident", targetId: id, outcome: "succeeded",
      details: { cabinetId, module: module ? `${module.id}@${module.version}` : null } });
  });
  return id;
}

/** Appends one step and moves the incident's state. Locks the incident row so two steps never take the same position. */
export async function appendStep(pool: Pool, incidentId: string, step: StepInput, by: Actor): Promise<{ position: number; state: IncidentState }> {
  const id = uuid(incidentId, "the incident");
  if (!STEP_KINDS.includes(step.kind)) throw new Refused("invalid_request", 400, "unknown step kind");
  const summary = plainText(step.summary, 300, "the step's summary");
  const detail = step.detail === undefined ? null : checkDetail(step.detail);
  const actor = actorOf(by);
  const commandId = step.kind === "execution" ? uuid(step.commandId, "the command") : undefined;
  if (step.kind !== "execution" && step.commandId !== undefined) throw new Refused("invalid_request", 400, "only an execution names a command");
  const done = await transaction(pool, async c => {
    const row = (await c.query<{ cabinet_id: string; state: IncidentState }>(
      "SELECT cabinet_id, state FROM incidents WITH (UPDLOCK, ROWLOCK) WHERE id = $1", [id])).rows[0];
    if (!row) throw new Refused("not_found", 404, "No such incident");
    await mustExist(c, actor);
    const next = nextState(row.state, step, by);
    if ("refused" in next) return { refused: next.refused };
    if (commandId !== undefined) {
      const command = (await c.query<{ id: string }>("SELECT id FROM commands WHERE id = $1 AND cabinet_id = $2", [commandId, row.cabinet_id])).rows[0];
      if (!command) throw new Refused("not_found", 404, "No such command for this cabinet");
    }
    const position = Number((await c.query<{ n: number }>("SELECT COALESCE(MAX(position), 0) + 1 AS n FROM incident_steps WHERE incident_id = $1", [id])).rows[0]!.n);
    const stored = { ...(detail ?? {}), ...(step.result !== undefined ? { result: step.result } : {}), ...(commandId !== undefined ? { commandId } : {}) };
    await c.query(`INSERT INTO incident_steps (incident_id, position, kind, actor_kind, actor_id, summary, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, position, step.kind, actor.kind, actor.id, summary, Object.keys(stored).length ? safeJson(stored) : null]);
    if (commandId !== undefined) await insertLink(c, id, "command", commandId);
    const closing = CLOSED.includes(next.state);
    await c.query(`UPDATE incidents SET state = $2, updated_at = SYSUTCDATETIME(), closed_at = CASE WHEN $3 = 1 THEN SYSUTCDATETIME() ELSE closed_at END,
                     outcome = CASE WHEN $3 = 1 THEN $4 ELSE outcome END WHERE id = $1`, [id, next.state, closing ? 1 : 0, closing ? summary : null]);
    await audit(c, { ...auditActor(actor), action: "incident.step", targetKind: "incident", targetId: id, outcome: "succeeded",
      details: { kind: step.kind, position, from: row.state, to: next.state, ...(commandId !== undefined ? { commandId } : {}) } });
    return { position, state: next.state };
  });
  if ("refused" in done) {
    // Recorded on its own: the step's transaction wrote nothing, and the refusal must survive it.
    await transaction(pool, c => audit(c, { ...auditActor(actor), action: "incident.step", targetKind: "incident", targetId: id, outcome: "refused",
      details: { kind: step.kind, reason: done.refused } }));
    throw new Refused("wrong_stage", 409, done.refused);
  }
  return done;
}

/** A person named as the actor must be an account the platform has. */
async function mustExist(c: Queryable, actor: { kind: "user" | "system"; id: string }): Promise<void> {
  if (actor.kind === "user" && !(await c.query("SELECT 1 AS ok FROM users WHERE id = $1", [actor.id])).rows[0]) throw new Refused("not_found", 404, "No such person");
}

async function insertLink(c: Queryable, incidentId: string, kind: LinkKind, refId: string): Promise<boolean> {
  const r = await c.query(`INSERT INTO incident_links (incident_id, kind, ref_id) SELECT $1, $2, $3
                            WHERE NOT EXISTS (SELECT 1 FROM incident_links WHERE incident_id = $1 AND kind = $2 AND ref_id = $3)`, [incidentId, kind, refId]);
  return (r.rowCount ?? 0) > 0;
}

const LINK_OWNER: Record<LinkKind, string> = {
  alert: "SELECT 1 AS ok FROM alerts WHERE id = $1 AND cabinet_id = $2",
  diagnosis: "SELECT 1 AS ok FROM diagnoses WHERE id = $1 AND cabinet_id = $2",
  command: "SELECT 1 AS ok FROM commands WHERE id = $1 AND cabinet_id = $2",
  case_note: "SELECT 1 AS ok FROM case_notes WHERE id = $1 AND cabinet_id = $2",
  fleet_job: "SELECT 1 AS ok FROM fleet_job_targets WHERE job_id = $1 AND cabinet_id = $2",
};

/** Links an alert, diagnosis, command, case note or fleet job of the incident's own cabinet. Linking the same thing twice changes nothing. */
export async function linkIncident(pool: Pool, incidentId: string, kind: LinkKind, refId: string, by: Actor): Promise<{ added: boolean }> {
  const id = uuid(incidentId, "the incident");
  if (!LINK_KINDS.includes(kind)) throw new Refused("invalid_request", 400, "unknown link kind");
  const ref = uuid(refId, "the linked record");
  const actor = actorOf(by);
  return transaction(pool, async c => {
    const row = (await c.query<{ cabinet_id: string }>("SELECT cabinet_id FROM incidents WITH (UPDLOCK, ROWLOCK) WHERE id = $1", [id])).rows[0];
    if (!row) throw new Refused("not_found", 404, "No such incident");
    await mustExist(c, actor);
    if (!(await c.query(LINK_OWNER[kind], [ref, row.cabinet_id])).rows[0]) throw new Refused("not_found", 404, `No such ${kind.replace("_", " ")} for this cabinet`);
    const added = await insertLink(c, id, kind, ref);
    if (added) await audit(c, { ...auditActor(actor), action: "incident.link", targetKind: "incident", targetId: id, outcome: "succeeded", details: { kind, refId: ref } });
    return { added };
  });
}

// ---- Reading --------------------------------------------------------------------------------------------------------------------

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
const actorFrom = (kind: string, id: string): Actor => (kind === "user" ? { kind: "user", userId: id.toLowerCase() } : { kind: "system", name: id });

/** One incident with its steps in order and its links, or null. */
export async function getIncident(db: Queryable, incidentId: string): Promise<Incident | null> {
  if (!isUuid(incidentId)) return null;
  const r = (await db.query<{ id: string; cabinet_id: string; state: IncidentState; symptom: string; module_id: string | null; module_version: number | null;
    opened_by_kind: string; opened_by: string; opened_at: Date; updated_at: Date; closed_at: Date | null; outcome: string | null }>(
    "SELECT * FROM incidents WHERE id = $1", [incidentId])).rows[0];
  if (!r) return null;
  const steps = (await db.query<{ position: number; kind: StepKind; actor_kind: string; actor_id: string; at: Date; summary: string; detail: string | null }>(
    "SELECT position, kind, actor_kind, actor_id, [at], summary, detail FROM incident_steps WHERE incident_id = $1 ORDER BY position", [incidentId])).rows;
  const links = (await db.query<{ kind: LinkKind; ref_id: string; linked_at: Date }>(
    "SELECT kind, ref_id, linked_at FROM incident_links WHERE incident_id = $1 ORDER BY linked_at, kind", [incidentId])).rows;
  return {
    id: r.id.toLowerCase(), cabinetId: r.cabinet_id.toLowerCase(), state: r.state, symptom: r.symptom,
    module: r.module_id === null ? null : { id: r.module_id, version: Number(r.module_version) },
    openedBy: actorFrom(r.opened_by_kind, r.opened_by), openedAt: iso(r.opened_at)!, updatedAt: iso(r.updated_at)!, closedAt: iso(r.closed_at), outcome: r.outcome,
    steps: steps.map(s => ({ position: Number(s.position), kind: s.kind, actor: actorFrom(s.actor_kind, s.actor_id), at: iso(s.at)!, summary: s.summary,
      detail: s.detail === null ? null : (typeof s.detail === "string" ? JSON.parse(s.detail) : s.detail) as StepDetail })),
    links: links.map(l => ({ kind: l.kind, refId: l.ref_id.toLowerCase(), linkedAt: iso(l.linked_at)! })),
  };
}

/** A cabinet's incidents, newest first, without their steps. */
export async function cabinetIncidents(db: Queryable, cabinetId: string, limit = 50): Promise<Omit<Incident, "steps" | "links">[]> {
  if (!isUuid(cabinetId)) return [];
  const n = Math.max(1, Math.min(200, Math.trunc(limit)));
  const rows = (await db.query<{ id: string; cabinet_id: string; state: IncidentState; symptom: string; module_id: string | null; module_version: number | null;
    opened_by_kind: string; opened_by: string; opened_at: Date; updated_at: Date; closed_at: Date | null; outcome: string | null }>(
    `SELECT TOP (${n}) * FROM incidents WHERE cabinet_id = $1 ORDER BY opened_at DESC, id`, [cabinetId])).rows;
  return rows.map(r => ({ id: r.id.toLowerCase(), cabinetId: r.cabinet_id.toLowerCase(), state: r.state, symptom: r.symptom,
    module: r.module_id === null ? null : { id: r.module_id, version: Number(r.module_version) }, openedBy: actorFrom(r.opened_by_kind, r.opened_by),
    openedAt: iso(r.opened_at)!, updatedAt: iso(r.updated_at)!, closedAt: iso(r.closed_at), outcome: r.outcome }));
}

/** One open incident as the fleet triage list shows it: where, what, how far it got, and the last thing recorded. */
export interface OpenIncident {
  id: string; state: IncidentState; symptom: string; module: { id: string; version: number } | null; openedAt: string; updatedAt: string;
  cabinet: { id: string; name: string }; site: { id: string; name: string }; client: { id: string; name: string };
  steps: number; runs: number; lastStep: { kind: StepKind; summary: string; at: string };
}

/**
 * The fleet's incidents that are not closed, on active cabinets, most recently changed first, optionally for one client. `runs` is how
 * many diagnoses are linked: how many times the problem has been looked at.
 */
export async function openIncidents(db: Queryable, o: { clientId?: string; limit?: number } = {}): Promise<OpenIncident[]> {
  const n = Math.max(1, Math.min(200, Math.trunc(o.limit ?? 100)));
  const clientId = o.clientId === undefined ? null : uuid(o.clientId, "the client");
  const rows = (await db.query<{ id: string; state: IncidentState; symptom: string; module_id: string | null; module_version: number | null; opened_at: Date; updated_at: Date;
    cabinet_id: string; cabinet_name: string; site_id: string; site_name: string; client_id: string; client_name: string; steps: number; runs: number;
    last_kind: StepKind; last_summary: string; last_at: Date }>(
    `SELECT TOP (${n}) i.id, i.state, i.symptom, i.module_id, i.module_version, i.opened_at, i.updated_at,
            k.id AS cabinet_id, k.name AS cabinet_name, s.id AS site_id, s.name AS site_name, c.id AS client_id, c.name AS client_name,
            (SELECT count(*) FROM incident_steps st WHERE st.incident_id = i.id) AS steps,
            (SELECT count(*) FROM incident_links l WHERE l.incident_id = i.id AND l.kind = 'diagnosis') AS runs,
            last.kind AS last_kind, last.summary AS last_summary, last.[at] AS last_at
       FROM incidents i
       JOIN cabinets k ON k.id = i.cabinet_id AND k.status = 'active'
       JOIN sites s ON s.id = k.site_id
       JOIN clients c ON c.id = s.client_id
       CROSS APPLY (SELECT TOP (1) kind, summary, [at] FROM incident_steps st WHERE st.incident_id = i.id ORDER BY position DESC) last
      WHERE i.state NOT IN ('resolved', 'unresolved') AND ($1 IS NULL OR c.id = CAST($1 AS uniqueidentifier))
      ORDER BY i.updated_at DESC, i.id`, [clientId])).rows;
  return rows.map(r => ({
    id: r.id.toLowerCase(), state: r.state, symptom: r.symptom, module: r.module_id === null ? null : { id: r.module_id, version: Number(r.module_version) },
    openedAt: iso(r.opened_at)!, updatedAt: iso(r.updated_at)!,
    cabinet: { id: r.cabinet_id.toLowerCase(), name: r.cabinet_name }, site: { id: r.site_id.toLowerCase(), name: r.site_name }, client: { id: r.client_id.toLowerCase(), name: r.client_name },
    steps: Number(r.steps), runs: Number(r.runs), lastStep: { kind: r.last_kind, summary: r.last_summary, at: iso(r.last_at)! },
  }));
}
