// The stored diagnoses (F21.R2, decision-log D90): every write to the diagnoses table is here. The network diagnosis (network.ts) and
// the cabinet diagnosis (cabinet.ts) both store their runs through it. It sits below both because cabinet.ts imports network.ts, so
// neither could own the table without the other importing it back. Each write checks its input before the database is touched.
import { randomUUID } from "node:crypto";
import { safeJson, type Queryable } from "../db/db.js";
import { checkRetentionCutoff, inBatches, RETENTION_BATCH, type BatchOptions } from "../db/batches.js";

export type DiagnosisKind = "network" | "cabinet";
/** A command a diagnosis issued, as stored on its row: which read it was, the operation and the command id. */
export interface StoredCommand { key: string; operation: string; commandId: string }

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: readonly string[] = ["network", "cabinet"];
const MAX_FAILURE = 1000;
const MAX_COMMANDS = 200;

const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
function id(v: unknown, what: string): string {
  if (!isId(v)) throw new Error(`${what} must be an id`);
  return v;
}
function failureText(v: unknown): string {
  if (typeof v !== "string" || v.trim().length === 0 || v.length > MAX_FAILURE || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(v))
    throw new Error(`a diagnosis failure must be 1 to ${MAX_FAILURE} characters with no control characters`);
  return v;
}
function commandList(v: unknown): string {
  if (!Array.isArray(v) || v.length > MAX_COMMANDS) throw new Error(`a diagnosis's commands must be a list of at most ${MAX_COMMANDS}`);
  for (const c of v as unknown[]) {
    const o = c as Partial<StoredCommand> | null;
    if (typeof o !== "object" || o === null || typeof o.key !== "string" || o.key.length === 0 || o.key.length > 64
      || typeof o.operation !== "string" || o.operation.length === 0 || o.operation.length > 64 || !isId(o.commandId))
      throw new Error("each diagnosis command needs a key, an operation and a command id");
  }
  return safeJson((v as StoredCommand[]).map(c => ({ key: c.key, operation: c.operation, commandId: c.commandId })));
}
function jsonValue(v: unknown, what: string): string {
  if (v === undefined || typeof v === "function") throw new Error(`a diagnosis's ${what} are required`);
  return safeJson(v);
}

/** Stores a diagnosis that has started, with the commands issued so far. `batchId` is the network batch it belongs to, if any. */
export async function startDiagnosis(c: Queryable, d: { id: string; cabinetId: string; kind: DiagnosisKind; runBy: string; commands: StoredCommand[]; batchId: string | null }): Promise<void> {
  const rowId = id(d?.id, "the diagnosis"), cabinetId = id(d.cabinetId, "the cabinet"), runBy = id(d.runBy, "the person running it");
  if (!KINDS.includes(d.kind)) throw new Error("a diagnosis kind is network or cabinet");
  const batchId = d.batchId === null ? null : id(d.batchId, "the batch");
  const commands = commandList(d.commands);
  await c.query("INSERT INTO diagnoses (id, cabinet_id, kind, run_by, state, commands, batch_id) VALUES ($1, $2, $3, $4, 'running', $5, $6)",
    [rowId, cabinetId, d.kind, runBy, commands, batchId]);
}

/** Replaces the commands of a diagnosis once it has issued all of them. */
export async function recordDiagnosisCommands(c: Queryable, diagnosisId: string, commands: StoredCommand[]): Promise<void> {
  const rowId = id(diagnosisId, "the diagnosis"), list = commandList(commands);
  await c.query("UPDATE diagnoses SET commands = $2 WHERE id = $1", [rowId, list]);
}

/** Marks a diagnosis done with what it found and everything it read. */
export async function finishDiagnosis(c: Queryable, diagnosisId: string, findings: unknown, readings: unknown): Promise<void> {
  const rowId = id(diagnosisId, "the diagnosis");
  if (!Array.isArray(findings)) throw new Error("a diagnosis's findings must be a list");
  const f = jsonValue(findings, "findings"), r = jsonValue(readings, "readings");
  await c.query("UPDATE diagnoses SET state = 'done', finished_at = SYSUTCDATETIME(), findings = $2, readings = $3 WHERE id = $1", [rowId, f, r]);
}

/** Marks a diagnosis failed, with the sentence the console shows. */
export async function failDiagnosis(c: Queryable, diagnosisId: string, failure: string): Promise<void> {
  const rowId = id(diagnosisId, "the diagnosis"), text = failureText(failure);
  await c.query("UPDATE diagnoses SET state = 'failed', finished_at = SYSUTCDATETIME(), failure = $2 WHERE id = $1", [rowId, text]);
}

/**
 * Stores a batch member that never ran: offline when it was asked, or failed when its run could not start. It is finished at once, so
 * the batch counts it. Returns the new diagnosis id.
 */
export async function recordUnstartedDiagnosis(c: Queryable, d: { cabinetId: string; runBy: string; state: "offline" | "failed"; failure: string; batchId: string }): Promise<string> {
  const cabinetId = id(d?.cabinetId, "the cabinet"), runBy = id(d.runBy, "the person running it"), batchId = id(d.batchId, "the batch");
  if (d.state !== "offline" && d.state !== "failed") throw new Error("an unstarted diagnosis is offline or failed");
  const text = failureText(d.failure), rowId = randomUUID();
  await c.query("INSERT INTO diagnoses (id, cabinet_id, kind, run_by, state, finished_at, failure, batch_id) VALUES ($1, $2, 'network', $3, $4, SYSUTCDATETIME(), $5, $6)",
    [rowId, cabinetId, runBy, d.state, text, batchId]);
  return rowId;
}

/** Removes diagnoses started before `cutoff`, in batches, each batch audited (retention, decision-log D74). A cut-off that is not a past time is refused; a repeat removes nothing more. */
export async function pruneOldDiagnoses(db: Queryable, cutoff: Date, o: BatchOptions = RETENTION_BATCH): Promise<number> {
  checkRetentionCutoff(cutoff);
  return inBatches(db, "DELETE TOP ($1) FROM diagnoses WHERE started_at < $2", [cutoff], o, { table: "diagnoses", cutoff });
}
