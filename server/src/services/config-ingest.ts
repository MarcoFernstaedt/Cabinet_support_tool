// Configuration snapshots from the agent (docs/spec/15-baselines-and-config.md): verified, stored change-only, and diffed against
// the version before. Honest about time: each change carries the window it is known to have happened in (the cabinet's previous
// look and this one); an exact time is kept only when Windows itself dated the change.
//
// Storage: a version's items are kept as the gzip of their JSON (a cabinet's configuration is a few hundred KB of text), and the
// current configuration is a pointer to its version, so nothing is stored twice.
import { gunzipSync, gzipSync } from "node:zlib";
import type { ConfigUpload } from "../contracts.js";
import { lock, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { Refused } from "./errors.js";
import { configHash, type Item } from "./config-canonical.js";
import { diffItems } from "./config-diff.js";

export const CATEGORIES = ["network", "services", "drivers", "updates", "firewall", "time", "devices", "applications", "hosts", "tasks", "system"] as const;
export type Category = (typeof CATEGORIES)[number];
export const isCategory = (v: unknown): v is Category => typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
export const KEEP_VERSIONS = 20;
/** The most change records one stored snapshot adds (the version itself keeps every item, so a larger difference can still be diffed). */
export const MAX_CHANGES = 500;
/** What one decompressed version may hold: far above the largest real one (2,000 items of 24 values), far below a decompression bomb. */
const MAX_UNPACKED_BYTES = 16 * 1024 * 1024;

/** The key prefixes each category may hold: a key that belongs elsewhere is a malformed snapshot. */
const PREFIXES: Record<Category, string[]> = {
  network: ["adapter", "route"], services: ["service"], drivers: ["driver"], updates: ["update"], firewall: ["profile", "rule"],
  time: ["time"], devices: ["device"], applications: ["app"], hosts: ["host"], tasks: ["task", "startup"], system: ["hardware", "identity"],
};
export const keyBelongs = (category: Category, key: string) => PREFIXES[category].some(p => key === p || key.startsWith(p + ":"));

/** The platform operations that change each category: a change right after one of these succeeded is one the platform made. */
const WRITES: Record<Category, string[]> = {
  network: ["network.setIp", "network.setDns", "network.renewLease"], services: ["service.control", "service.setStartType"],
  drivers: ["driver.uninstall", "package.install"], updates: ["updates.uninstall", "package.install"],
  firewall: ["firewall.setProfile", "firewall.applyPolicy", "firewall.setRule", "firewall.restore"],
  time: ["time.setZone", "time.sync"], devices: ["driver.uninstall"], applications: ["package.install"], hosts: [], tasks: [], system: [],
};

type Snapshot = ConfigUpload["snapshots"][number];
export type IngestResult = "first" | "unchanged" | "changed" | "stale";
interface CurrentRow { hash: string; version_id: string; observed_at: Date }
const WINDOW_SLACK_MS = 90_000;

export const packItems = (items: readonly Item[]): Buffer => gzipSync(Buffer.from(JSON.stringify(items), "utf8"));

/** The items of a stored version. Anything that is not a list of items (damaged storage) is an error, never half-read. */
export function unpackItems(stored: Buffer): Item[] {
  const items: unknown = JSON.parse(gunzipSync(stored, { maxOutputLength: MAX_UNPACKED_BYTES }).toString("utf8"));
  if (!Array.isArray(items)) throw new Error("a stored configuration is not a list");
  return items as Item[];
}

/** Throws a Refused (400) when a snapshot is not what it claims to be: wrong hash, repeated key, a key from another category. */
export function verifySnapshot(s: Snapshot): void {
  const seen = new Set<string>();
  for (const i of s.items) {
    if (seen.has(i.key)) throw new Refused("duplicate_key", 400, "a snapshot repeats an item key");
    seen.add(i.key);
    if (!keyBelongs(s.category, i.key)) throw new Refused("wrong_category", 400, "an item key does not belong to its category");
  }
  if (configHash(s.items) !== s.hash) throw new Refused("hash_mismatch", 400, "the snapshot's hash does not match its items");
}

/** Windows' own timestamp for an update, when the item has one (the only exact evidence a snapshot can hold). */
function exactAt(category: Category, change: string, fields: Record<string, { after: unknown }>, observedAt: Date): Date | null {
  if (category !== "updates" || change !== "added") return null;
  const t = fields.installedAt?.after;
  if (typeof t !== "string") return null;
  const when = new Date(t);
  return Number.isNaN(when.getTime()) || when > observedAt ? null : when;
}

async function viaPlatform(c: Queryable, cabinetId: string, category: Category, from: Date | null, to: Date): Promise<boolean> {
  const ops = WRITES[category];
  if (ops.length === 0) return false;
  const start = new Date((from ?? to).getTime() - WINDOW_SLACK_MS);
  // The operation names are constants of this file; every value travels as a parameter.
  const r = await c.query(
    `SELECT TOP (1) 1 AS x FROM commands WITH (FORCESEEK) WHERE cabinet_id = $1 AND status = 'succeeded' AND result_at BETWEEN $2 AND $3 AND operation IN (${ops.map((_, i) => `$${i + 4}`).join(", ")})`,
    [cabinetId, start, new Date(to.getTime() + WINDOW_SLACK_MS), ...ops]);
  return r.rows.length > 0;
}

/** What the cabinet says about its make and model, kept on the cabinet so the model baseline can apply to it. */
async function rememberModel(c: Queryable, cabinetId: string, items: readonly Item[]): Promise<void> {
  const hardware = items.find(i => i.key === "hardware")?.values;
  const text = (v: unknown) => (typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, 200) : null);
  const manufacturer = text(hardware?.manufacturer), model = text(hardware?.model);
  if (manufacturer === null && model === null) return;
  await c.query("UPDATE cabinets SET manufacturer = COALESCE($2, manufacturer), model = COALESCE($3, model) WHERE id = $1", [cabinetId, manufacturer, model]);
}

/** Stores one verified snapshot inside the caller's transaction, which holds the cabinet's configuration lock (see ingestConfig). Returns what it was to the cabinet's history. */
export async function storeSnapshot(c: Queryable, cabinetId: string, s: Snapshot, source: "agent" | "refresh", now = new Date(), known?: ReadonlyMap<string, CurrentRow | undefined>): Promise<{ result: IngestResult; versionId: number }> {
  const category = s.category as Category;
  // An agent clock far in the future cannot place an observation after now.
  const observed = new Date(Math.min(new Date(s.observedAt).getTime(), now.getTime()));
  // The row in force, read once for the whole batch when the caller has it (the batch holds the cabinet's lock, so nothing changes it meanwhile).
  const cur = known && known.has(category) ? known.get(category)
    : (await c.query<CurrentRow>("SELECT hash, version_id, observed_at FROM config_current WITH (UPDLOCK, ROWLOCK) WHERE cabinet_id = $1 AND category = $2", [cabinetId, category])).rows[0];
  const packed = packItems(s.items);
  if (!cur) {
    // The starting point: the version and the row that points at it in one round trip.
    const r = await c.query<{ id: string }>(
      `INSERT INTO config_versions (cabinet_id, category, hash, items, item_count, truncated, first_observed_at, last_observed_at, not_before, gap_before, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, NULL, $8, $9);
       DECLARE @id bigint = SCOPE_IDENTITY();
       INSERT INTO config_current (cabinet_id, category, hash, version_id, item_count, truncated, observed_at, changed_at) VALUES ($1, $2, $3, @id, $5, $6, $7, $7);
       SELECT @id AS id;`,
      [cabinetId, category, s.hash, packed, s.items.length, s.truncated, observed, s.gapBefore === true, source]);
    if (category === "system") await rememberModel(c, cabinetId, s.items);
    return { result: "first", versionId: Number(r.rows[0]!.id) };
  }
  const insertVersion = async (notBefore: Date | null) => Number((await c.query<{ id: string }>(
    `INSERT INTO config_versions (cabinet_id, category, hash, items, item_count, truncated, first_observed_at, last_observed_at, not_before, gap_before, source)
     OUTPUT inserted.id VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10)`,
    [cabinetId, category, s.hash, packed, s.items.length, s.truncated, observed, notBefore, s.gapBefore === true, source])).rows[0]!.id);
  if (observed < cur.observed_at) return { result: "stale", versionId: Number(cur.version_id) };
  if (cur.hash === s.hash) {
    await c.query("UPDATE config_current SET observed_at = $3 WHERE cabinet_id = $1 AND category = $2", [cabinetId, category, observed]);
    await c.query("UPDATE config_versions SET last_observed_at = $2 WHERE id = $1", [cur.version_id, observed]);
    return { result: "unchanged", versionId: Number(cur.version_id) };
  }
  const before = await c.query<{ items: Buffer }>("SELECT items FROM config_versions WHERE id = $1", [cur.version_id]);
  const previous = before.rows[0] ? unpackItems(before.rows[0].items) : [];
  const id = await insertVersion(cur.observed_at);
  const viaPlatformNow = await viaPlatform(c, cabinetId, category, cur.observed_at, observed);
  const changes = diffItems(previous, s.items).slice(0, MAX_CHANGES);
  if (changes.length > 0)
    // One statement for all the change records of this snapshot.
    await c.query(
      `INSERT INTO config_changes (cabinet_id, version_id, category, item_key, change, fields, not_before, observed_at, exact_at, gap, via_platform)
       SELECT $1, $2, $3, j.item_key, j.change, j.fields, $4, $5, TRY_CONVERT(datetime2(3), j.exact_at, 127), $6, $7
         FROM OPENJSON($8) WITH (item_key nvarchar(200) '$.itemKey', change nvarchar(8) '$.change', fields nvarchar(max) '$.fields', exact_at nvarchar(40) '$.exactAt') j`,
      [cabinetId, id, category, cur.observed_at, observed, s.gapBefore === true, viaPlatformNow,
        changes.map(ch => ({ itemKey: ch.key, change: ch.change, fields: safeJson(ch.fields), exactAt: exactAt(category, ch.change, ch.fields, observed)?.toISOString() ?? null }))]);
  await c.query("UPDATE config_current SET hash = $3, version_id = $4, item_count = $5, truncated = $6, observed_at = $7, changed_at = $7 WHERE cabinet_id = $1 AND category = $2",
    [cabinetId, category, s.hash, id, s.items.length, s.truncated, observed]);
  if (category === "system") await rememberModel(c, cabinetId, s.items);
  // Only the newest versions are kept; a version a healthy mark points at is kept too (the category is one of ours, never input).
  await c.query(
    `DELETE FROM config_versions WHERE cabinet_id = $1 AND category = $2
        AND id <= (SELECT MAX(x.id) FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) AS n FROM config_versions WHERE cabinet_id = $1 AND category = $2) x WHERE x.n = $3 + 1)
        AND NOT EXISTS (SELECT 1 FROM healthy_marks m WHERE m.cabinet_id = $1 AND JSON_VALUE(m.versions, '$.${category}') = CAST(config_versions.id AS nvarchar(20)))`,
    [cabinetId, category, KEEP_VERSIONS]);
  return { result: "changed", versionId: id };
}

export interface IngestSummary { first: number; unchanged: number; changed: number; stale: number; categoriesChanged: Category[]; latestObservedAt: Date | null }

/**
 * Verifies and stores a batch, oldest first. Every snapshot is verified before any is stored, so a malformed batch changes nothing.
 * The follow-up (drift and health for the cabinet) is the caller's: it runs once, after the batch.
 */
const CABINET_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Marks each of a cabinet's changes of the last 30 days as violating its baseline or not, from the cabinet's drift as it stands now
 * (F21.R2, decision-log D66: the one write to config_changes from outside this module, moved here). It sets the flag from the drift
 * each time, so calling it again changes nothing. The cabinet id is checked before anything is written.
 */
export async function markBaselineViolations(c: Queryable, cabinetId: string): Promise<void> {
  if (typeof cabinetId !== "string" || !CABINET_ID.test(cabinetId)) throw new Error("a cabinet id is required to mark baseline violations");
  await c.query(
    `UPDATE ch SET violates_baseline = CASE WHEN EXISTS (SELECT 1 FROM cabinet_drift d WHERE d.cabinet_id = ch.cabinet_id AND d.category = ch.category AND d.item_key = ch.item_key) THEN 1 ELSE 0 END
       FROM config_changes ch WHERE ch.cabinet_id = $1 AND ch.observed_at > DATEADD(day, -30, SYSUTCDATETIME())`, [cabinetId]);
}

export async function ingestConfig(pool: Pool, cabinetId: string, snapshots: readonly Snapshot[], source: "agent" | "refresh"): Promise<IngestSummary> {
  for (const s of snapshots) verifySnapshot(s);
  const summary: IngestSummary = { first: 0, unchanged: 0, changed: 0, stale: 0, categoriesChanged: [], latestObservedAt: null };
  // One transaction for the batch, so it is stored whole or not at all, and one section at a time per cabinet: two uploads
  // (an agent's and a console refresh) cannot both be "first" for a category.
  const results = await transaction(pool, async c => {
    await lock(c, `config:${cabinetId}`);
    const rows = (await c.query<CurrentRow & { category: string }>("SELECT category, hash, version_id, observed_at FROM config_current WITH (UPDLOCK, ROWLOCK) WHERE cabinet_id = $1", [cabinetId])).rows;
    const known = new Map<string, CurrentRow | undefined>(CATEGORIES.map(k => [k, rows.find(r => r.category === k)]));
    const out: IngestResult[] = [];
    for (const s of snapshots) {
      const r = await storeSnapshot(c, cabinetId, s, source, new Date(), known);
      // A category repeated in one batch is judged against what the batch just stored.
      known.delete(s.category);
      out.push(r.result);
    }
    return out;
  });
  snapshots.forEach((s, i) => {
    const result = results[i]!;
    summary[result]++;
    if (result === "changed" || result === "first") summary.categoriesChanged.push(s.category as Category);
    const seen = new Date(Math.min(new Date(s.observedAt).getTime(), Date.now()));
    if (result !== "stale" && (!summary.latestObservedAt || seen > summary.latestObservedAt)) summary.latestObservedAt = seen;
  });
  return summary;
}

/** The configuration in force for a cabinet, category by category, with the items unpacked. */
export async function currentItems(db: Queryable, cabinetId: string, only?: readonly Category[]): Promise<Map<Category, { items: Item[]; versionId: number; observedAt: Date; changedAt: Date; hash: string; truncated: boolean }>> {
  const rows = (await db.query<{ category: Category; items: Buffer; version_id: string; observed_at: Date; changed_at: Date; hash: string; truncated: boolean }>(
    `SELECT c.category, v.items, c.version_id, c.observed_at, c.changed_at, c.hash, c.truncated
       FROM config_current c JOIN config_versions v ON v.id = c.version_id WHERE c.cabinet_id = $1`, [cabinetId])).rows;
  const out = new Map<Category, { items: Item[]; versionId: number; observedAt: Date; changedAt: Date; hash: string; truncated: boolean }>();
  for (const r of rows) {
    if (only && !only.includes(r.category)) continue;
    out.set(r.category, { items: unpackItems(r.items), versionId: Number(r.version_id), observedAt: r.observed_at, changedAt: r.changed_at, hash: r.hash.trim(), truncated: r.truncated });
  }
  return out;
}
