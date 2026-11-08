// New kinds of blue screen, clustered (F17, decision-log D52). A blue-screen alert is one per cabinet whatever the kind, so the fleet
// pattern for blue screens holds every kind at once: a new failure that starts on a few cabinets after a driver or update reads as more of
// the usual crashes. Once an hour this pass reads the crashes the platform alerted on, groups them by crash signature (D26), and opens a
// major fleet pattern for each kind that is new to the fleet (no crash of that kind before the last 7 days, within the 90 days events are
// kept) and has reached 2 or more cabinets: one cabinet's new crash is already that cabinet's alert. The pattern is keyed crash:<signature>,
// counted up while it spreads, and resolved by this pass once none of its cabinets still has a blue-screen alert open: the minute sweep
// cannot see a kind on an alert, so it leaves these keys to this pass. Demo cabinets are left out. Nothing here runs anything on a cabinet.
import { audit, isUniqueViolation, notify, type Pool, type Queryable } from "../db/db.js";
import { oneCrashEach, type Crash, type CrashSignature } from "./crash-signatures.js";
import { FLEET_CHANNEL, ring } from "./fleet-patterns.js";
import { ISSUE } from "./rules.js";
import { platformSettings } from "./settings.js";

export const CRASH_KEY_PREFIX = "crash:";
/** A kind is new while its first crash in the fleet is at most this old. */
export const NEW_KIND_DAYS = 7;
/** How far back a kind is looked for: the events are kept 90 days, and crash events stay whole. */
export const LOOK_BACK_DAYS = 90;
/** Cabinets a new kind must reach to be a cluster; one cabinet's crash is its own alert already. */
export const CLUSTER_CABINETS = 2;
/** At most this many patterns open in one pass, so a flood of malformed messages cannot flood the list. */
export const MAX_OPEN_PER_PASS = 20;
const DAY = 86_400_000;

interface Kind { sig: CrashSignature; crashes: Crash[]; cabinets: Set<string>; first: Date; last: Date }

/** The crashes the platform alerted on since `from`, on active real cabinets, one per crash, grouped by kind. */
async function crashKinds(db: Queryable, from: Date): Promise<Map<string, Kind>> {
  const rows = (await db.query<{ cabinet_id: string; occurred_at: Date; message: string | null; src: string }>(
    `SELECT e.cabinet_id, e.occurred_at, LOWER(JSON_VALUE(e.source, '$.source')) AS src,
            (SELECT j.message FROM OPENJSON(e.detail) WITH (message nvarchar(max) '$.message') j) AS message
       FROM events e JOIN alerts a ON a.id = e.alert_id JOIN cabinets k ON k.id = e.cabinet_id
      WHERE a.issue_type_id = $1 AND e.occurred_at >= $2 AND k.status = 'active' AND k.demo_scenario IS NULL
        AND TRY_CAST(JSON_VALUE(e.source, '$.eventId') AS int) = 1001
      ORDER BY e.cabinet_id, e.occurred_at`, [ISSUE.crash, from])).rows;
  const kinds = new Map<string, Kind>();
  for (const c of oneCrashEach(rows)) {
    const k = kinds.get(c.sig.key) ?? kinds.set(c.sig.key, { sig: c.sig, crashes: [], cabinets: new Set(), first: c.at, last: c.at }).get(c.sig.key)!;
    k.crashes.push(c); k.cabinets.add(c.cabinetId);
    if (c.at < k.first) k.first = c.at;
    if (c.at > k.last) k.last = c.at;
  }
  return kinds;
}

/** The cabinets that had a crash of this kind (signature key) in the look-back window: the report's affected cabinets. */
export async function cabinetsOfKind(db: Queryable, key: string, now = new Date()): Promise<string[]> {
  return [...((await crashKinds(db, new Date(now.getTime() - LOOK_BACK_DAYS * DAY))).get(key)?.cabinets ?? [])];
}

export const crashTitle = (k: Pick<Kind, "sig">) => `Fleet pattern: New kind of blue screen: ${k.sig.title}`.slice(0, 300);

/** The hourly pass: opens a pattern for each new kind on 2 or more cabinets, counts open ones up, and resolves the ones gone. */
export async function clusterNewCrashKinds(pool: Pool, now = new Date()): Promise<{ opened: number; updated: number; resolved: number }> {
  const kinds = await crashKinds(pool, new Date(now.getTime() - LOOK_BACK_DAYS * DAY));
  const open = new Map((await pool.query<{ id: string; pattern_key: string }>(
    "SELECT id, pattern_key FROM fleet_patterns WHERE resolved_at IS NULL AND LEFT(pattern_key, 6) = $1", [CRASH_KEY_PREFIX])).rows
    .map(r => [r.pattern_key, r.id.toLowerCase()]));
  // Cabinets with a blue-screen alert still open: a kind is a problem only while one of its cabinets is among them.
  const crashing = new Set((await pool.query<{ cabinet_id: string }>(
    "SELECT DISTINCT cabinet_id FROM alerts WHERE issue_type_id = $1 AND state <> 'resolved'", [ISSUE.crash])).rows.map(r => r.cabinet_id.toLowerCase()));
  const ids = [...new Set([...kinds.values()].flatMap(k => [...k.cabinets]))];
  const where = new Map((await pool.query<{ id: string; site_id: string; client_id: string }>(
    `SELECT k.id, k.site_id, s.client_id FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))`,
    [JSON.stringify(ids)])).rows.map(r => [r.id.toLowerCase(), r]));
  const reach = (k: Kind) => {
    const at = [...k.cabinets].map(id => where.get(id)).filter(x => x !== undefined);
    return { clients: new Set(at.map(x => x.client_id.toLowerCase())).size, sites: new Set(at.map(x => x.site_id.toLowerCase())).size, cabinets: k.cabinets.size, occurrences: k.crashes.length };
  };
  const minorSites = (await platformSettings(pool)).fleetMinorAlarmSites;
  let opened = 0, updated = 0;
  const newSince = now.getTime() - NEW_KIND_DAYS * DAY;
  // Widest first, so the cap keeps the ones reaching most cabinets.
  for (const k of [...kinds.values()].sort((a, b) => b.cabinets.size - a.cabinets.size || a.sig.key.localeCompare(b.sig.key))) {
    const key = `${CRASH_KEY_PREFIX}${k.sig.key}`, r = reach(k);
    if (open.has(key)) {
      // Counts only grow while it is open, as for every pattern.
      await pool.query(`UPDATE fleet_patterns SET clients = CASE WHEN $2 > clients THEN $2 ELSE clients END, sites = CASE WHEN $3 > sites THEN $3 ELSE sites END,
          cabinets = CASE WHEN $4 > cabinets THEN $4 ELSE cabinets END, occurrences = CASE WHEN $5 > occurrences THEN $5 ELSE occurrences END,
          last_seen = CASE WHEN $6 > last_seen THEN $6 ELSE last_seen END WHERE pattern_key = $1 AND resolved_at IS NULL`,
        [key, r.clients, r.sites, r.cabinets, r.occurrences, k.last]);
      updated++;
      continue;
    }
    if (k.first.getTime() < newSince || k.cabinets.size < CLUSTER_CABINETS || opened >= MAX_OPEN_PER_PASS) continue;
    if (![...k.cabinets].some(id => crashing.has(id))) continue; // every one of them has recovered
    try {
      const row = await pool.query<{ id: string }>(`INSERT INTO fleet_patterns (pattern_key, issue_type_id, title, severity, clients, sites, cabinets, occurrences, first_seen, last_seen)
        OUTPUT inserted.id VALUES ($1, $2, $3, 'major', $4, $5, $6, $7, $8, $9)`,
        [key, ISSUE.crash, crashTitle(k), r.clients, r.sites, r.cabinets, r.occurrences, k.first, k.last]);
      const id = row.rows[0]!.id.toLowerCase();
      await audit(pool, { actorKind: "system", actorId: "fleet-patterns", action: "fleet_pattern.open", targetKind: "fleet_pattern", targetId: id,
        outcome: "succeeded", details: { key, newKind: { signature: k.sig.key, firstSeen: k.first.toISOString() }, sites: r.sites, cabinets: r.cabinets, clients: r.clients, severity: "major" } });
      await ring(pool, key, minorSites);
      await notify(pool, FLEET_CHANNEL, `${id} opened`);
      opened++;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  // Resolved: none of the kind's cabinets still has a blue-screen alert open (or no crash of the kind is left in the window).
  let resolved = 0;
  for (const [key, id] of open) {
    const k = kinds.get(key.slice(CRASH_KEY_PREFIX.length));
    if (k && [...k.cabinets].some(c => crashing.has(c))) continue;
    const done = await pool.query("UPDATE fleet_patterns SET resolved_at = SYSUTCDATETIME() WHERE id = $1 AND resolved_at IS NULL", [id]);
    if ((done.rowCount ?? 0) === 0) continue;
    await audit(pool, { actorKind: "system", actorId: "fleet-patterns", action: "fleet_pattern.resolve", targetKind: "fleet_pattern", targetId: id, outcome: "succeeded", details: {} });
    await notify(pool, FLEET_CHANNEL, `${id} resolved`);
    resolved++;
  }
  return { opened, updated, resolved };
}
