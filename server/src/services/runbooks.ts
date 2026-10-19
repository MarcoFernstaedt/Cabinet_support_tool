// Runbooks (docs/spec/12-milestones-8-to-12.md "Runbooks"): the steps a support person follows for an issue type or a diagnosis finding, each with
// an optional read-only check and an optional one-click fix. A runbook gives no authority: a check is run through the same command path as any
// read, a fix through the same path as any write (the person's role, the write pause, the cabinet's read-only mode and the confirmation level
// all apply), and the server accepts only catalog reads and click-confirmed writes in a runbook at all. Tier 2 proposes, an Admin approves with
// an authenticator code, as with symptom rules. The platform's own runbooks (runbooks-builtin.ts) show until an Admin approves one of their own.
import { randomUUID } from "node:crypto";
import { audit, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { catalog, isOperationName, operations, type RunbookPropose, type RunbookQuery } from "../contracts.js";
import { Refused } from "./errors.js";
import { BUILT_IN_RUNBOOKS, type RunbookBody, type RunbookLink, type RunbookStep, type RunbookTarget } from "./runbooks-builtin.js";

/** The most text a runbook may hold in all (titles, details, labels), so one stays readable on a screen. */
export const MAX_RUNBOOK_TEXT = 4_000;
const MAX_PENDING_PER_TARGET = 3;
const MAX_PENDING_PER_USER = 10;

export interface RunbookView {
  /** null for the platform's own. */
  id: string | null;
  builtIn: boolean;
  target: RunbookTarget & { issueName?: string | null };
  title: string;
  steps: RunbookStep[];
  links: RunbookLink[];
  state: "proposed" | "approved" | "rejected" | "retired";
  version: number;
  proposedBy: string | null;
  proposedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

/** What a step may ask the console to run, checked against the catalog. Throws a Refused naming the step and the rule it broke. */
export function checkRunbookBody(b: Pick<RunbookPropose, "title" | "steps"> & { links?: RunbookLink[] | undefined }): void {
  let text = b.title.length;
  const bad = (i: number, why: string): never => { throw new Refused("invalid_runbook", 400, `step ${i + 1}: ${why}`); };
  b.steps.forEach((s, i) => {
    text += s.title.length + (s.detail?.length ?? 0) + (s.fix?.label.length ?? 0);
    if (s.check) {
      const op = s.check.operation;
      if (!isOperationName(op)) bad(i, "the check is not a catalog operation");
      else if (catalog.get(op)!.kind !== "read") bad(i, "a check can only be a read-only operation");
      else if (!operations[op].params.is(s.check.params)) bad(i, "the check's parameters do not fit the operation");
    }
    if (s.fix) {
      const op = s.fix.operation;
      if (!isOperationName(op)) bad(i, "the fix is not a catalog operation");
      else {
        const entry = catalog.get(op)!;
        if (entry.kind !== "write") bad(i, "a fix can only be a change operation");
        else if (entry.confirm !== "click") bad(i, "only changes confirmed by a click can be offered from a runbook; the rest need an authenticator code and are made from the cabinet's own pages");
        // The server fills in the client's policy; the browser (and so a runbook) sends no parameters for it.
        else if (op === "firewall.applyPolicy") { if (Object.keys(s.fix.params).length > 0) bad(i, "the firewall policy is filled in by the server; leave the parameters empty"); }
        else if (!operations[op].params.is(s.fix.params)) bad(i, "the fix's parameters do not fit the operation");
      }
    }
  });
  for (const l of b.links ?? []) text += l.label.length;
  if (text > MAX_RUNBOOK_TEXT) throw new Refused("invalid_runbook", 400, `a runbook holds at most ${MAX_RUNBOOK_TEXT} characters of text; this one has ${text}`);
}

type Row = { id: string; issue_type_id: string | null; finding_key: string | null; title: string; details: { steps: RunbookStep[]; links: RunbookLink[] }; state: RunbookView["state"];
  version: number; proposed_by_name: string; proposed_at: Date; decided_by_name: string | null; decided_at: Date | null; issue_name: string | null };
const SELECT = `SELECT r.id, r.issue_type_id, r.finding_key, r.title, r.details, r.state, r.version, p.name AS proposed_by_name, r.proposed_at, d.name AS decided_by_name, r.decided_at, t.name AS issue_name
  FROM runbooks r JOIN users p ON p.id = r.proposed_by LEFT JOIN users d ON d.id = r.decided_by LEFT JOIN issue_types t ON t.id = r.issue_type_id`;

const view = (r: Row): RunbookView => ({
  id: r.id, builtIn: false, target: r.issue_type_id ? { kind: "issue", issueTypeId: r.issue_type_id, issueName: r.issue_name } : { kind: "finding", key: r.finding_key! },
  title: r.title, steps: r.details?.steps ?? [], links: r.details?.links ?? [], state: r.state, version: r.version, proposedBy: r.proposed_by_name,
  proposedAt: r.proposed_at.toISOString(), decidedBy: r.decided_by_name, decidedAt: r.decided_at?.toISOString() ?? null,
});

const sameTarget = (a: RunbookTarget, b: RunbookTarget) => a.kind === b.kind && (a.kind === "issue" ? a.issueTypeId === (b as typeof a).issueTypeId : a.key === (b as typeof a).key);
const builtIn = (t: RunbookTarget): RunbookView | null => {
  const b = BUILT_IN_RUNBOOKS.find(x => sameTarget(x.target, t));
  return b ? { id: null, builtIn: true, target: t, title: b.body.title, steps: b.body.steps, links: b.body.links, state: "approved", version: 0, proposedBy: null, proposedAt: null, decidedBy: null, decidedAt: null } : null;
};

/** The runbook in force for an issue type or a finding: the approved one, else the platform's own, else none. */
export async function effectiveRunbook(db: Queryable, target: RunbookTarget): Promise<RunbookView | null> {
  const where = target.kind === "issue" ? "r.issue_type_id = $1" : "r.finding_key = $1";
  const r = (await db.query<Row>(`${SELECT} WHERE ${where} AND r.state = 'approved'`, [target.kind === "issue" ? target.issueTypeId : target.key])).rows[0];
  return r ? view(r) : builtIn(target);
}

/** Which of these issue types and finding keys have a runbook in force (for the list beside an alert or finding), without the steps. */
export async function runbookSummaries(db: Queryable, issueTypeIds: string[], findingKeys: string[]): Promise<{ issue: Map<string, { title: string; steps: number; builtIn: boolean }>; finding: Map<string, { title: string; steps: number; builtIn: boolean }> }> {
  const issue = new Map<string, { title: string; steps: number; builtIn: boolean }>(), finding = new Map<string, { title: string; steps: number; builtIn: boolean }>();
  for (const b of BUILT_IN_RUNBOOKS) {
    const s = { title: b.body.title, steps: b.body.steps.length, builtIn: true };
    if (b.target.kind === "issue") { if (issueTypeIds.includes(b.target.issueTypeId)) issue.set(b.target.issueTypeId, s); }
    else if (findingKeys.includes(b.target.key)) finding.set(b.target.key, s);
  }
  if (issueTypeIds.length + findingKeys.length === 0) return { issue, finding };
  const rows = (await db.query<{ issue_type_id: string | null; finding_key: string | null; title: string; steps: number }>(
    `SELECT r.issue_type_id, r.finding_key, r.title, (SELECT COUNT(*) FROM OPENJSON(r.details, '$.steps')) AS steps FROM runbooks r
      WHERE r.state = 'approved' AND (r.issue_type_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1)) OR r.finding_key IN (SELECT value FROM OPENJSON($2)))`,
    [issueTypeIds, findingKeys])).rows;
  for (const r of rows) {
    const s = { title: r.title, steps: Number(r.steps), builtIn: false };
    if (r.issue_type_id) issue.set(r.issue_type_id, s); else if (r.finding_key) finding.set(r.finding_key, s);
  }
  return { issue, finding };
}

/** Tier 2 and up propose. Nothing is live until an Admin approves. */
export async function proposeRunbook(pool: Pool, userId: string, b: RunbookPropose): Promise<RunbookView> {
  checkRunbookBody(b);
  const issue = b.target.kind === "issue" ? b.target.issueTypeId : null, key = b.target.kind === "finding" ? b.target.key : null;
  const id = randomUUID();
  await transaction(pool, async c => {
    if (issue && (await c.query("SELECT 1 FROM issue_types WHERE id = $1", [issue])).rowCount !== 1) throw new Refused("not_found", 404, "no such issue type");
    const pendingHere = Number((await c.query<{ n: number }>(`SELECT COUNT(*) AS n FROM runbooks WHERE state = 'proposed' AND ${issue ? "issue_type_id = $1" : "finding_key = $1"}`, [issue ?? key])).rows[0]!.n);
    if (pendingHere >= MAX_PENDING_PER_TARGET) throw new Refused("too_many_proposals", 409, "three proposals for this are already waiting for an Admin; ask for them to be decided first");
    const mine = Number((await c.query<{ n: number }>("SELECT COUNT(*) AS n FROM runbooks WHERE state = 'proposed' AND proposed_by = $1", [userId])).rows[0]!.n);
    if (mine >= MAX_PENDING_PER_USER) throw new Refused("too_many_proposals", 409, "you already have ten runbooks waiting for approval");
    const version = Number((await c.query<{ v: number | null }>(`SELECT MAX(version) AS v FROM runbooks WHERE ${issue ? "issue_type_id = $1" : "finding_key = $1"}`, [issue ?? key])).rows[0]!.v ?? 0) + 1;
    await c.query(`INSERT INTO runbooks (id, issue_type_id, finding_key, title, details, state, version, proposed_by) VALUES ($1, $2, $3, $4, $5, 'proposed', $6, $7)`,
      [id, issue, key, b.title, safeJson({ steps: b.steps, links: b.links ?? [] }), version, userId]);
    await audit(c, { actorKind: "user", actorId: userId, action: "runbook.propose", targetKind: "runbook", targetId: id, outcome: "succeeded",
      details: { target: b.target, version, steps: b.steps.length } });
  });
  return view((await pool.query<Row>(`${SELECT} WHERE r.id = $1`, [id])).rows[0]!);
}

/** An Admin's decision on a proposal, with an authenticator code. Approving retires the runbook that was in force. */
export async function decideRunbook(pool: Pool, adminId: string, id: string, approve: boolean, stepUpToken: string): Promise<RunbookView> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, approve ? "runbook.approve" : "runbook.reject", id);
    const r = (await c.query<{ issue_type_id: string | null; finding_key: string | null }>("SELECT issue_type_id, finding_key FROM runbooks WHERE id = $1 AND state = 'proposed'", [id])).rows[0];
    if (!r) throw new Refused("not_pending", 409, "this runbook is not waiting for approval (it may already have been decided)");
    if (approve)
      await c.query(`UPDATE runbooks SET state = 'retired' WHERE state = 'approved' AND ${r.issue_type_id ? "issue_type_id = $1" : "finding_key = $1"}`, [r.issue_type_id ?? r.finding_key]);
    await c.query("UPDATE runbooks SET state = $2, decided_by = $3, decided_at = SYSUTCDATETIME() WHERE id = $1", [id, approve ? "approved" : "rejected", adminId]);
    await audit(c, { actorKind: "user", actorId: adminId, action: approve ? "runbook.approve" : "runbook.reject", targetKind: "runbook", targetId: id, outcome: "succeeded" });
  });
  return view((await pool.query<Row>(`${SELECT} WHERE r.id = $1`, [id])).rows[0]!);
}

/** Takes an approved runbook out of force; the platform's own (if there is one for the target) shows again. */
export async function retireRunbook(pool: Pool, adminId: string, id: string, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "runbook.retire", id);
    const r = await c.query("UPDATE runbooks SET state = 'retired', decided_by = $2, decided_at = SYSUTCDATETIME() WHERE id = $1 AND state = 'approved'", [id, adminId]);
    if (r.rowCount !== 1) throw new Refused("not_approved", 409, "this runbook is not in force");
    await audit(c, { actorKind: "user", actorId: adminId, action: "runbook.retire", targetKind: "runbook", targetId: id, outcome: "succeeded" });
  });
}

/** Runbooks by state, newest first (the review list and the history of a target). */
export async function listRunbooks(db: Queryable, q: RunbookQuery): Promise<RunbookView[]> {
  const where: string[] = [], args: unknown[] = [];
  if (q.state) { args.push(q.state); where.push(`r.state = $${args.length}`); }
  if (q.issueTypeId) { args.push(q.issueTypeId); where.push(`r.issue_type_id = $${args.length}`); }
  if (q.findingKey) { args.push(q.findingKey); where.push(`r.finding_key = $${args.length}`); }
  return (await db.query<Row>(`${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.proposed_at DESC OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY`, args)).rows.map(view);
}

/** One row per issue type with the runbook in force and how many proposals wait: the Issues page. */
export async function runbookOverview(db: Queryable) {
  const types = (await db.query<{ id: string; name: string }>("SELECT id, name FROM issue_types ORDER BY name")).rows;
  const live = (await db.query<Row>(`${SELECT} WHERE r.state = 'approved' AND r.issue_type_id IS NOT NULL`)).rows;
  const waiting = (await db.query<{ issue_type_id: string; n: number }>("SELECT issue_type_id, COUNT(*) AS n FROM runbooks WHERE state = 'proposed' AND issue_type_id IS NOT NULL GROUP BY issue_type_id")).rows;
  return types.map(t => {
    const own = live.find(r => r.issue_type_id === t.id);
    const rb = own ? view(own) : builtIn({ kind: "issue", issueTypeId: t.id });
    return { issueTypeId: t.id, name: t.name, runbook: rb, waiting: Number(waiting.find(w => w.issue_type_id === t.id)?.n ?? 0) };
  });
}

export const builtInFor = builtIn;
export type { RunbookBody };
