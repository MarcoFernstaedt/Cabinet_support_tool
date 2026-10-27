// Baselines (docs/spec/15-baselines-and-config.md): the approved, known-working configuration for a scope, in numbered versions that
// are never overwritten. Scopes widen to narrow: global, model, client, site, cabinet; a narrower scope replaces a wider one item by
// item, and every resolved expectation says where it came from. A capture from a cabinet is only a draft: it becomes a baseline when
// it is reviewed, proposed and approved by an Admin. Nothing here changes a cabinet.
import { randomUUID } from "node:crypto";
import type { BaselineContent, BaselineScope } from "@mashura/cabinet-contracts/types";
import { audit, lock, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { Refused } from "./errors.js";
import { CATEGORIES, currentItems, keyBelongs, type Category } from "./config-ingest.js";
import { valueText } from "./config-canonical.js";
import { ROLE_RANK, type Role } from "./roles.js";

export type ScopeKind = BaselineScope["kind"];
export type Scope = { kind: ScopeKind; id: string | null };
type BaselineItem = BaselineContent["items"][number];
export interface Origin { kind: ScopeKind; id: string | null; name: string; baselineId: string; versionId: string; version: number }
export interface ResolvedItem { category: Category; key: string; mode: "match" | "present" | "absent"; expect: Record<string, unknown> | null; required: boolean; severity: "minor" | "major"; note: string | null; origin: Origin }
export interface ResolvedHealth { maxOfflineMinutes: number; requireRequiredItems: boolean; requireNoCriticalAlerts: boolean }
export interface Resolved { items: ResolvedItem[]; health: ResolvedHealth; healthOrigin: Partial<Record<keyof ResolvedHealth, Origin>>; scopes: Origin[] }

export const DEFAULT_HEALTH: ResolvedHealth = { maxOfflineMinutes: 10, requireRequiredItems: true, requireNoCriticalAlerts: true };
const ORDER: ScopeKind[] = ["global", "model", "client", "site", "cabinet"];
const WIDE: ScopeKind[] = ["global", "model"];
/** A baseline holds at most this many items (the contract's limit), also for a capture. */
export const MAX_ITEMS = 5000;

export interface Actor { userId: string; role: Role }

/** Scope ids that are GUIDs are kept lower case, so one scope is one baseline whatever case the browser sent. */
export const normalScope = (scope: Scope): Scope => ({ kind: scope.kind, id: scope.id === null ? null : scope.kind === "model" ? scope.id : scope.id.toLowerCase() });

// ---- Scopes -------------------------------------------------------------------------------------------------------------

/** A readable name for a scope, and proof that it exists. */
export async function scopeName(db: Queryable, scope: Scope): Promise<string> {
  if (scope.kind === "global") return "All cabinets";
  if (scope.kind === "model") return scope.id!;
  const sql = { client: "SELECT name FROM clients WHERE id = $1 AND removed_at IS NULL",
    site: "SELECT CONCAT(c.name, N' / ', s.name) AS name FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = $1 AND s.removed_at IS NULL",
    cabinet: "SELECT name FROM cabinets WHERE id = $1" }[scope.kind];
  const r = (await db.query<{ name: string }>(sql, [scope.id])).rows[0];
  if (!r) throw new Refused("not_found", 404, `no such ${scope.kind}`);
  return r.name.slice(0, 200);
}

/** The scopes that apply to a cabinet, widest first. */
export async function cabinetScopes(db: Queryable, cabinetId: string): Promise<Scope[]> {
  const r = (await db.query<{ model: string | null; client_id: string; site_id: string }>(
    "SELECT k.model, s.client_id, k.site_id FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1", [cabinetId])).rows[0];
  if (!r) throw new Refused("not_found", 404, "no such cabinet");
  return [{ kind: "global", id: null }, ...(r.model ? [{ kind: "model" as const, id: r.model }] : []), { kind: "client", id: r.client_id }, { kind: "site", id: r.site_id }, { kind: "cabinet", id: cabinetId }];
}

function checkScopeRole(actor: Actor, scope: Scope): void {
  if (WIDE.includes(scope.kind) && ROLE_RANK[actor.role] < ROLE_RANK.admin) throw new Refused("forbidden", 403, "only an Admin works with the baselines for all cabinets or a model");
}

/** Every item belongs to its category and none repeats (the contract has already checked the shapes). */
export function checkContent(content: BaselineContent): void {
  const seen = new Set<string>();
  for (const i of content.items) {
    if (!(CATEGORIES as readonly string[]).includes(i.category) || !keyBelongs(i.category as Category, i.key)) throw new Refused("bad_item", 400, `the item ${i.key} does not belong to ${i.category}`);
    const id = `${i.category}|${i.key}`;
    if (seen.has(id)) throw new Refused("duplicate_item", 400, `the item ${i.key} is listed twice`);
    seen.add(id);
  }
}

// ---- Reading ------------------------------------------------------------------------------------------------------------

interface VersionRow { id: string; baseline_id: string; version: number; status: string; description: string; previous_version_id: string | null; origin: unknown; compat: unknown;
  created_by: string; created_by_name: string; created_at: Date; proposed_at: Date | null; decided_by: string | null; decided_by_name: string | null; decided_at: Date | null; decision_note: string | null }

const versionView = (v: VersionRow) => ({ id: v.id, baselineId: v.baseline_id, version: v.version, status: v.status, description: v.description, previousVersionId: v.previous_version_id,
  origin: v.origin, compat: v.compat, createdBy: { id: v.created_by, name: v.created_by_name }, createdAt: v.created_at.toISOString(), proposedAt: v.proposed_at?.toISOString() ?? null,
  decidedBy: v.decided_by ? { id: v.decided_by, name: v.decided_by_name } : null, decidedAt: v.decided_at?.toISOString() ?? null, decisionNote: v.decision_note });

const VERSION_SELECT = `SELECT v.id, v.baseline_id, v.[version], v.status, v.description, v.previous_version_id, v.origin, v.compat, v.created_by, cu.name AS created_by_name, v.created_at,
       v.proposed_at, v.decided_by, du.name AS decided_by_name, v.decided_at, v.decision_note
  FROM baseline_versions v JOIN users cu ON cu.id = v.created_by LEFT JOIN users du ON du.id = v.decided_by`;

export async function listBaselines(db: Queryable, filter: { scopeKind?: string | undefined; scopeId?: string | undefined }) {
  const rows = (await db.query<{ id: string; scope_kind: ScopeKind; scope_id: string | null; name: string; created_at: Date; approved: number | null; approved_at: Date | null; pending: string | null; drafts: number }>(
    `SELECT TOP (500) b.id, b.scope_kind, b.scope_id, b.name, b.created_at,
            (SELECT v.[version] FROM baseline_versions v WHERE v.baseline_id = b.id AND v.status = 'approved') AS approved,
            (SELECT v.decided_at FROM baseline_versions v WHERE v.baseline_id = b.id AND v.status = 'approved') AS approved_at,
            (SELECT v.id FROM baseline_versions v WHERE v.baseline_id = b.id AND v.status = 'pending') AS pending,
            (SELECT COUNT(*) FROM baseline_versions v WHERE v.baseline_id = b.id AND v.status = 'draft') AS drafts
       FROM baselines b WHERE (CAST($1 AS nvarchar(16)) IS NULL OR b.scope_kind = $1) AND (CAST($2 AS nvarchar(64)) IS NULL OR b.scope_id = $2)
      ORDER BY CASE b.scope_kind WHEN 'global' THEN 0 WHEN 'model' THEN 1 WHEN 'client' THEN 2 WHEN 'site' THEN 3 ELSE 4 END, b.name`, [filter.scopeKind ?? null, filter.scopeId ?? null])).rows;
  return rows.map(r => ({ id: r.id, scope: { kind: r.scope_kind, id: r.scope_id }, name: r.name, createdAt: r.created_at.toISOString(), approvedVersion: r.approved, approvedAt: r.approved_at?.toISOString() ?? null,
    pendingVersionId: r.pending, drafts: Number(r.drafts) }));
}

export async function getBaseline(db: Queryable, id: string) {
  const b = (await db.query<{ id: string; scope_kind: ScopeKind; scope_id: string | null; name: string; created_at: Date }>("SELECT id, scope_kind, scope_id, name, created_at FROM baselines WHERE id = $1", [id])).rows[0];
  if (!b) return null;
  const versions = (await db.query<VersionRow>(`${VERSION_SELECT} WHERE v.baseline_id = $1 ORDER BY v.[version] DESC`, [id])).rows;
  return { id: b.id, scope: { kind: b.scope_kind, id: b.scope_id }, name: b.name, createdAt: b.created_at.toISOString(), versions: versions.map(versionView) };
}

export interface ContentDiff { added: BaselineItem[]; removed: BaselineItem[]; changed: { before: BaselineItem; after: BaselineItem }[]; healthChanged: boolean }
const sameItem = (a: BaselineItem, b: BaselineItem) => JSON.stringify([a.mode, a.expect ? valueText(Object.entries(a.expect).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => [k, v ?? null])) : null, a.required ?? false, a.severity ?? "minor", a.note ?? ""]) ===
  JSON.stringify([b.mode, b.expect ? valueText(Object.entries(b.expect).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => [k, v ?? null])) : null, b.required ?? false, b.severity ?? "minor", b.note ?? ""]);

/** What a version changes compared with another: the review a person does before approving. */
export function diffContent(before: BaselineContent | null, after: BaselineContent): ContentDiff {
  const old = new Map((before?.items ?? []).map(i => [`${i.category}|${i.key}`, i]));
  const now = new Map(after.items.map(i => [`${i.category}|${i.key}`, i]));
  const out: ContentDiff = { added: [], removed: [], changed: [], healthChanged: JSON.stringify(before?.health ?? {}) !== JSON.stringify(after.health ?? {}) };
  for (const [k, i] of now) { const was = old.get(k); if (!was) out.added.push(i); else if (!sameItem(was, i)) out.changed.push({ before: was, after: i }); }
  for (const [k, i] of old) if (!now.has(k)) out.removed.push(i);
  return out;
}

export async function getVersion(db: Queryable, versionId: string) {
  const v = (await db.query<VersionRow & { content: BaselineContent; scope_kind: ScopeKind; scope_id: string | null }>(
    `${VERSION_SELECT.replace("SELECT v.id,", "SELECT v.content, b.scope_kind, b.scope_id, v.id,")} JOIN baselines b ON b.id = v.baseline_id WHERE v.id = $1`, [versionId])).rows[0];
  if (!v) return null;
  const prev = v.previous_version_id ? (await db.query<{ content: BaselineContent }>("SELECT content FROM baseline_versions WHERE id = $1", [v.previous_version_id])).rows[0]?.content ?? null : null;
  return { ...versionView(v), scope: { kind: v.scope_kind, id: v.scope_id }, content: v.content, diff: diffContent(prev, v.content) };
}

// ---- Writing ------------------------------------------------------------------------------------------------------------

const lockBaselines = (c: Queryable) => lock(c, "baselines");

async function ensureBaseline(c: Queryable, actor: Actor, scope: Scope): Promise<string> {
  const found = (await c.query<{ id: string }>("SELECT id FROM baselines WHERE scope_kind = $1 AND ((scope_id IS NULL AND CAST($2 AS nvarchar(64)) IS NULL) OR scope_id = $2)", [scope.kind, scope.id])).rows[0];
  if (found) return found.id;
  const id = randomUUID();
  await c.query("INSERT INTO baselines (id, scope_kind, scope_id, name, created_by) VALUES ($1, $2, $3, $4, $5)", [id, scope.kind, scope.id, await scopeName(c, scope), actor.userId]);
  return id;
}

async function newDraft(c: Queryable, actor: Actor, scope: Scope, description: string, content: BaselineContent, compat: unknown, origin: unknown): Promise<{ id: string; baselineId: string; version: number }> {
  checkContent(content);
  const baselineId = await ensureBaseline(c, actor, scope);
  const last = Number((await c.query<{ v: number }>("SELECT ISNULL(MAX([version]), 0) AS v FROM baseline_versions WHERE baseline_id = $1", [baselineId])).rows[0]!.v);
  const approved = (await c.query<{ id: string }>("SELECT id FROM baseline_versions WHERE baseline_id = $1 AND status = 'approved'", [baselineId])).rows[0]?.id ?? null;
  const id = randomUUID();
  await c.query(`INSERT INTO baseline_versions (id, baseline_id, [version], status, content, description, previous_version_id, compat, origin, created_by)
                 VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9)`, [id, baselineId, last + 1, safeJson(content), description, approved, compat ? safeJson(compat) : null, safeJson(origin), actor.userId]);
  return { id, baselineId, version: last + 1 };
}

export async function createDraft(pool: Pool, actor: Actor, body: { scope: Scope; description: string; content: BaselineContent; compat?: unknown }) {
  const scope = normalScope(body.scope);
  checkScopeRole(actor, scope);
  return transaction(pool, async c => {
    await lockBaselines(c);
    const d = await newDraft(c, actor, scope, body.description.trim(), body.content, body.compat, { kind: "manual" });
    await audit(c, { actorKind: "user", actorId: actor.userId, action: "baseline.draft", targetKind: "baseline", targetId: d.baselineId, outcome: "succeeded",
      details: { versionId: d.id, version: d.version, scope, items: body.content.items.length } });
    return d;
  });
}

/** Values a capture leaves out because they change by themselves, so a baseline expecting them would flag every look. */
const CAPTURE_SKIP: Partial<Record<Category, string[]>> = { services: ["state"], network: ["connected", "linkSpeedMbps"] };
/** Values that differ from cabinet to cabinet: left out of any baseline wider than one cabinet. */
const PER_CABINET: Partial<Record<Category, string[]>> = { network: ["addresses", "mac", "interfaceIndex"], updates: ["installedAt"] };
/** Categories a baseline wider than one cabinet does not start with (every cabinet has its own devices). */
const CABINET_ONLY: Category[] = ["devices"];

/** The categories a capture for a scope starts with: every one, except the per-cabinet ones for a scope wider than one cabinet. */
export const captureCategories = (kind: ScopeKind): Category[] => CATEGORIES.filter(k => !CABINET_ONLY.includes(k) || kind === "cabinet");

export async function captureDraft(pool: Pool, actor: Actor, body: { cabinetId: string; scope: Scope; description: string; categories?: string[] | undefined }) {
  const scope = normalScope(body.scope);
  checkScopeRole(actor, scope);
  return transaction(pool, async c => {
    await lockBaselines(c);
    return captureIn(c, actor, { ...body, scope });
  });
}

/** A capture inside the caller's transaction, which already holds the baselines lock. */
async function captureIn(c: Queryable, actor: Actor, body: { cabinetId: string; scope: Scope; description: string; categories?: string[] | undefined }, auditAs?: { actorKind: "system"; actorId: string }) {
  const scope = body.scope;
  {
    const wanted = (body.categories as Category[] | undefined) ?? captureCategories(scope.kind);
    const current = await currentItems(c, body.cabinetId.toLowerCase(), wanted);
    if (current.size === 0) throw new Refused("no_configuration", 409, "this cabinet has not reported its configuration yet");
    const items: BaselineItem[] = [];
    for (const [category, cur] of current)
      for (const i of cur.items) {
        const skip = new Set([...(CAPTURE_SKIP[category] ?? []), ...(scope.kind === "cabinet" ? [] : PER_CABINET[category] ?? [])]);
        const expect = Object.fromEntries(Object.entries(i.values).filter(([f, v]) => v !== undefined && !skip.has(f)));
        items.push({ category, key: i.key, mode: "match", expect: expect as NonNullable<BaselineItem["expect"]> });
      }
    if (items.length > MAX_ITEMS) throw new Refused("too_many_items", 400, `a baseline holds at most ${MAX_ITEMS} items; this capture has ${items.length}, so leave some categories out`);
    items.sort((a, b) => (a.category + "|" + a.key < b.category + "|" + b.key ? -1 : 1));
    const observed = Math.max(...[...current.values()].map(r => r.observedAt.getTime()));
    const d = await newDraft(c, actor, scope, body.description.trim(), { items }, null,
      { kind: "capture", cabinetId: body.cabinetId.toLowerCase(), observedAt: new Date(observed).toISOString(), ...(auditAs ? { enrollment: true } : {}) });
    await audit(c, { actorKind: auditAs?.actorKind ?? "user", actorId: auditAs?.actorId ?? actor.userId, action: "baseline.capture", targetKind: "baseline", targetId: d.baselineId, outcome: "succeeded",
      details: { versionId: d.id, version: d.version, scope, cabinetId: body.cabinetId.toLowerCase(), items: items.length, ...(auditAs ? { forUser: actor.userId, enrollment: true } : {}) } });
    return { ...d, items: items.length };
  }
}

// ---- Baselines at enrollment ----------------------------------------------------------------------------------------------
// docs/spec/15-baselines-and-config.md "Baselines at enrollment": every approval names the baseline a cabinet is judged against.

/** The approved baselines in force for these scopes, widest first: what a cabinet in them is judged against. */
export async function approvedFor(db: Queryable, scopes: readonly Scope[]): Promise<Origin[]> {
  if (scopes.length === 0) return [];
  const rows = (await db.query<{ scope_kind: ScopeKind; scope_id: string | null; name: string; baseline_id: string; version_id: string; version: number }>(
    `SELECT b.scope_kind, b.scope_id, b.name, b.id AS baseline_id, v.id AS version_id, v.[version]
       FROM baselines b JOIN baseline_versions v ON v.baseline_id = b.id AND v.status = 'approved'
      WHERE EXISTS (SELECT 1 FROM OPENJSON($1) WITH (kind nvarchar(16) '$.kind', id nvarchar(64) '$.id') s WHERE s.kind = b.scope_kind AND ISNULL(s.id, N'') = ISNULL(b.scope_id, N''))`,
    [scopes.map(s => ({ kind: s.kind, id: s.id === null ? null : s.id.toLowerCase() }))])).rows;
  return rows.sort((a, b) => ORDER.indexOf(a.scope_kind) - ORDER.indexOf(b.scope_kind))
    .map(r => ({ kind: r.scope_kind, id: r.scope_id, name: r.name, baselineId: r.baseline_id, versionId: r.version_id, version: r.version }));
}

/** The approved versions an approver may attach to a site, newest first; the few fields the dialog shows. */
export async function attachChoices(db: Queryable, limit = 100) {
  const rows = (await db.query<{ version_id: string; version: number; scope_kind: ScopeKind; name: string }>(
    `SELECT TOP (${Math.max(1, Math.min(200, Math.floor(limit)))}) v.id AS version_id, v.[version], b.scope_kind, b.name
       FROM baselines b JOIN baseline_versions v ON v.baseline_id = b.id AND v.status = 'approved'
      WHERE b.scope_kind IN ('global', 'model', 'client', 'site') ORDER BY v.decided_at DESC`)).rows;
  return rows.map(r => ({ versionId: r.version_id, version: r.version, scope: r.scope_kind, name: r.name }));
}

/**
 * Attaches an approved baseline to a site, in the caller's transaction: the site's baseline gets an approved version with the same
 * content. The content was approved already (by the two-person review of its own scope); the approver's step-up for the whole approval
 * confirms that it now also applies to this site. A site that has an approved baseline of its own is refused: that one applies.
 */
export async function attachToSite(c: Queryable, userId: string, siteId: string, versionId: string, why: string): Promise<Origin> {
  await lockBaselines(c);
  const src = (await c.query<{ content: BaselineContent; version: number; scope_kind: ScopeKind; scope_id: string | null; name: string }>(
    `SELECT v.content, v.[version], b.scope_kind, b.scope_id, b.name FROM baseline_versions v JOIN baselines b ON b.id = v.baseline_id
      WHERE v.id = $1 AND v.status = 'approved' AND b.scope_kind IN ('global', 'model', 'client', 'site')`, [versionId])).rows[0];
  if (!src) throw new Refused("not_approved", 409, "that baseline version is not an approved baseline that can be attached",
    { reason: "That baseline is not approved, or a newer version replaced it. Choose one from the list again." });
  const scope: Scope = { kind: "site", id: siteId.toLowerCase() };
  const baselineId = await ensureBaseline(c, { userId, role: "admin" }, scope);
  if ((await c.query("SELECT TOP (1) 1 AS x FROM baseline_versions WHERE baseline_id = $1 AND status = 'approved'", [baselineId])).rows.length > 0)
    throw new Refused("site_has_baseline", 409, "this site already has an approved baseline of its own",
      { reason: "This site already has an approved baseline of its own, and it applies to this cabinet. Choose \"use the baseline in force\"." });
  const last = Number((await c.query<{ v: number }>("SELECT ISNULL(MAX([version]), 0) AS v FROM baseline_versions WHERE baseline_id = $1", [baselineId])).rows[0]!.v);
  const id = randomUUID();
  const origin = { kind: "attach", from: { kind: src.scope_kind, id: src.scope_id }, versionId, version: src.version };
  await c.query(`INSERT INTO baseline_versions (id, baseline_id, [version], status, content, description, previous_version_id, compat, origin, created_by, decided_by, decided_at, decision_note)
                 VALUES ($1, $2, $3, 'approved', $4, $5, NULL, NULL, $6, $7, $7, SYSUTCDATETIME(), $8)`,
    [id, baselineId, last + 1, safeJson(src.content), `Attached from ${src.name} version ${src.version}`.slice(0, 500), safeJson(origin), userId, why.slice(0, 500)]);
  await audit(c, { actorKind: "user", actorId: userId, action: "baseline.attach", targetKind: "baseline", targetId: baselineId, outcome: "succeeded",
    details: { versionId: id, version: last + 1, scope, from: origin.from, fromVersionId: versionId, fromVersion: src.version } });
  return { kind: "site", id: scope.id, name: await scopeName(c, scope), baselineId, versionId: id, version: last + 1 };
}

/**
 * A capture asked for at enrollment: once the cabinet has reported every category a site baseline uses, its configuration becomes the
 * site's baseline draft, written in the approver's name (they asked for it) and audited as the platform's doing. The draft is then
 * proposed and approved like any other, with the two-person rule. Returns the draft, or null when there is nothing to do yet.
 */
export async function captureForEnrollment(pool: Pool, cabinetId: string): Promise<{ versionId: string; version: number } | null> {
  const id = cabinetId.toLowerCase();
  // Cheap check first: this runs after every configuration upload of every cabinet.
  const waiting = (await pool.query<{ site_id: string }>("SELECT site_id FROM enrollment_baselines WHERE cabinet_id = $1 AND capture_state = 'waiting'", [id])).rows[0];
  if (!waiting) return null;
  const need = captureCategories("site");
  const have = (await pool.query<{ category: string }>("SELECT category FROM config_current WHERE cabinet_id = $1", [id])).rows.map(r => r.category);
  if (!need.every(k => have.includes(k))) return null;
  return transaction(pool, async c => {
    await lockBaselines(c);
    // Claimed under the lock, so two uploads at the same moment make one draft.
    const row = (await c.query<{ site_id: string; decided_by: string; name: string }>(
      `SELECT e.site_id, e.decided_by, k.name FROM enrollment_baselines e WITH (UPDLOCK, ROWLOCK) JOIN cabinets k ON k.id = e.cabinet_id
        WHERE e.cabinet_id = $1 AND e.capture_state = 'waiting' AND k.status = 'active'`, [id])).rows[0];
    if (!row) return null;
    let d: { id: string; version: number };
    try {
      d = await captureIn(c, { userId: row.decided_by, role: "admin" }, { cabinetId: id, scope: { kind: "site", id: row.site_id.toLowerCase() },
        description: `Captured from ${row.name} when it first reported, as asked at its approval`.slice(0, 500) }, { actorKind: "system", actorId: "enrollment" });
    } catch (e) {
      // A capture the rules refuse (more items than a baseline holds) is refused before anything is written: say so once, and stop
      // trying on every upload. Someone captures a trimmed baseline by hand from the cabinet's Baseline tab.
      if (!(e instanceof Refused)) throw e;
      await c.query("UPDATE enrollment_baselines SET capture_state = 'failed' WHERE cabinet_id = $1", [id]);
      await audit(c, { actorKind: "system", actorId: "enrollment", action: "baseline.capture", targetKind: "cabinet", targetId: id, outcome: "failed", details: { code: e.code } });
      return null;
    }
    await c.query("UPDATE enrollment_baselines SET capture_state = 'drafted', draft_version_id = $2, drafted_at = SYSUTCDATETIME() WHERE cabinet_id = $1", [id, d.id]);
    return { versionId: d.id, version: d.version };
  });
}

export interface BaselineStatus {
  /** An approved baseline applies to the cabinet now. */
  inForce: boolean;
  inForceFrom: { kind: ScopeKind; name: string; version: number }[];
  /** The decision made when it was approved, and where a requested capture stands. */
  enrollment: { decision: "inherited" | "attach" | "capture"; captureState: "waiting" | "drafted" | "failed" | null; draftVersionId: string | null; draftStatus: string | null;
    categoriesReported: number; categoriesNeeded: number } | null;
}

/** Whether a baseline is in force for a cabinet, and what was decided for it at enrollment: the "Baseline required" state. */
export async function baselineStatus(db: Queryable, cabinetId: string): Promise<BaselineStatus> {
  const inForce = await approvedFor(db, await cabinetScopes(db, cabinetId));
  const e = (await db.query<{ decision: "inherited" | "attach" | "capture"; capture_state: "waiting" | "drafted" | "failed" | null; draft_version_id: string | null; draft_status: string | null }>(
    `SELECT e.decision, e.capture_state, e.draft_version_id, v.status AS draft_status FROM enrollment_baselines e LEFT JOIN baseline_versions v ON v.id = e.draft_version_id
      WHERE e.cabinet_id = $1`, [cabinetId])).rows[0];
  const need = captureCategories("site");
  const reported = e?.capture_state === "waiting"
    ? (await db.query<{ category: string }>("SELECT category FROM config_current WHERE cabinet_id = $1", [cabinetId])).rows.filter(r => need.includes(r.category as Category)).length : 0;
  return {
    inForce: inForce.length > 0, inForceFrom: inForce.map(o => ({ kind: o.kind, name: o.name, version: o.version })),
    enrollment: e ? { decision: e.decision, captureState: e.capture_state, draftVersionId: e.draft_version_id, draftStatus: e.draft_status, categoriesReported: reported, categoriesNeeded: need.length } : null,
  };
}

export async function importDraft(pool: Pool, actor: Actor, body: { from: Scope; to: Scope; description: string }) {
  const from = normalScope(body.from), to = normalScope(body.to);
  // Anyone who can read a baseline may copy it; writing the copy follows the rules of the scope it goes to.
  checkScopeRole(actor, to);
  return transaction(pool, async c => {
    await lockBaselines(c);
    const src = (await c.query<{ content: BaselineContent; id: string; version: number }>(
      `SELECT v.content, v.id, v.[version] FROM baseline_versions v JOIN baselines b ON b.id = v.baseline_id
        WHERE b.scope_kind = $1 AND ((b.scope_id IS NULL AND CAST($2 AS nvarchar(64)) IS NULL) OR b.scope_id = $2) AND v.status = 'approved'`, [from.kind, from.id])).rows[0];
    if (!src) throw new Refused("no_approved_baseline", 409, "that scope has no approved baseline to import");
    const d = await newDraft(c, actor, to, body.description.trim(), src.content, null, { kind: "import", from, versionId: src.id, version: src.version });
    await audit(c, { actorKind: "user", actorId: actor.userId, action: "baseline.import", targetKind: "baseline", targetId: d.baselineId, outcome: "succeeded",
      details: { versionId: d.id, version: d.version, from, to } });
    return d;
  });
}

async function lockVersion(c: Queryable, versionId: string) {
  await lockBaselines(c);
  const v = (await c.query<{ id: string; baseline_id: string; version: number; status: string; created_by: string; previous_version_id: string | null; scope_kind: ScopeKind; scope_id: string | null }>(
    `SELECT v.id, v.baseline_id, v.[version], v.status, v.created_by, v.previous_version_id, b.scope_kind, b.scope_id
       FROM baseline_versions v WITH (UPDLOCK, ROWLOCK) JOIN baselines b ON b.id = v.baseline_id WHERE v.id = $1`, [versionId])).rows[0];
  if (!v) throw new Refused("not_found", 404, "no such baseline version");
  return v;
}

const own = (actor: Actor, createdBy: string) => actor.userId === createdBy || actor.role === "admin";

export async function updateDraft(pool: Pool, actor: Actor, versionId: string, change: { description?: string | undefined; content?: BaselineContent | undefined }) {
  await transaction(pool, async c => {
    const v = await lockVersion(c, versionId);
    checkScopeRole(actor, { kind: v.scope_kind, id: v.scope_id });
    if (!own(actor, v.created_by)) throw new Refused("forbidden", 403, "only its author or an Admin edits a draft");
    if (v.status !== "draft") throw new Refused("not_a_draft", 409, "only a draft can be edited; make a new version instead");
    if (change.content) checkContent(change.content);
    await c.query("UPDATE baseline_versions SET content = COALESCE($2, content), description = COALESCE($3, description) WHERE id = $1",
      [versionId, change.content ? safeJson(change.content) : null, change.description?.trim() ?? null]);
    await audit(c, { actorKind: "user", actorId: actor.userId, action: "baseline.update", targetKind: "baseline", targetId: v.baseline_id, outcome: "succeeded",
      details: { versionId, version: v.version, content: !!change.content, description: !!change.description } });
  });
}

export async function propose(pool: Pool, actor: Actor, versionId: string) {
  await transaction(pool, async c => {
    const v = await lockVersion(c, versionId);
    checkScopeRole(actor, { kind: v.scope_kind, id: v.scope_id });
    if (!own(actor, v.created_by)) throw new Refused("forbidden", 403, "only its author or an Admin proposes a draft");
    if (v.status !== "draft") throw new Refused("not_a_draft", 409, "only a draft can be proposed");
    if ((await c.query("SELECT TOP (1) 1 AS x FROM baseline_versions WHERE baseline_id = $1 AND status = 'pending'", [v.baseline_id])).rows.length > 0)
      throw new Refused("already_pending", 409, "another version of this baseline is already waiting for a decision");
    await c.query("UPDATE baseline_versions SET status = 'pending', proposed_at = SYSUTCDATETIME() WHERE id = $1", [versionId]);
    await audit(c, { actorKind: "user", actorId: actor.userId, action: "baseline.propose", targetKind: "baseline", targetId: v.baseline_id, outcome: "succeeded", details: { versionId, version: v.version } });
  });
}

export async function withdraw(pool: Pool, actor: Actor, versionId: string) {
  await transaction(pool, async c => {
    const v = await lockVersion(c, versionId);
    if (!own(actor, v.created_by)) throw new Refused("forbidden", 403, "only its author or an Admin withdraws a proposal");
    if (v.status !== "pending") throw new Refused("not_pending", 409, "only a proposed version can be withdrawn");
    await c.query("UPDATE baseline_versions SET status = 'draft', proposed_at = NULL WHERE id = $1", [versionId]);
    await audit(c, { actorKind: "user", actorId: actor.userId, action: "baseline.withdraw", targetKind: "baseline", targetId: v.baseline_id, outcome: "succeeded", details: { versionId, version: v.version } });
  });
}

/**
 * An Admin's decision on a proposal, confirmed with an authenticator code bound to the note. The person who wrote it does not
 * approve it when another active Admin exists, and a version made from an older approved one is refused once a newer one is in force
 * (it would silently undo that change): it is re-made from the current version.
 */
export async function decide(pool: Pool, admin: Actor, versionId: string, approve: boolean, note: string, stepUpToken: string): Promise<Scope> {
  if (admin.role !== "admin") throw new Refused("forbidden", 403, "only an Admin decides");
  return transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, admin.userId, approve ? "baseline.approve" : "baseline.reject", versionId);
    const v = await lockVersion(c, versionId);
    if (v.status !== "pending") throw new Refused("not_pending", 409, "only a proposed version can be decided");
    if (approve) {
      if (v.created_by === admin.userId) {
        const others = Number((await c.query<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> $1", [admin.userId])).rows[0]!.n);
        if (others > 0) throw new Refused("own_proposal", 403, "another Admin approves a baseline you wrote");
      }
      const current = (await c.query<{ id: string }>("SELECT id FROM baseline_versions WHERE baseline_id = $1 AND status = 'approved'", [v.baseline_id])).rows[0]?.id ?? null;
      if (current !== v.previous_version_id) throw new Refused("stale_base", 409, "a newer version was approved since this one was made; make it again from the current version");
      if (current) await c.query("UPDATE baseline_versions SET status = 'superseded' WHERE id = $1", [current]);
    }
    await c.query("UPDATE baseline_versions SET status = $2, decided_by = $3, decided_at = SYSUTCDATETIME(), decision_note = $4 WHERE id = $1", [versionId, approve ? "approved" : "rejected", admin.userId, note.trim()]);
    await audit(c, { actorKind: "user", actorId: admin.userId, action: approve ? "baseline.approve" : "baseline.reject", targetKind: "baseline", targetId: v.baseline_id, outcome: "succeeded",
      details: { versionId, version: v.version, note: note.trim(), scope: { kind: v.scope_kind, id: v.scope_id } } });
    return { kind: v.scope_kind, id: v.scope_id };
  });
}

// ---- Resolving ----------------------------------------------------------------------------------------------------------

/** The effective baseline for a cabinet: approved versions only, widest scope first, narrower replacing wider item by item. */
export async function resolveForCabinet(db: Queryable, cabinetId: string): Promise<Resolved> {
  const scopes = await cabinetScopes(db, cabinetId);
  const found = (await db.query<{ scope_kind: ScopeKind; scope_id: string | null; name: string; baseline_id: string; version_id: string; version: number; content: BaselineContent }>(
    `SELECT b.scope_kind, b.scope_id, b.name, b.id AS baseline_id, v.id AS version_id, v.[version], v.content
       FROM baselines b JOIN baseline_versions v ON v.baseline_id = b.id AND v.status = 'approved'
      WHERE EXISTS (SELECT 1 FROM OPENJSON($1) WITH (kind nvarchar(16) '$.kind', id nvarchar(64) '$.id') s WHERE s.kind = b.scope_kind AND ISNULL(s.id, N'') = ISNULL(b.scope_id, N''))`,
    [scopes.map(s => ({ kind: s.kind, id: s.id }))])).rows;
  found.sort((a, b) => ORDER.indexOf(a.scope_kind) - ORDER.indexOf(b.scope_kind));
  const items = new Map<string, ResolvedItem>();
  const health: ResolvedHealth = { ...DEFAULT_HEALTH };
  const healthOrigin: Resolved["healthOrigin"] = {};
  const origins: Origin[] = [];
  for (const f of found) {
    const origin: Origin = { kind: f.scope_kind, id: f.scope_id, name: f.name, baselineId: f.baseline_id, versionId: f.version_id, version: f.version };
    origins.push(origin);
    for (const i of f.content.items) {
      const id = `${i.category}|${i.key}`;
      if (i.mode === "ignore") { items.delete(id); continue; }
      items.set(id, { category: i.category as Category, key: i.key, mode: i.mode, expect: i.expect ?? null, required: i.required ?? false, severity: i.severity ?? "minor", note: i.note ?? null, origin });
    }
    for (const k of Object.keys(f.content.health ?? {}) as (keyof ResolvedHealth)[]) {
      const v = f.content.health![k];
      if (v !== undefined) { (health as unknown as Record<string, unknown>)[k] = v; healthOrigin[k] = origin; }
    }
  }
  return { items: [...items.values()].sort((a, b) => (a.category + "|" + a.key < b.category + "|" + b.key ? -1 : 1)), health, healthOrigin, scopes: origins };
}
