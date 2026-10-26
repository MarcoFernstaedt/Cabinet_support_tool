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
//
// Signing (docs/spec/09-open-decisions.md "Signing the approved list"): once the platform has an Admin list-signing key
// (contracts/trust/approved-list), a saved list does not go live. It waits as the level's pending change, and the level's current
// list stays in force, until an Admin signs the exact document the server offers (Sign-ApprovedList.ps1) and uploads the signature.
// The signed document is kept with the list exactly as it was signed, and the heartbeat answer carries it so the cabinet's broker
// can check it. Removing a level's list needs no signature: the level above applies, and its list carries its own.
import { audit, transaction, type Pool, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { configHash, type Item } from "./config-canonical.js";
import { ROLE_RANK, type Role } from "./roles.js";
import { Refused } from "./errors.js";
import { canonicalRoot, joinWithinRoot, keyProblem } from "./filefacts-path.js";
import { parseJson, upsertSetting } from "./settings.js";
import { commonDefs, type ApprovedListSignature } from "../contracts.js";
import { listDocumentBytes, openSignedList, type ListSigningKeys } from "./approved-list-signing.js";

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
  /** The signed document and its signature, once an Admin has signed this version; null while it is not signed. */
  signed: SignedList | null;
}

/** One level's list as an Admin signed it: base64 of the document's exact bytes, and the detached signature over them. */
export interface SignedList { document: string; signature: ApprovedListSignature }

/** A saved change waiting for a signature. It is in force nowhere until it is signed. */
export type PendingList = Omit<AppList, "signed">;

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
  const signed = value.signed === undefined || value.signed === null ? null : signedFor(value.signed, version, hash);
  if (signed === undefined) return null;
  return { version, entries: entries.entries, hash, setBy: typeof value.setBy === "string" ? value.setBy : "", setAt, signed };
}

/**
 * The stored signed document, when it says what the list beside it says (the same version and the same entries); undefined when it
 * does not, which makes the whole level damaged. The signature itself was checked when it was uploaded and every cabinet checks it
 * again; this keeps the server's own control check and the cabinet's list from ever disagreeing about what is approved.
 */
function signedFor(raw: unknown, version: number, hash: string): SignedList | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { document, signature } = raw as Record<string, unknown>;
  if (typeof document !== "string" || signature === null || typeof signature !== "object" || Array.isArray(signature)) return undefined;
  const parsed = parseJson<Record<string, unknown>>(Buffer.from(document, "base64").toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || parsed.version !== version) return undefined;
  const entries = normalizeEntries(parsed.entries);
  if (!entries.ok || appsHash(entries.entries) !== hash) return undefined;
  return { document, signature: signature as ApprovedListSignature };
}

/** A pending change as stored, or null when there is none or it does not check out (a damaged pending change is not offered for signing). */
function verifyPending(raw: unknown): PendingList | null {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return null;
  const list = verifyStored({ ...raw, signed: null });
  if (!list) return null;
  const { signed: _none, ...pending } = list;
  return pending;
}

/**
 * One level's column value, split into the list in force and the change waiting for a signature. A value that holds only a pending
 * change is a level with nothing in force yet, so the level above applies; any other value that does not check out is damaged.
 */
export function splitStored(raw: unknown): { present: boolean; live: AppList | null; pending: PendingList | null } {
  if (raw === null || raw === undefined) return { present: false, live: null, pending: null };
  const value = parseJson<Record<string, unknown>>(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { present: true, live: null, pending: null };
  const pending = verifyPending(value.pending);
  if (pending && Object.keys(value).length === 1) return { present: false, live: null, pending };
  return { present: true, live: verifyStored(value), pending };
}

/** What a level whose stored value was rejected resolves to: a list of its own that approves nothing. */
const DENY_ALL: AppList = Object.freeze({ version: 0, entries: [], hash: "", setBy: "", setAt: "", signed: null }) as AppList;

/**
 * The four levels as they were read, with the level that wins worked out. A level holding a value that does not check out is still a
 * level that was set: it wins as an empty list (deny), and never lets the broader level's list through in its place.
 */
export function resolveLevels(found: Partial<Record<AppLevel, unknown>>): AppLevels {
  const rejected: AppLevel[] = [];
  const present = new Set<AppLevel>();
  const read = (level: AppLevel): AppList | null => {
    const stored = splitStored(found[level]);
    if (!stored.present) return null; // nothing in force at this level (at most a change waiting for its signature)
    present.add(level);
    if (!stored.live) rejected.push(level);
    return stored.live;
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
  return (await readLevelState(db, level, id)).list;
}

/**
 * One level's list and whether a stored value was rejected. A rejected level is not "nothing set": it denies everything, so the console
 * has to be able to say so (and let an Admin replace or remove it) rather than show it as empty.
 */
export async function readLevelState(db: Queryable, level: AppLevel, id: string | null): Promise<{ list: AppList | null; rejected: boolean; pending: PendingList | null }> {
  const { stored } = await readRaw(db, level, id);
  return { list: stored.live, rejected: stored.present && stored.live === null, pending: stored.pending };
}

/** One level's column as it is stored, and split. A scope that does not exist is not found. */
async function readRaw(db: Queryable, level: AppLevel, id: string | null): Promise<{ key: string; raw: unknown; stored: ReturnType<typeof splitStored> }> {
  if (!APP_LEVELS.includes(level)) throw new Refused("invalid_params", 400, "not a level");
  const key = scopeKey(level, id);
  const row = (await db.query<{ value: unknown }>(LEVEL_SQL[level], level === "fleet" ? [] : [key])).rows[0];
  if (!row) throw new Refused("not_found", 404, `no such ${level}`);
  return { key, raw: row.value, stored: splitStored(row.value) };
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
 * nothing at this level and still wins. The step-up token is bound to the level and to these exact entries as sent, so the owner
 * confirms the programs themselves and not just the act of saving; the version steps up on every change and the whole thing is
 * audited with the keys (never the paths twice: they are in the stored list, which the audit points at by version and hash).
 *
 * With signing switched on (`signing` holds a key), a new list is kept as the level's pending change and the list in force does not
 * move until an Admin signs it (signApprovedApps). Removing a level's list still takes effect at once.
 */
export async function setApprovedApps(pool: Pool, user: { userId: string; role: string }, level: AppLevel, id: string | null,
  entriesRaw: unknown, stepUpToken: string, confirmed?: unknown, signing?: ListSigningKeys): Promise<AppList | null> {
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
    const { raw, stored } = await readRaw(c, level, level === "fleet" ? null : key);
    const previous = Math.max(stored.live?.version ?? 0, stored.pending?.version ?? 0);
    // The token is bound to the request as the person sent it ({level, id, entries} in canonical JSON), so the console hashes exactly
    // what it sends and needs none of the server's own normalisation; the route passes the body itself, after checking it names the
    // same level and scope as the address.
    await consumeStepUpToken(c, stepUpToken, user.userId, APPS_SET_ACTION[level], target,
      confirmed ?? { level, id: level === "fleet" ? null : key, entries: entriesRaw ?? null });
    const next = entries === null ? null : storedValue(entries, user.userId, previous);
    const waits = next !== null && (signing?.count ?? 0) > 0;
    // Waiting for a signature: the column keeps exactly what it held for the list in force, and the change rides beside it.
    // A damaged value that is not even an object stays damaged (it denies) rather than becoming "nothing set here" (the level above).
    const kept = parseJson<Record<string, unknown>>(raw);
    const inForce = !stored.present ? {} : kept && typeof kept === "object" && !Array.isArray(kept) ? withoutPending(kept) : { unreadable: true };
    const value = next === null ? null : waits ? { ...inForce, pending: next } : next;
    await writeLevel(c, level, key, value, user.userId);
    const place = level === "fleet" ? {} : { targetKind: level, targetId: key };
    await audit(c, { actorKind: "user", actorId: user.userId, action: APPS_SET_ACTION[level], ...place, outcome: "succeeded",
      details: { level, id: key, removed: next === null, waitsForSignature: waits, entries: entries?.length ?? 0, version: next?.version ?? null, keys: entries?.map(e => e.key) ?? [] } });
    // The caller gets the list in force afterwards, in the shape a read hands out (with signing on, the one that was already there).
    return splitStored(value).live;
  });
}

/** What an Admin is asked to sign for one level: the change waiting for a signature, else the list in force when it is not signed yet. */
export interface ToSign { version: number; entries: number; document: string; fileName: string; waiting: boolean }

/** The document bytes for one level's list, written the one way they are always written. */
function documentFor(level: AppLevel, key: string, list: PendingList): Buffer {
  return listDocumentBytes({ level, scopeId: level === "fleet" ? null : key, version: list.version, issuedAt: list.setAt, entries: list.entries.map(rawEntry) });
}

function signable(stored: ReturnType<typeof splitStored>): { list: PendingList; waiting: boolean } | null {
  if (stored.pending) return { list: stored.pending, waiting: true };
  if (stored.live && stored.live.signed === null && stored.live.version > 0) return { list: stored.live, waiting: false };
  return null;
}

/** The document an Admin downloads to sign for one level, or null when there is nothing to sign there. */
export async function listToSign(db: Queryable, level: AppLevel, id: string | null): Promise<ToSign | null> {
  const { key, stored } = await readRaw(db, level, id);
  const target = signable(stored);
  if (!target) return null;
  const bytes = documentFor(level, key, target.list);
  return { version: target.list.version, entries: target.list.entries.length, document: bytes.toString("base64"), waiting: target.waiting,
    fileName: `approved-list-${level}${level === "fleet" ? "" : `-${key.slice(0, 8)}`}-v${target.list.version}.json` };
}

/**
 * Puts a signed list in force. The signature must verify over the exact document the server offers for this level and version
 * (listToSign), with a key the agents hold; anything else is refused and audited, and nothing changes. A pending change that is
 * signed replaces the list in force; signing the list already in force only adds its signature.
 */
export async function signApprovedApps(pool: Pool, user: { userId: string; role: string }, level: AppLevel, id: string | null, version: number,
  signature: ApprovedListSignature, signing: ListSigningKeys): Promise<AppList> {
  assertOwner(user.role);
  if (signing.count === 0) throw new Refused("signing_off", 409, "no list-signing key is set up, so lists are not signed");
  const outcome = await transaction(pool, async c => {
    const { key, raw, stored } = await readRaw(c, level, id);
    const target = signable(stored);
    if (!target || target.list.version !== version) throw new Refused("conflict", 409, `version ${version} of this list is not waiting for a signature`);
    const bytes = documentFor(level, key, target.list);
    const opened = openSignedList(signing, bytes.toString("base64"), signature);
    if (!opened.ok) return { key, refused: opened } as const;
    const live: Record<string, unknown> = { ...storedValueOf(target.list), signed: { document: bytes.toString("base64"), signature } };
    // Signing the list in force keeps a change that is still waiting; signing the waiting change consumes it.
    const kept = parseJson<Record<string, unknown>>(raw);
    if (!target.waiting && kept && typeof kept === "object" && !Array.isArray(kept) && kept.pending) live.pending = kept.pending;
    await writeLevel(c, level, key, live, user.userId);
    await audit(c, { actorKind: "user", actorId: user.userId, action: `${APPS_SET_ACTION[level]}.sign`, ...placeOf(level, key), outcome: "succeeded",
      details: { level, id: key, version, keyId: signature.keyId, entries: target.list.entries.length } });
    return { key, list: splitStored(live).live! } as const;
  });
  if ("list" in outcome) return outcome.list;
  // A refused signature changes nothing, and is recorded on its own so the record outlives the refusal.
  await transaction(pool, c => audit(c, { actorKind: "user", actorId: user.userId, action: `${APPS_SET_ACTION[level]}.sign`, ...placeOf(level, outcome.key),
    outcome: "refused", details: { level, id: outcome.key, version, reason: outcome.refused.reason, keyId: signature.keyId } }));
  throw new Refused("signature_invalid", 422, outcome.refused.why);
}

const placeOf = (level: AppLevel, key: string) => (level === "fleet" ? {} : { targetKind: level, targetId: key });

/** Drops a level's change that is waiting for a signature; the list in force stays as it is. */
export async function discardPendingApps(pool: Pool, user: { userId: string; role: string }, level: AppLevel, id: string | null): Promise<void> {
  assertOwner(user.role);
  await transaction(pool, async c => {
    const { key, raw, stored } = await readRaw(c, level, id);
    if (!stored.pending) throw new Refused("not_found", 404, "no change is waiting for a signature here");
    const kept = parseJson<Record<string, unknown>>(raw)!;
    const rest = withoutPending(kept);
    await writeLevel(c, level, key, Object.keys(rest).length === 0 ? null : rest, user.userId);
    await audit(c, { actorKind: "user", actorId: user.userId, action: `${APPS_SET_ACTION[level]}.discard`, ...placeOf(level, key), outcome: "succeeded",
      details: { level, id: key, version: stored.pending.version } });
  });
}

function withoutPending(value: Record<string, unknown>): Record<string, unknown> {
  const { pending: _pending, ...rest } = value;
  return rest;
}

/** Writes one level's column (or the fleet's settings row); null clears it. */
async function writeLevel(c: Queryable, level: AppLevel, key: string, value: unknown, by: string): Promise<void> {
  if (level === "fleet") {
    if (value === null) await c.query("DELETE FROM settings WHERE [key] = $1", [APPS_SETTING_KEY]);
    else await upsertSetting(c, APPS_SETTING_KEY, value, by);
    return;
  }
  const r = await c.query(`UPDATE ${TABLE[level]} SET ${APPS_COLUMN} = $2 WHERE id = $1 AND ${level === "cabinet" ? "status <> 'removed'" : "removed_at IS NULL"}`,
    [key, value === null ? null : JSON.stringify(value)]);
  if (r.rowCount !== 1) throw new Refused("not_found", 404, `no such ${level}`);
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

/** The stored form of a list that has been read, unchanged: the same version, time and author it was saved with. */
function storedValueOf(list: PendingList): { version: number; entries: ApprovedAppEntry[]; hash: string; setBy: string; setAt: string } {
  return { version: list.version, entries: list.entries.map(rawEntry), hash: list.hash, setBy: list.setBy, setAt: list.setAt };
}
