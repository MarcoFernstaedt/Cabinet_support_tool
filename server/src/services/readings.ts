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
    `SELECT operation, result_at AS [at] FROM (
       SELECT operation, result_at, ROW_NUMBER() OVER (PARTITION BY operation ORDER BY result_at DESC) AS rn FROM commands
        WHERE cabinet_id = $1 AND status = 'succeeded' AND result IS NOT NULL) x
      WHERE rn = 1 ORDER BY operation`, [cabinetId])).rows;
  return rows.filter(r => readOperations.has(r.operation)).map(r => ({ operation: r.operation, at: r.at.toISOString() }));
}

/** One stored answer, exactly as the cabinet gave it (it was checked against its output schema when it arrived). */
export async function latestReading(db: Queryable, cabinetId: string, operation: string): Promise<{ at: string; output: unknown } | null> {
  if (!readOperations.has(operation)) throw new Refused("not_found", 404, "no such read operation");
  // `output` is not one of the columns the data layer parses, so it comes back as JSON text.
  const row = (await db.query<{ at: Date; output: string | null }>(
    `SELECT TOP (1) result_at AS [at], JSON_QUERY(result, '$.output') AS output FROM commands
      WHERE cabinet_id = $1 AND operation = $2 AND status = 'succeeded' AND result IS NOT NULL ORDER BY result_at DESC`, [cabinetId, operation])).rows[0];
  return row && row.output !== null && row.output !== undefined ? { at: row.at.toISOString(), output: JSON.parse(row.output) as unknown } : null;
}

// ---- Fleet search -------------------------------------------------------------------------------------------------------------------

type Out = Record<string, any>;
interface Searchable {
  /** A T-SQL condition over the stored result `cm.result` (its `$.output`); $3 is the lower-case text. Constants only. */
  where: string;
  /** What matched, for the row: at most a few short lines. */
  found(output: Out, q: string): string[];
}
const has = (text: unknown, q: string) => typeof text === "string" && text.toLowerCase().includes(q);
const first = (items: string[]) => items.slice(0, 5);
/** One scalar of the stored answer, as text (JSON booleans come back as 'true' and 'false'). */
const OUT = (path: string): string => `JSON_VALUE(cm.result, '$.output.${path}')`;
/** The items of one array of the stored answer, one row each, with the named fields as text. */
const ITEMS = (path: string, fields: Record<string, string>, alias: string): string =>
  `OPENJSON(cm.result, '$.output.${path}') WITH (${Object.entries(fields).map(([column, field]) => `${column} nvarchar(max) '$.${field}'`).join(", ")}) ${alias}`;

/** The keywords of the two readings that are searched by a state rather than a name. */
export const KEYWORDS: Record<string, readonly string[]> = {
  "power.status": ["fast_startup", "usb_suspend"],
  "system.security": ["pending_restart", "defender_off", "bitlocker_off", "cert_expiring", "not_activated"],
  // system.identity is also searched by name (a domain, a workgroup or an administrator): text that is not one of these.
  "system.identity": ["workgroup", "auto_logon", "no_domain_controller"],
};

const KEYWORD_WHERE: Record<string, string> = {
  fast_startup: `${OUT("fastStartup")} = 'true'`,
  usb_suspend: `${OUT("usbSelectiveSuspend.pluggedIn")} = 'true'`,
  pending_restart: `${OUT("pendingReboot.pending")} = 'true'`,
  defender_off: `(${OUT("defender.enabled")} = 'false' OR ${OUT("defender.realTimeProtection")} = 'false')`,
  bitlocker_off: `EXISTS (SELECT 1 FROM ${ITEMS("bitlocker", { protection: "protection" }, "v")} WHERE v.protection = 'off')`,
  cert_expiring: `EXISTS (SELECT 1 FROM OPENJSON(cm.result, '$.output.certificates'))`,
  not_activated: `${OUT("activation.licensed")} = 'false'`,
  workgroup: `${OUT("joinType")} = 'workgroup'`,
  auto_logon: `${OUT("autoLogon.enabled")} = 'true'`,
  no_domain_controller: `${OUT("domainControllerFound")} = 'false'`,
};
const KEYWORD_FOUND: Record<string, (o: Out) => string[]> = {
  fast_startup: () => ["Fast Startup is on"],
  usb_suspend: () => ["USB selective suspend is on"],
  pending_restart: o => [`A restart is waiting: ${(o.pendingReboot?.reasons ?? []).join(", ") || "reason not given"}`],
  defender_off: o => [o.defender?.enabled === false ? "Defender is off" : "Real-time protection is off"],
  bitlocker_off: o => first((o.bitlocker ?? []).filter((v: Out) => v.protection === "off").map((v: Out) => `${v.volume} is not protected by BitLocker`)),
  cert_expiring: o => first((o.certificates ?? []).map((c: Out) => `${c.subject}: ${c.expired ? "expired" : `${c.daysLeft} days left`}`)),
  not_activated: o => [`Windows: ${o.activation?.status ?? "not activated"}`],
  workgroup: o => [`In a workgroup${o.name ? `: ${o.name}` : ""}, not a domain`],
  auto_logon: o => [`Signs in automatically${o.autoLogon?.userName ? ` as ${o.autoLogon.userName}` : ""}`],
  no_domain_controller: o => [`No domain controller found for ${o.name ?? "the domain"}`],
};

/** The readings searched by name; reading-search-text.ts keeps a search text for exactly these. */
export const searchableByName = (): string[] => Object.keys(NAMES);

const NAMES: Record<string, Searchable> = {
  "software.list": {
    where: `EXISTS (SELECT 1 FROM ${ITEMS("programs", { name: "name", publisher: "publisher" }, "p")} WHERE CHARINDEX($3, LOWER(p.name)) > 0 OR CHARINDEX($3, LOWER(COALESCE(p.publisher, ''))) > 0)
            OR EXISTS (SELECT 1 FROM ${ITEMS("hotfixes", { id: "id" }, "h")} WHERE CHARINDEX($3, LOWER(h.id)) > 0)`,
    found: (o, q) => first([...(o.programs ?? []).filter((p: Out) => has(p.name, q) || has(p.publisher, q)).map((p: Out) => `${p.name}${p.version ? ` ${p.version}` : ""}`),
      ...(o.hotfixes ?? []).filter((h: Out) => has(h.id, q)).map((h: Out) => `Update ${h.id}`)]),
  },
  "startup.list": {
    where: `EXISTS (SELECT 1 FROM ${ITEMS("startup", { name: "name", command: "command" }, "s")} WHERE CHARINDEX($3, LOWER(s.name)) > 0 OR CHARINDEX($3, LOWER(s.command)) > 0)
            OR EXISTS (SELECT 1 FROM ${ITEMS("tasks", { name: "name", path: "path" }, "t")} WHERE CHARINDEX($3, LOWER(t.name)) > 0 OR CHARINDEX($3, LOWER(t.path)) > 0)`,
    found: (o, q) => first([...(o.startup ?? []).filter((s: Out) => has(s.name, q) || has(s.command, q)).map((s: Out) => `Starts with Windows: ${s.name}`),
      ...(o.tasks ?? []).filter((t: Out) => has(t.name, q) || has(t.path, q)).map((t: Out) => `Task: ${t.path}${t.name}`)]),
  },
  "shares.list": {
    where: `EXISTS (SELECT 1 FROM ${ITEMS("shares", { name: "name", path: "path" }, "s")} WHERE CHARINDEX($3, LOWER(s.name)) > 0 OR CHARINDEX($3, LOWER(COALESCE(s.path, ''))) > 0)`,
    found: (o, q) => first((o.shares ?? []).filter((s: Out) => has(s.name, q) || has(s.path, q)).map((s: Out) => `Share ${s.name}${s.path ? ` → ${s.path}` : ""}`)),
  },
  "sessions.list": {
    where: `EXISTS (SELECT 1 FROM ${ITEMS("sessions", { account: "user" }, "s")} WHERE CHARINDEX($3, LOWER(s.account)) > 0)`,
    found: (o, q) => first((o.sessions ?? []).filter((s: Out) => has(s.user, q)).map((s: Out) => `${s.user} (${s.state}, ${s.type === "remote" ? "remote desktop" : "at the cabinet"})`)),
  },
  "system.hardware": {
    where: `CHARINDEX($3, LOWER(COALESCE(${OUT("model")}, ''))) > 0 OR CHARINDEX($3, LOWER(COALESCE(${OUT("manufacturer")}, ''))) > 0
            OR CHARINDEX($3, LOWER(COALESCE(${OUT("bios.version")}, ''))) > 0 OR CHARINDEX($3, LOWER(COALESCE(${OUT("bios.vendor")}, ''))) > 0
            OR CHARINDEX($3, LOWER(COALESCE(${OUT("cpu.model")}, ''))) > 0`,
    found: (o, q) => first([
      ...(has(o.model, q) || has(o.manufacturer, q) ? [`${o.manufacturer ?? ""} ${o.model ?? ""}`.trim()] : []),
      ...(has(o.bios?.version, q) || has(o.bios?.vendor, q) ? [`BIOS ${o.bios?.version ?? "?"}${o.bios?.date ? ` (${String(o.bios.date).slice(0, 10)})` : ""}`] : []),
      ...(has(o.cpu?.model, q) ? [`Processor ${o.cpu.model}`] : [])]),
  },
  "system.identity": {
    where: `CHARINDEX($3, LOWER(COALESCE(${OUT("name")}, ''))) > 0
            OR EXISTS (SELECT 1 FROM OPENJSON(cm.result, '$.output.localAdministrators.names') WITH (admin nvarchar(max) '$') a WHERE CHARINDEX($3, LOWER(a.admin)) > 0)`,
    found: (o, q) => first([
      ...(has(o.name, q) ? [`${o.joinType === "domain" ? "Domain" : o.joinType === "workgroup" ? "Workgroup" : "Joined to"} ${o.name}`] : []),
      ...(o.localAdministrators?.names ?? []).filter((n: unknown) => has(n, q)).map((n: string) => `Local administrator ${n}`)]),
  },
  "network.hosts": {
    where: `EXISTS (SELECT 1 FROM OPENJSON(cm.result, '$.output.entries') WITH (address nvarchar(max) '$.address', names nvarchar(max) '$.names' AS JSON) e
                    WHERE CHARINDEX($3, LOWER(e.address)) > 0 OR EXISTS (SELECT 1 FROM OPENJSON(e.names) n WHERE CHARINDEX($3, LOWER(n.value)) > 0))`,
    found: (o, q) => first((o.entries ?? []).filter((e: Out) => has(e.address, q) || (e.names ?? []).some((n: unknown) => has(n, q))).map((e: Out) => `${(e.names ?? []).join(", ")} → ${e.address}`)),
  },
  "dns.cache": {
    where: `EXISTS (SELECT 1 FROM ${ITEMS("entries", { entry_name: "name", entry_data: "data" }, "e")} WHERE CHARINDEX($3, LOWER(e.entry_name)) > 0 OR CHARINDEX($3, LOWER(e.entry_data)) > 0)`,
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
/**
 * How many fleet-wide searches may run at once, and how many may wait for their turn. A search walks the newest stored result of every
 * cabinet in the fleet, so an unbounded number of them at once is what makes the server slow for everyone; a search that cannot get a slot
 * in a moment is refused (429) rather than added to the load.
 */
export const SEARCH_CONCURRENCY = 2;
export const SEARCH_QUEUE = 4;
let searchesRunning = 0;
const searchWaiters: Array<() => void> = [];

function releaseSearchSlot(): void {
  searchesRunning -= 1;
  const next = searchWaiters.shift();
  if (next) { searchesRunning += 1; next(); }
}

async function searchSlot(): Promise<() => void> {
  if (searchesRunning < SEARCH_CONCURRENCY) { searchesRunning += 1; return releaseSearchSlot; }
  if (searchWaiters.length >= SEARCH_QUEUE) throw new Refused("busy", 429, "the fleet is already being searched; try again in a moment");
  await new Promise<void>(resolve => { searchWaiters.push(resolve); });
  return releaseSearchSlot;
}

export async function searchReadings(db: Queryable, operation: string, q: string, scope: { clientId?: string; siteId?: string }, limitMs?: number): Promise<SearchResult> {
  const started = Date.now();
  const left = () => (limitMs === undefined ? undefined : { timeoutMs: Math.max(1, limitMs - (Date.now() - started)) });
  const text = q.trim().toLowerCase();
  const allowed = KEYWORDS[operation];
  // A reading with a keyword list and no names takes only its keywords; one with both (system.identity) takes a keyword or a name.
  const keywords = allowed?.includes(text) ? allowed : undefined;
  if (allowed && !keywords && !NAMES[operation]) throw new Refused("unknown_keyword", 400, `search ${operation} by one of: ${allowed.join(", ")}`);
  if (!allowed && !NAMES[operation]) throw new Refused("not_searchable", 400, "that reading cannot be searched");
  // A name search reads the result's search text, its names lower case one per line, written when the result arrived (F21.R4,
  // decision-log D63): reading every cabinet's stored JSON apart took about 9 s at 10,000 cabinets. A result stored before the text
  // existed has none and is read as before. CHARINDEX takes the text as it is: no character in it is a pattern.
  const condition = keywords ? KEYWORD_WHERE[text]!
    : `(cm.search_text IS NOT NULL AND CHARINDEX(CAST($3 AS nvarchar(4000)) COLLATE Latin1_General_100_BIN2, cm.search_text) > 0) OR (cm.search_text IS NULL AND (${NAMES[operation]!.where}))`;
  const inScope = `k.status = 'active' AND (CAST($1 AS nvarchar(36)) IS NULL OR s.client_id = TRY_CAST($1 AS uniqueidentifier)) AND (CAST($2 AS nvarchar(36)) IS NULL OR s.id = TRY_CAST($2 AS uniqueidentifier))`;
  const params = [scope.clientId ?? null, scope.siteId ?? null, keywords ? "" : text, operation];
  /** The cabinets of the scope that have a stored result for this operation; the page and its counts are read from it together. */
  // Each cabinet's newest result is chosen from the index alone; only the chosen rows' text is read (it is kept out of the row).
  const latest = `latest AS (
       SELECT x.id FROM (
         SELECT cm.id, ROW_NUMBER() OVER (PARTITION BY cm.cabinet_id ORDER BY cm.result_at DESC) AS rn
           FROM commands cm JOIN cabinets k ON k.id = cm.cabinet_id JOIN sites s ON s.id = k.site_id
          WHERE cm.operation = $4 AND cm.status = 'succeeded' AND cm.result IS NOT NULL AND ${inScope}) x
        WHERE x.rn = 1)`;
  const released = await searchSlot();
  try {
    // `output` is not one of the columns the data layer parses, so it comes back as JSON text. The counts travel with the rows: the page
    // and what it was drawn from are read in one round trip, and neither re-reads the stored results a second time.
    const rows = (await db.query<{ id: string; name: string; role: string; site: string; client: string; demo: boolean; read_at: Date; output: string | null; cabinets_read: string; total: string }>(
      `WITH ${latest},
       counted AS (SELECT COUNT(*) AS cabinets_read FROM latest),
       inscope AS (SELECT COUNT(*) AS total FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE ${inScope})
     SELECT TOP (${MAX_MATCHES + 1}) k.id, k.name, k.role, s.name AS site, c.name AS client, c.demo, cm.result_at AS read_at, JSON_QUERY(cm.result, '$.output') AS output,
            (SELECT cabinets_read FROM counted) AS cabinets_read, (SELECT total FROM inscope) AS total
       FROM latest l JOIN commands cm ON cm.id = l.id JOIN cabinets k ON k.id = cm.cabinet_id JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
      WHERE (${condition}) ORDER BY c.name, s.name, k.name`, params, left())).rows;
    // Nothing matched, so no row carried the counts; they are asked for on their own (a search that finds nothing is the rare case).
    const counts = rows[0] ?? (await db.query<{ cabinets_read: string; total: string }>(
      `WITH ${latest.replace("$4", "$3")}
     SELECT (SELECT COUNT(*) FROM latest) AS cabinets_read, (SELECT COUNT(*) FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE ${inScope}) AS total`,
      [params[0], params[1], operation], left())).rows[0]!;
    const found = (o: Out) => keywords ? KEYWORD_FOUND[text]!(o) : NAMES[operation]!.found(o, text);
    return {
      operation, q: text,
      matches: rows.slice(0, MAX_MATCHES).map(r => ({ cabinetId: r.id, name: r.name, role: r.role, site: r.site, client: r.client, demo: r.demo, readAt: r.read_at.toISOString(), found: found(JSON.parse(r.output ?? "{}") as Out) })),
      cabinetsRead: Number(counts.cabinets_read), cabinetsInScope: Number(counts.total), truncated: rows.length > MAX_MATCHES,
    };
  } finally {
    released();
  }
}

// ---- Load samples -------------------------------------------------------------------------------------------------------------------

export interface HealthPoint {
  at: string; cpu: number; memory: number; diskFree: number;
  /** On a point older than 48 hours, which stands for a whole hour (its averages above, at the middle of the hour): the extremes in it. */
  cpuMax?: number; memoryMax?: number; diskFreeMin?: number;
}

/**
 * The samples of the last <hours> hours, oldest first. At most one every 15 minutes is stored, and after 48 hours they are rolled up to one
 * point per hour (health_hourly, maintenance.ts), so 14 days is under 550 points.
 */
export async function healthHistory(db: Queryable, cabinetId: string, hours: number): Promise<HealthPoint[]> {
  const rows = (await db.query<{ at: Date; cpu: number; memory: number; disk: number; cpu_max: number | null; memory_max: number | null; disk_min: number | null }>(
    `SELECT [at], cpu, memory, disk, cpu_max, memory_max, disk_min FROM (
       SELECT [at], CAST(cpu_percent AS int) AS cpu, CAST(memory_used_percent AS int) AS memory, CAST(disk_free_percent AS int) AS disk,
              CAST(NULL AS int) AS cpu_max, CAST(NULL AS int) AS memory_max, CAST(NULL AS int) AS disk_min
         FROM health_samples WHERE cabinet_id = $1 AND [at] >= DATEADD(hour, -$2, SYSUTCDATETIME())
       UNION ALL
       SELECT DATEADD(minute, 30, CAST([hour] AS datetime2(3))), cpu_avg, memory_avg, disk_free_avg, cpu_max, memory_max, disk_free_min
         FROM health_hourly WHERE cabinet_id = $1 AND [hour] >= DATEADD(hour, -$2, SYSUTCDATETIME())) x
     ORDER BY [at]`, [cabinetId, hours])).rows;
  return rows.map(r => ({ at: r.at.toISOString(), cpu: r.cpu, memory: r.memory, diskFree: r.disk,
    ...(r.cpu_max === null ? {} : { cpuMax: r.cpu_max, memoryMax: r.memory_max!, diskFreeMin: r.disk_min! }) }));
}
