// What the platform already knows from earlier reads: the latest stored answer of each read per cabinet ("last known", also for a cabinet
// that is offline now), a search across the fleet over those answers, and the load samples from heartbeats. Nothing here asks a cabinet
// anything. Searches match plain text as a part of a name; every predicate is a constant in this file and the text is only a parameter.
import { catalog } from "../contracts.js";
import type { Queryable } from "../db/db.js";
import { Refused } from "./errors.js";

export interface LatestReading { operation: string; at: string }

/** Reads whose content is audited when it is opened (event entries) or chosen by the person asking (event queries, directory listings) are never replayed from storage. */
const NOT_STORED = new Set<string>(["eventlog.query", "eventlog.get", "files.list", "disk.folders"]);
const readOperations = new Set<string>([...catalog.values()].filter(e => e.kind === "read" && !NOT_STORED.has(e.name)).map(e => e.name));

/** The latest stored successful answer of every read for one cabinet. */
export async function latestReadings(db: Queryable, cabinetId: string): Promise<LatestReading[]> {
  const rows = (await db.query<{ operation: string; at: Date }>(
    `SELECT DISTINCT ON (operation) operation, result_at AS at FROM commands
      WHERE cabinet_id = $1 AND status = 'succeeded' AND result IS NOT NULL ORDER BY operation, result_at DESC`, [cabinetId])).rows;
  return rows.filter(r => readOperations.has(r.operation)).map(r => ({ operation: r.operation, at: r.at.toISOString() }));
}

/** One stored answer, exactly as the cabinet gave it (it was checked against its output schema when it arrived). */
export async function latestReading(db: Queryable, cabinetId: string, operation: string): Promise<{ at: string; output: unknown } | null> {
  if (!readOperations.has(operation)) throw new Refused("not_found", 404, "no such read operation");
  const row = (await db.query<{ at: Date; output: unknown }>(
    `SELECT result_at AS at, result->'output' AS output FROM commands
      WHERE cabinet_id = $1 AND operation = $2 AND status = 'succeeded' AND result IS NOT NULL ORDER BY result_at DESC LIMIT 1`, [cabinetId, operation])).rows[0];
  return row && row.output !== null && row.output !== undefined ? { at: row.at.toISOString(), output: row.output } : null;
}

// ---- Fleet search -------------------------------------------------------------------------------------------------------------------

type Out = Record<string, any>;
interface Searchable {
  /** A SQL condition over the stored result `cm.result->'output'`; $3 is the lower-case text. Constants only. */
  where: string;
  /** What matched, for the row: at most a few short lines. */
  found(output: Out, q: string): string[];
}
const has = (text: unknown, q: string) => typeof text === "string" && text.toLowerCase().includes(q);
const first = (items: string[]) => items.slice(0, 5);
const OUT = "cm.result->'output'";

/** The keywords of the two readings that are searched by a state rather than a name. */
export const KEYWORDS: Record<string, readonly string[]> = {
  "power.status": ["fast_startup", "usb_suspend"],
  "system.security": ["pending_restart", "defender_off", "bitlocker_off", "cert_expiring", "not_activated"],
};

const KEYWORD_WHERE: Record<string, string> = {
  fast_startup: `${OUT}->>'fastStartup' = 'true'`,
  usb_suspend: `${OUT}->'usbSelectiveSuspend'->>'pluggedIn' = 'true'`,
  pending_restart: `${OUT}->'pendingReboot'->>'pending' = 'true'`,
  defender_off: `(${OUT}->'defender'->>'enabled' = 'false' OR ${OUT}->'defender'->>'realTimeProtection' = 'false')`,
  bitlocker_off: `EXISTS (SELECT 1 FROM jsonb_array_elements(${OUT}->'bitlocker') v WHERE v->>'protection' = 'off')`,
  cert_expiring: `jsonb_array_length(${OUT}->'certificates') > 0`,
  not_activated: `${OUT}->'activation'->>'licensed' = 'false'`,
};
const KEYWORD_FOUND: Record<string, (o: Out) => string[]> = {
  fast_startup: () => ["Fast Startup is on"],
  usb_suspend: () => ["USB selective suspend is on"],
  pending_restart: o => [`A restart is waiting: ${(o.pendingReboot?.reasons ?? []).join(", ") || "reason not given"}`],
  defender_off: o => [o.defender?.enabled === false ? "Defender is off" : "Real-time protection is off"],
  bitlocker_off: o => first((o.bitlocker ?? []).filter((v: Out) => v.protection === "off").map((v: Out) => `${v.volume} is not protected by BitLocker`)),
  cert_expiring: o => first((o.certificates ?? []).map((c: Out) => `${c.subject}: ${c.expired ? "expired" : `${c.daysLeft} days left`}`)),
  not_activated: o => [`Windows: ${o.activation?.status ?? "not activated"}`],
};

const NAMES: Record<string, Searchable> = {
  "software.list": {
    where: `EXISTS (SELECT 1 FROM jsonb_array_elements(${OUT}->'programs') p WHERE strpos(lower(p->>'name'), $3) > 0 OR strpos(lower(coalesce(p->>'publisher', '')), $3) > 0)
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(${OUT}->'hotfixes') h WHERE strpos(lower(h->>'id'), $3) > 0)`,
    found: (o, q) => first([...(o.programs ?? []).filter((p: Out) => has(p.name, q) || has(p.publisher, q)).map((p: Out) => `${p.name}${p.version ? ` ${p.version}` : ""}`),
      ...(o.hotfixes ?? []).filter((h: Out) => has(h.id, q)).map((h: Out) => `Update ${h.id}`)]),
  },
  "startup.list": {
    where: `EXISTS (SELECT 1 FROM jsonb_array_elements(${OUT}->'startup') s WHERE strpos(lower(s->>'name'), $3) > 0 OR strpos(lower(s->>'command'), $3) > 0)
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(${OUT}->'tasks') t WHERE strpos(lower(t->>'name'), $3) > 0 OR strpos(lower(t->>'path'), $3) > 0)`,
    found: (o, q) => first([...(o.startup ?? []).filter((s: Out) => has(s.name, q) || has(s.command, q)).map((s: Out) => `Starts with Windows: ${s.name}`),
      ...(o.tasks ?? []).filter((t: Out) => has(t.name, q) || has(t.path, q)).map((t: Out) => `Task: ${t.path}${t.name}`)]),
  },
  "shares.list": {
    where: `EXISTS (SELECT 1 FROM jsonb_array_elements(${OUT}->'shares') s WHERE strpos(lower(s->>'name'), $3) > 0 OR strpos(lower(coalesce(s->>'path', '')), $3) > 0)`,
    found: (o, q) => first((o.shares ?? []).filter((s: Out) => has(s.name, q) || has(s.path, q)).map((s: Out) => `Share ${s.name}${s.path ? ` → ${s.path}` : ""}`)),
  },
  "sessions.list": {
    where: `EXISTS (SELECT 1 FROM jsonb_array_elements(${OUT}->'sessions') s WHERE strpos(lower(s->>'user'), $3) > 0)`,
    found: (o, q) => first((o.sessions ?? []).filter((s: Out) => has(s.user, q)).map((s: Out) => `${s.user} (${s.state}, ${s.type === "remote" ? "remote desktop" : "at the cabinet"})`)),
  },
  "dns.cache": {
    where: `EXISTS (SELECT 1 FROM jsonb_array_elements(${OUT}->'entries') e WHERE strpos(lower(e->>'name'), $3) > 0 OR strpos(lower(e->>'data'), $3) > 0)`,
    found: (o, q) => first((o.entries ?? []).filter((e: Out) => has(e.name, q) || has(e.data, q)).map((e: Out) => `${e.name} → ${e.data}`)),
  },
};

export interface SearchMatch { cabinetId: string; name: string; role: string; site: string; client: string; demo: boolean; readAt: string; found: string[] }
export interface SearchResult { operation: string; q: string; matches: SearchMatch[]; cabinetsRead: number; cabinetsInScope: number; truncated: boolean }

const MAX_MATCHES = 200;

/**
 * The cabinets whose latest stored reading of one kind matches. Only cabinets that have been read are searched, and the answer says how many
 * of those in scope that is, so "no match" is never mistaken for "no cabinet has it".
 */
export async function searchReadings(db: Queryable, operation: string, q: string, scope: { clientId?: string; siteId?: string }): Promise<SearchResult> {
  const keywords = KEYWORDS[operation];
  const text = q.trim().toLowerCase();
  if (keywords) {
    if (!keywords.includes(text)) throw new Refused("unknown_keyword", 400, `search ${operation} by one of: ${keywords.join(", ")}`);
  } else if (!NAMES[operation]) throw new Refused("not_searchable", 400, "that reading cannot be searched");
  const condition = keywords ? KEYWORD_WHERE[text]! : NAMES[operation]!.where;
  const inScope = `k.status = 'active' AND ($1::uuid IS NULL OR s.client_id = $1) AND ($2::uuid IS NULL OR s.id = $2)`;
  const params = [scope.clientId ?? null, scope.siteId ?? null, keywords ? "" : text, operation];
  const rows = (await db.query<{ id: string; name: string; role: string; site: string; client: string; demo: boolean; read_at: Date; output: Out }>(
    `WITH latest AS (
       SELECT DISTINCT ON (cm.cabinet_id) cm.cabinet_id, cm.result_at, cm.result
         FROM commands cm JOIN cabinets k ON k.id = cm.cabinet_id JOIN sites s ON s.id = k.site_id
        WHERE cm.operation = $4 AND cm.status = 'succeeded' AND cm.result IS NOT NULL AND ${inScope}
        ORDER BY cm.cabinet_id, cm.result_at DESC)
     SELECT k.id, k.name, k.role, s.name AS site, c.name AS client, c.demo, cm.result_at AS read_at, cm.result->'output' AS output
       FROM latest cm JOIN cabinets k ON k.id = cm.cabinet_id JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
      WHERE $3::text IS NOT NULL AND (${condition}) ORDER BY c.name, s.name, k.name LIMIT ${MAX_MATCHES + 1}`, params)).rows;
  const counts = (await db.query<{ read: string; total: string }>(
    `SELECT count(DISTINCT cm.cabinet_id) AS read, (SELECT count(*) FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE ${inScope}) AS total
       FROM commands cm JOIN cabinets k ON k.id = cm.cabinet_id JOIN sites s ON s.id = k.site_id
      WHERE cm.operation = $3 AND cm.status = 'succeeded' AND cm.result IS NOT NULL AND ${inScope}`, [params[0], params[1], operation])).rows[0]!;
  const found = (o: Out) => keywords ? KEYWORD_FOUND[text]!(o) : NAMES[operation]!.found(o, text);
  return {
    operation, q: text,
    matches: rows.slice(0, MAX_MATCHES).map(r => ({ cabinetId: r.id, name: r.name, role: r.role, site: r.site, client: r.client, demo: r.demo, readAt: r.read_at.toISOString(), found: found(r.output) })),
    cabinetsRead: Number(counts.read), cabinetsInScope: Number(counts.total), truncated: rows.length > MAX_MATCHES,
  };
}

// ---- Load samples -------------------------------------------------------------------------------------------------------------------

export interface HealthPoint { at: string; cpu: number; memory: number; diskFree: number }

/** The samples of the last <hours> hours, oldest first. At most one every 15 minutes is stored, so 14 days is under 1,400 points. */
export async function healthHistory(db: Queryable, cabinetId: string, hours: number): Promise<HealthPoint[]> {
  const rows = (await db.query<{ at: Date; cpu: number; memory: number; disk: number }>(
    `SELECT at, cpu_percent AS cpu, memory_used_percent AS memory, disk_free_percent AS disk FROM health_samples
      WHERE cabinet_id = $1 AND at >= now() - make_interval(hours => $2) ORDER BY at`, [cabinetId, hours])).rows;
  return rows.map(r => ({ at: r.at.toISOString(), cpu: r.cpu, memory: r.memory, diskFree: r.disk }));
}

/** Stores one sample from a heartbeat unless one was stored in the last 15 minutes. */
export async function recordHealth(db: Queryable, cabinetId: string, h: { cpuPercent: number; memoryUsedPercent: number; diskFreePercent: number }): Promise<void> {
  await db.query(
    `INSERT INTO health_samples (cabinet_id, at, cpu_percent, memory_used_percent, disk_free_percent)
     SELECT $1, now(), $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM health_samples WHERE cabinet_id = $1 AND at > now() - interval '15 minutes')`,
    [cabinetId, h.cpuPercent, h.memoryUsedPercent, h.diskFreePercent]);
}
