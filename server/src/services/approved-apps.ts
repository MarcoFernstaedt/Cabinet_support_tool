// The applications and services a cabinet may be asked to control (docs/spec/13-roadmap.md: "process.end and app.restart with a
// per-client allowlist"). This is the list the owner puts in so that nothing else can be aimed at: a control request names one of
// these entries, and the agent holds the same list and refuses anything that is not in it.
//
// The list is a configuration, so it is stored the way every other setting that follows a scope is stored (the file-facts paths
// and the watched services are the precedent): one JSON column on clients, sites and cabinets, the fleet default as one settings
// row. The most specific level with a list wins whole; null inherits, [] approves nothing at that level.
//
// Every stored value carries the SHA-256 of its own canonical entries and is recomputed on the way out, and its entries are checked
// against the same contract shape the heartbeat answer uses. This is a consistency check, not tamper protection: the hash has no key,
// so anyone who can write the column can also write a matching hash. What it does catch is a value that was hand-edited or truncated
// carelessly. Such a level is reported as rejected and resolves to an empty list - it approves nothing - rather than falling through to
// a broader level, so damage at one level can only take programs away from the cabinets below it, never add any.
//
// Only a server administrator sets a list, with a step-up token bound to the exact entries: a Tier 1 or Tier 2 account, the
// console's write path and the agent itself never submit a path.
import { audit, transaction, type Pool, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { configHash, type Item } from "./config-canonical.js";
import { ROLE_RANK, type Role } from "./roles.js";
import { Refused } from "./errors.js";
import { canonicalRoot, joinWithinRoot, keyProblem } from "./filefacts-path.js";
import { parseJson, upsertSetting } from "./settings.js";
import { commonDefs } from "../contracts.js";

export type AppLevel = "fleet" | "client" | "site" | "cabinet";
/** The levels a list can be set at, most specific first: the order resolution walks. */
export const APP_LEVELS: readonly AppLevel[] = ["cabinet", "site", "client", "fleet"];
/** The settings row that holds the fleet's list, next to the other fleet defaults. */
export const APPS_SETTING_KEY = "apps.approved";
/** The column each scope carries its own list in. */
export const APPS_COLUMN = "approved_apps";
/** The most entries one level may hold (the contract caps the request at the same number). */
export const MAX_APPS = 32;
const TABLE: Record<Exclude<AppLevel, "fleet">, string> = { client: "clients", site: "sites", cabinet: "cabinets" };
/** The step-up action a level's write is bound to, named after the levels the rest of the platform already uses. */
export const APPS_SET_ACTION: Record<AppLevel, string> = { fleet: "settings.apps", client: "client.apps", site: "site.apps", cabinet: "cabinet.apps" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The extensions an approved application may have: the agent starts a program, never a script or a batch file. */
const EXECUTABLE = /\.exe$/i;
/** A Windows service's key name (not its display name), the same rule as common.schema.json#/$defs/serviceName. */
const SERVICE_NAME = /^[A-Za-z0-9_.$-](?:[A-Za-z0-9_.$ -]{0,78}[A-Za-z0-9_.$-])?$/;

export interface ApprovedApp {
  /** The baseline item key the program stands for (app:<name>). */
  key: string;
  /** application: started by its path. service: controlled through the service control manager. */
  kind: "application" | "service";
  /** What the owner calls it. Text only, shown in the console. */
  name: string;
  /** The canonical directory the executable lives in. */
  root: string;
  /** One file name inside that root, exactly as configured. */
  file: string;
  /** The service's own name; services only. */
  serviceName: string | null;
}

/** What one level's column holds: the entries, their fingerprint, the version and who set them. */
export interface AppList {
  version: number;
  entries: ApprovedApp[];
  hash: string;
  setBy: string;
  setAt: string;
}

export interface AppLevels {
  fleet: AppList | null;
  client: AppList | null;
  site: AppList | null;
  cabinet: AppList | null;
  effective: AppList | null;
  source: AppLevel | "none";
  /** Levels whose stored value is present but does not describe its own entries: reported, never used. */
  rejected: AppLevel[];
}

/** What the server asks the agent to hold, and how the entry is identified in a request. */
export const appItems = (entries: readonly ApprovedApp[]): Item[] =>
  entries.map(e => ({ key: e.key, values: { kind: e.kind, path: `${e.root}\\${e.file}`, serviceName: e.serviceName ?? "" } }));

/** The fingerprint of a list: SHA-256 of the canonical JSON of its entries, the convention a configuration snapshot uses. */
export const appsHash = (entries: readonly ApprovedApp[]): string => configHash(appItems(entries));

/** The full path of an entry's executable, as it was configured. */
export const entryPath = (e: ApprovedApp): string => `${e.root}\\${e.file}`;

/**
 * One entry in the form the column holds it: the owner's own field names and the path whole. The internal form splits the path
 * into a root and one file name, which is what the checks work on; storing the path whole keeps the column readable by any other
 * tool and gives the agent a path it can compare against what Windows reports.
 */
export const rawEntry = (e: ApprovedApp): ApprovedAppEntry =>
  e.serviceName === null
    ? { key: e.key, kind: e.kind, name: e.name, path: entryPath(e) }
    : { key: e.key, kind: e.kind, name: e.name, path: entryPath(e), serviceName: e.serviceName };

/** One entry as it travels: to the console, and to the cabinet on a heartbeat. The path is the whole executable path the cabinet checks the running program against. */
export interface ApprovedAppEntry {
  key: string; kind: ApprovedApp["kind"]; name: string; path: string; serviceName?: string;
}

/** Setting this list is an owner action: no Tier 1 or Tier 2 account and no cabinet agent ever chooses a program. */
export function assertOwner(role: string): void {
  if (ROLE_RANK[role as Role] !== ROLE_RANK.admin) throw new Refused("forbidden", 403, "only a server administrator approves an application");
}

/** The id of a scope as it is stored: lower-case, as every other scope id in the platform is. */
export function scopeKey(level: AppLevel, id: unknown): string {
  if (level === "fleet") return "";
  const text = typeof id === "string" ? id.trim().toLowerCase() : "";
  if (!UUID.test(text)) throw new Refused("invalid_params", 400, `${level}: not a scope id`);
  return text;
}

/** A text field that is text only: never a path, never an argument, never a control character. */
const clean = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f\\/:*?"<>|]/.test(v) ? v.trim() : null);

/**
 * One entry, canonicalised and bounded, or the reason it is refused. The JSON Schema has already run: this is the second check,
 * and it owns the path rules, so a caller that skipped the schema still cannot get an uncooked path into the list.
 */
export function normalizeEntry(raw: unknown): { ok: true; entry: ApprovedApp } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not_an_entry" };
  const e = raw as Record<string, unknown>;
  const ofKey = keyProblem(e.key);
  if (ofKey) return { ok: false, reason: `key_${ofKey}` };
  if (e.kind !== "application" && e.kind !== "service") return { ok: false, reason: "kind_not_known" };
  const name = clean(e.name, 128);
  if (name === null) return { ok: false, reason: "name_not_text" };
  if (typeof e.path !== "string") return { ok: false, reason: "path_not_text" };
  const cut = e.path.lastIndexOf("\\");
  if (cut < 3) return { ok: false, reason: "path_not_absolute" };
  const root = canonicalRoot(e.path.slice(0, cut));
  if (!root.ok) return { ok: false, reason: `path_${root.reason}` };
  const joined = joinWithinRoot(root.path, e.path.slice(cut + 1));
  if (!joined.ok) return { ok: false, reason: `path_${joined.reason}` };
  const file = joined.path.slice(root.path.length + 1);
  if (!EXECUTABLE.test(file)) return { ok: false, reason: "path_not_an_executable" };
  let serviceName: string | null = null;
  if (e.kind === "service") {
    if (typeof e.serviceName !== "string" || !SERVICE_NAME.test(e.serviceName)) return { ok: false, reason: "service_name_not_text" };
    serviceName = e.serviceName;
  }
  return { ok: true, entry: { key: e.key as string, kind: e.kind, name, root: root.path, file, serviceName } };
}

/** A whole list: at most MAX_APPS entries, one per key, in key order so the list's hash does not depend on how it was written. */
export function normalizeEntries(raw: unknown): { ok: true; entries: ApprovedApp[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: "not_a_list" };
  if (raw.length > MAX_APPS) return { ok: false, reason: "too_many_entries" };
  const out: ApprovedApp[] = [];
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
export function verifyStored(raw: unknown): AppList | null {
  const value = parseJson<Record<string, unknown>>(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = normalizeEntries(value.entries);
  if (!entries.ok) return null;
  // The same shape the heartbeat answer is checked against (key at most 64 characters, the program path pattern): a stored list the
  // contract would refuse would otherwise fail every heartbeat of every cabinet below it.
  if (!commonDefs.approvedAppEntries.is(entries.entries.map(rawEntry))) return null;
  const hash = typeof value.hash === "string" ? value.hash.toLowerCase() : "";
  if (hash.length !== 64 || appsHash(entries.entries) !== hash) return null;
  const version = typeof value.version === "number" ? value.version : Number(value.version);
  if (!Number.isInteger(version) || version < 1) return null;
  const setAt = value.setAt instanceof Date ? value.setAt.toISOString() : typeof value.setAt === "string" ? value.setAt : "";
  return { version, entries: entries.entries, hash, setBy: typeof value.setBy === "string" ? value.setBy : "", setAt };
}

/** What a level whose stored value was rejected resolves to: a list of its own that approves nothing. */
const DENY_ALL: AppList = Object.freeze({ version: 0, entries: [], hash: "", setBy: "", setAt: "" }) as AppList;

/**
 * The four levels as they were read, with the level that wins worked out. A level holding a value that does not check out is still a
 * level that was set: it wins as an empty list (deny), and never lets the broader level's list through in its place.
 */
export function resolveLevels(found: Partial<Record<AppLevel, unknown>>): AppLevels {
  const rejected: AppLevel[] = [];
  const present = new Set<AppLevel>();
  const read = (level: AppLevel): AppList | null => {
    const stored = found[level];
    if (stored === null || stored === undefined) return null; // nothing set at this level
    present.add(level);
    const content = verifyStored(stored);
    if (!content) rejected.push(level);
    return content;
  };
  const levels = { fleet: read("fleet"), client: read("client"), site: read("site"), cabinet: read("cabinet") };
  const source = APP_LEVELS.find(level => present.has(level)) ?? "none";
  return { ...levels, effective: source === "none" ? null : levels[source] ?? DENY_ALL, source, rejected };
}

/** One level's own value, aliased so the data layer hands back the stored JSON rather than parsing it as a known column. */
const LEVEL_SQL: Record<AppLevel, string> = {
  fleet: `SELECT (SELECT TOP (1) [value] FROM settings WHERE [key] = '${APPS_SETTING_KEY}') AS [value]`,
  client: `SELECT c.${APPS_COLUMN} AS [value] FROM clients c WHERE c.id = $1 AND c.removed_at IS NULL`,
  site: `SELECT s.${APPS_COLUMN} AS [value] FROM sites s WHERE s.id = $1 AND s.removed_at IS NULL`,
  cabinet: `SELECT k.${APPS_COLUMN} AS [value] FROM cabinets k WHERE k.id = $1 AND k.status <> 'removed'`,
};

/** One level's list, or null when nothing is set there. A scope that does not exist is not found, not an empty list. */
export async function readLevel(db: Queryable, level: AppLevel, id: string | null): Promise<AppList | null> {
  if (!APP_LEVELS.includes(level)) throw new Refused("invalid_params", 400, "not a level");
  const key = scopeKey(level, id);
  const row = (await db.query<{ value: unknown }>(LEVEL_SQL[level], level === "fleet" ? [] : [key])).rows[0];
  if (!row) throw new Refused("not_found", 404, `no such ${level}`);
  return verifyStored(row.value);
}

/**
 * Every level that applies to one cabinet, in one read, with the list that wins. A control request is checked against this, so it
 * also reports the levels whose stored value was rejected: a list nobody can see is a list nobody should trust.
 */
export async function appLevels(db: Queryable, cabinetId: string): Promise<AppLevels> {
  const row = (await db.query<{ k: unknown; s: unknown; c: unknown; f: unknown }>(
    `SELECT k.${APPS_COLUMN} AS k, s.${APPS_COLUMN} AS s, c.${APPS_COLUMN} AS c,
            (SELECT TOP (1) [value] FROM settings WHERE [key] = '${APPS_SETTING_KEY}') AS f
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
      WHERE k.id = $1 AND k.status <> 'removed'`, [scopeKey("cabinet", cabinetId)])).rows[0];
  if (!row) throw new Refused("not_found", 404, "no such cabinet");
  return resolveLevels({ fleet: row.f, client: row.c, site: row.s, cabinet: row.k });
}

/**
 * Sets, replaces or removes the list for one level. entries null removes it (the level above applies); an empty list approves
 * nothing at this level and still wins. The step-up token is bound to the level and to these exact entries as sent, so the owner confirms the programs themselves and not just the act of saving; the version steps up on every change and the whole thing is audited with the keys (never the paths twice: they are in the stored list, which the audit points at by version and hash).
 */
export async function setApprovedApps(pool: Pool, user: { userId: string; role: string }, level: AppLevel, id: string | null,
  entriesRaw: unknown, stepUpToken: string, confirmed?: unknown): Promise<AppList | null> {
  assertOwner(user.role);
  if (!APP_LEVELS.includes(level)) throw new Refused("invalid_params", 400, "not a level");
  const key = scopeKey(level, id);
  // null removes this level's list so the level above applies; [] is a list of its own that approves nothing here.
  let entries: ApprovedApp[] | null = null;
  if (entriesRaw !== null && entriesRaw !== undefined) {
    const list = normalizeEntries(entriesRaw);
    if (!list.ok) throw new Refused("invalid_params", 400, `the approved applications were refused: ${list.reason}`);
    entries = list.entries;
  }
  const target = level === "fleet" ? "fleet" : key;
  return transaction(pool, async c => {
    // Reading the level first is also the scope check: a level whose scope is gone is not found, never "empty".
    const previous = (await readLevel(c, level, level === "fleet" ? null : key))?.version ?? 0;
    // The token is bound to the request as the person sent it ({level, id, entries} in canonical JSON), so the console hashes exactly
    // what it sends and needs none of the server's own normalisation; the route passes the body itself, after checking it names the
    // same level and scope as the address.
    await consumeStepUpToken(c, stepUpToken, user.userId, APPS_SET_ACTION[level], target,
      confirmed ?? { level, id: level === "fleet" ? null : key, entries: entriesRaw ?? null });
    const stored = entries === null ? null : storedValue(entries, user.userId, previous);
    if (level === "fleet") {
      if (stored === null) await c.query("DELETE FROM settings WHERE [key] = $1", [APPS_SETTING_KEY]);
      else await upsertSetting(c, APPS_SETTING_KEY, stored, user.userId);
    } else {
      const r = await c.query(`UPDATE ${TABLE[level]} SET ${APPS_COLUMN} = $2 WHERE id = $1 AND ${level === "cabinet" ? "status <> 'removed'" : "removed_at IS NULL"}`,
        [key, stored === null ? null : JSON.stringify(stored)]);
      if (r.rowCount !== 1) throw new Refused("not_found", 404, `no such ${level}`);
    }
    const place = level === "fleet" ? {} : { targetKind: level, targetId: key };
    await audit(c, { actorKind: "user", actorId: user.userId, action: APPS_SET_ACTION[level], ...place, outcome: "succeeded",
      details: { level, id: key, removed: stored === null, entries: entries?.length ?? 0, version: stored?.version ?? null, keys: entries?.map(e => e.key) ?? [] } });
    // The caller gets the list back in the same shape a read hands out, so a console that saves a list can render it straight away.
    return stored === null || entries === null ? null : { version: stored.version, entries, hash: stored.hash, setBy: stored.setBy, setAt: stored.setAt };
  });
}

/** A level's column value for a list, as JSON text: for seeding (the demo fleet) and tests, through the same path a write takes. */
export function storedApprovedApps(raw: unknown, by: string, version = 1): string {
  const list = normalizeEntries(raw);
  if (!list.ok) throw new Error(`not an approved-applications list: ${list.reason}`);
  return JSON.stringify(storedValue(list.entries, by, version - 1));
}

/** What one level's column holds: the entries in the owner's form, their fingerprint, the version and who set them. */
function storedValue(entries: readonly ApprovedApp[], by: string, previous: number): { version: number; entries: ApprovedAppEntry[]; hash: string; setBy: string; setAt: string } {
  return { version: previous + 1, entries: entries.map(rawEntry), hash: appsHash(entries), setBy: by, setAt: new Date().toISOString() };
}
