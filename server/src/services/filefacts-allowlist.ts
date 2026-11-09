// Where the named file paths of the file-facts read are kept and resolved (docs/platform/archive/improvement-plan.md section 5): a
// versioned list per fleet, client, site or cabinet, set only by a server administrator with step-up and an audit entry.
//
// The list is a configuration, so it is stored the way every other setting that follows a scope is stored: one JSON column on
// clients, sites and cabinets, with the fleet default as one row in settings (the device-settings convention, so the list travels
// with the scope it belongs to and a removed scope takes its list with it). The most specific level wins whole — a cabinet's list
// replaces the site's, it is not merged with it — the same rule the fleet settings, the scanner IDs and the watched services follow.
//
// Every stored list carries the SHA-256 of its own canonical entries, recomputed on the way back out exactly as a configuration
// snapshot's hash is. A value that was edited outside the platform does not describe its own entries, so it is not used at all: the
// level is skipped and reported as rejected rather than silently half-applied.
import { audit, transaction, type Pool, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { configHash, type Item } from "./config-canonical.js";
import { ROLE_RANK, type Role } from "./roles.js";
import { Refused } from "./errors.js";
import { MAX_FILE_BYTES, MAX_FILES, canonicalRoot, joinWithinRoot, keyProblem } from "./filefacts-path.js";
import { parseJson, upsertSetting } from "./settings.js";

export type AllowlistLevel = "fleet" | "client" | "site" | "cabinet";
/** The levels a list can be set at, most specific first: the order resolution walks. */
export const ALLOWLIST_LEVELS: readonly AllowlistLevel[] = ["cabinet", "site", "client", "fleet"];
export const ALLOWLIST_ACTION = "filefacts.allowlist";
export const READ_ACTION = "filefacts.read";
export const FACTS_ACTION = "filefacts.path";
/** The settings row that holds the fleet's list, next to the other fleet defaults. */
export const ALLOWLIST_SETTING_KEY = "filefacts.paths";
/** The column each scope carries its own list in. */
export const ALLOWLIST_COLUMN = "filefacts_paths";
const TABLE: Record<Exclude<AllowlistLevel, "fleet">, string> = { client: "clients", site: "sites", cabinet: "cabinets" };
/** The step-up action a level's write is bound to, named after the levels the rest of the platform already uses. */
export const ALLOWLIST_SET_ACTION: Record<AllowlistLevel, string> = { fleet: "settings.filefacts", client: "client.filefacts", site: "site.filefacts", cabinet: "cabinet.filefacts" };
const SET_ACTION = ALLOWLIST_SET_ACTION;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AllowlistEntry {
  /** The baseline item key the file stands for (app:<name>). */
  key: string;
  /** The canonical root the file lives in, as the owner wrote it. */
  root: string;
  /** One file name inside that root, exactly as configured. */
  name: string;
  includeSha256: boolean;
  maxBytes: number;
}

/** One level's stored list, as it is kept in the column and handed to callers. */
export interface AllowlistContent {
  version: number;
  entries: AllowlistEntry[];
  hash: string;
  setBy: string;
  setAt: string;
}

export interface AllowlistLevels {
  fleet: AllowlistContent | null;
  client: AllowlistContent | null;
  site: AllowlistContent | null;
  cabinet: AllowlistContent | null;
  effective: AllowlistContent | null;
  source: AllowlistLevel | "none";
  /** Levels whose stored value is present but does not describe its own entries: reported, never used. */
  rejected: AllowlistLevel[];
}

/** What the server asks a cabinet to read, and what it will accept back. */
export const allowlistItems = (entries: readonly AllowlistEntry[]): Item[] =>
  entries.map(e => ({ key: e.key, values: { root: e.root, name: e.name, includeSha256: e.includeSha256, maxBytes: e.maxBytes } }));

/** The fingerprint of a list: SHA-256 of the canonical JSON of its entries, the convention a configuration snapshot uses. */
export const allowlistHash = (entries: readonly AllowlistEntry[]): string => configHash(allowlistItems(entries));

/** Setting these paths is an owner action: no Tier 1 or Tier 2 account and no cabinet agent ever chooses a path. */
export function assertOwner(role: string): void {
  if (ROLE_RANK[role as Role] !== ROLE_RANK.admin) throw new Refused("forbidden", 403, "only a server administrator sets the file paths to read");
}

/** The id of a scope as it is stored: lower-case, as every other scope id in the platform is. */
export function scopeKey(level: AllowlistLevel, id: unknown): string {
  if (level === "fleet") return "";
  const text = typeof id === "string" ? id.trim().toLowerCase() : "";
  if (!UUID.test(text)) throw new Refused("invalid_params", 400, `${level}: not a scope id`);
  return text;
}

/**
 * One entry, canonicalised and bounded, or the reason it is refused. The JSON Schema has already run: this is the second check,
 * and it is the one that owns the path rules, so a caller that skipped the schema still cannot get an uncooked path into the list.
 */
export function normalizeEntry(raw: unknown): { ok: true; entry: AllowlistEntry } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not_an_entry" };
  const e = raw as Record<string, unknown>;
  const ofKey = keyProblem(e.key);
  if (ofKey) return { ok: false, reason: `key_${ofKey}` };
  const root = canonicalRoot(e.root);
  if (!root.ok) return { ok: false, reason: `root_${root.reason}` };
  const joined = joinWithinRoot(root.path, e.name);
  if (!joined.ok) return { ok: false, reason: `name_${joined.reason}` };
  if (typeof e.includeSha256 !== "boolean") return { ok: false, reason: "include_sha256_not_boolean" };
  let maxBytes = MAX_FILE_BYTES;
  if (e.maxBytes !== undefined) {
    if (typeof e.maxBytes !== "number" || !Number.isInteger(e.maxBytes) || e.maxBytes < 0 || e.maxBytes > MAX_FILE_BYTES) return { ok: false, reason: "max_bytes_out_of_range" };
    maxBytes = e.maxBytes;
  }
  return { ok: true, entry: { key: e.key as string, root: root.path, name: joined.path.slice(root.path.length + 1), includeSha256: e.includeSha256, maxBytes } };
}

/** A whole list: at most MAX_FILES entries, one per key, in key order so the list's hash does not depend on how it was written. */
export function normalizeEntries(raw: unknown): { ok: true; entries: AllowlistEntry[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: "not_a_list" };
  if (raw.length > MAX_FILES) return { ok: false, reason: "too_many_entries" };
  const out: AllowlistEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const one = normalizeEntry(item);
    if (!one.ok) return one;
    if (seen.has(one.entry.key)) return { ok: false, reason: "duplicate_key" };
    seen.add(one.entry.key);
    out.push(one.entry);
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { ok: true, entries: out };
}

/**
 * The list one level's stored value describes, or null when there is nothing there, it is unreadable, or its hash does not
 * describe its own entries. Takes the raw column value (text as it was stored, or an already-parsed object).
 */
export function verifyStored(raw: unknown): AllowlistContent | null {
  const value = parseJson<Record<string, unknown>>(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = normalizeEntries(value.entries);
  if (!entries.ok) return null;
  const hash = typeof value.hash === "string" ? value.hash.toLowerCase() : "";
  if (hash.length !== 64 || allowlistHash(entries.entries) !== hash) return null;
  const version = typeof value.version === "number" ? value.version : Number(value.version);
  if (!Number.isInteger(version) || version < 1) return null;
  const setAt = value.setAt instanceof Date ? value.setAt.toISOString() : typeof value.setAt === "string" ? value.setAt : "";
  return { version, entries: entries.entries, hash, setBy: typeof value.setBy === "string" ? value.setBy : "", setAt };
}

/** The four levels as they were read, with the level that wins worked out. */
export function resolveLevels(found: Partial<Record<AllowlistLevel, unknown>>): AllowlistLevels {
  const rejected: AllowlistLevel[] = [];
  const read = (level: AllowlistLevel): AllowlistContent | null => {
    const stored = found[level];
    if (stored === null || stored === undefined) return null; // nothing set at this level
    const content = verifyStored(stored);
    if (!content) rejected.push(level);
    return content;
  };
  const levels = { fleet: read("fleet"), client: read("client"), site: read("site"), cabinet: read("cabinet") };
  const source = ALLOWLIST_LEVELS.find(level => levels[level] !== null) ?? "none";
  return { ...levels, effective: source === "none" ? null : levels[source], source, rejected };
}

/** One level's own value, aliased so the data layer hands back the stored JSON rather than parsing it as a known column. */
const LEVEL_SQL: Record<AllowlistLevel, string> = {
  fleet: `SELECT (SELECT TOP (1) [value] FROM settings WHERE [key] = '${ALLOWLIST_SETTING_KEY}') AS [value]`,
  client: `SELECT c.${ALLOWLIST_COLUMN} AS [value] FROM clients c WHERE c.id = $1 AND c.removed_at IS NULL`,
  site: `SELECT s.${ALLOWLIST_COLUMN} AS [value] FROM sites s WHERE s.id = $1 AND s.removed_at IS NULL`,
  cabinet: `SELECT k.${ALLOWLIST_COLUMN} AS [value] FROM cabinets k WHERE k.id = $1 AND k.status <> 'removed'`,
};

/** The list set at one level, or null when nothing is set there. A scope that does not exist is not found, not an empty list. */
export async function readLevel(db: Queryable, level: AllowlistLevel, id: string | null): Promise<AllowlistContent | null> {
  if (!ALLOWLIST_LEVELS.includes(level)) throw new Refused("invalid_params", 400, "not a level");
  const key = scopeKey(level, id);
  const row = (await db.query<{ value: unknown }>(LEVEL_SQL[level], level === "fleet" ? [] : [key])).rows[0];
  if (!row) throw new Refused("not_found", 404, `no such ${level}`);
  return verifyStored(row.value);
}

/**
 * Every level that applies to one cabinet, in one read, with the list that wins. This is what a read request is built from, so it
 * also reports the levels whose stored value was rejected: a list nobody can see is a list nobody should trust.
 */
export async function allowlistLevels(db: Queryable, cabinetId: string): Promise<AllowlistLevels> {
  const row = (await db.query<{ k: unknown; s: unknown; c: unknown; f: unknown }>(
    `SELECT k.${ALLOWLIST_COLUMN} AS k, s.${ALLOWLIST_COLUMN} AS s, c.${ALLOWLIST_COLUMN} AS c,
            (SELECT TOP (1) [value] FROM settings WHERE [key] = '${ALLOWLIST_SETTING_KEY}') AS f
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
      WHERE k.id = $1 AND k.status <> 'removed'`, [scopeKey("cabinet", cabinetId)])).rows[0];
  if (!row) throw new Refused("not_found", 404, "no such cabinet");
  return resolveLevels({ fleet: row.f, client: row.c, site: row.s, cabinet: row.k });
}

/**
 * Sets, replaces or removes the list for one level. The step-up token is bound to the level and to these exact entries, so the
 * owner confirms the paths themselves and not just the act of saving; the version steps up on every change and the whole thing is
 * audited with the keys (never the paths twice: they are in the stored list, which the audit points at by version and hash).
 * An empty list (or null) clears the level, which falls back to what is above it.
 */
export async function setAllowlist(pool: Pool, user: { userId: string; role: string }, level: AllowlistLevel, id: string | null,
  entriesRaw: unknown, stepUpToken: string): Promise<AllowlistContent | null> {
  assertOwner(user.role);
  if (!ALLOWLIST_LEVELS.includes(level)) throw new Refused("invalid_params", 400, "not a level");
  const key = scopeKey(level, id);
  let entries: AllowlistEntry[] | null = null;
  if (entriesRaw !== null && entriesRaw !== undefined) {
    const list = normalizeEntries(entriesRaw);
    if (!list.ok) throw new Refused("invalid_params", 400, `the file paths were refused: ${list.reason}`);
    if (list.entries.length > 0) entries = list.entries;
  }
  const target = level === "fleet" ? "fleet" : key;
  return transaction(pool, async c => {
    // Reading the level first is also the scope check: a level whose scope is gone is not found, never "empty".
    const previous = (await readLevel(c, level, level === "fleet" ? null : key))?.version ?? 0;
    await consumeStepUpToken(c, stepUpToken, user.userId, SET_ACTION[level], target, { level, id: key, entries });
    const value = entries === null ? null : storedValue(entries, user.userId, previous);
    if (level === "fleet") {
      if (value === null) await c.query("DELETE FROM settings WHERE [key] = $1", [ALLOWLIST_SETTING_KEY]);
      else await upsertSetting(c, ALLOWLIST_SETTING_KEY, value, user.userId);
    } else {
      const r = await c.query(`UPDATE ${TABLE[level]} SET ${ALLOWLIST_COLUMN} = $2 WHERE id = $1 AND ${level === "cabinet" ? "status <> 'removed'" : "removed_at IS NULL"}`,
        [key, value === null ? null : JSON.stringify(value)]);
      if (r.rowCount !== 1) throw new Refused("not_found", 404, `no such ${level}`);
    }
    const place = level === "fleet" ? {} : { targetKind: level, targetId: key };
    await audit(c, { actorKind: "user", actorId: user.userId, action: SET_ACTION[level], ...place, outcome: "succeeded",
      details: { level, id: key, removed: value === null, entries: entries?.length ?? 0, version: value?.version ?? null, keys: entries?.map(e => e.key) ?? [] } });
    return value;
  });
}

/** What one level's column holds: the entries, their fingerprint, the version and who set them. */
function storedValue(entries: readonly AllowlistEntry[], by: string, previous: number): { version: number; entries: AllowlistEntry[]; hash: string; setBy: string; setAt: string } {
  return { version: previous + 1, entries: [...entries], hash: allowlistHash(entries), setBy: by, setAt: new Date().toISOString() };
}
