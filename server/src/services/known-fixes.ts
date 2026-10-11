// Known fixes: when a person solves a problem the baseline cannot fix with a click, they save what fixed it. The platform keeps the
// solution with the environment it was seen in (the cabinet's role, agent, time zone, firewall and network as last read), and shows
// it whenever the same problem turns up again, beside how the new cabinet's environment compares. A problem is matched exactly: by a
// diagnosis finding's key, or by an issue type. Never by pattern. The environment is read here, never taken from the console.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { audit, safeJson, type Queryable } from "../db/db.js";
import { Refused } from "./errors.js";
import type { KnownFixCreate } from "../contracts.js";

export interface Environment {
  client: string; site: string; role: string; agentVersion: string | null; timeZone: string | null;
  firewall: { domain: boolean; private: boolean; public: boolean } | null;
  network: { addressing: "dhcp" | "static"; gateway: string | null; dnsServers: string[]; linkSpeedMbps: number | null; adapter: string | null; mtu: number | null } | null;
}

/** "obs-errors-12" and "obs-errors-3" are the same kind of finding: the key drops a trailing interface number. */
export function findingKey(id: string): string {
  const parts = id.split("-");
  const last = parts[parts.length - 1];
  return parts.length > 1 && last !== undefined && last.length > 0 && [...last].every(ch => ch >= "0" && ch <= "9") ? parts.slice(0, -1).join("-") : id;
}

interface AdapterReading { connected?: boolean; description?: string | null; name?: string; linkSpeedBps?: number | null; ipv4?: { dhcp?: boolean; gateways?: string[] }; dns?: { servers?: string[] }; details?: { mtu?: number | null } }

/** The cabinet's environment as the platform last saw it. */
export async function environmentOf(db: Queryable, cabinetId: string): Promise<Environment> {
  const k = (await db.query<{ role: string; agent_version: string | null; time_zone_id: string | null; firewall_profiles: Environment["firewall"]; site: string; client: string }>(
    `SELECT k.role, k.agent_version, k.time_zone_id, k.firewall_profiles, s.name AS site, c.name AS client
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id WHERE k.id = $1`, [cabinetId])).rows[0];
  if (!k) throw new Refused("not_found", 404, "no such cabinet");
  const adapters = (await db.query<{ a: unknown }>(
    "SELECT readings->'adapters' AS a FROM diagnoses WHERE cabinet_id = $1 AND state = 'done' AND readings IS NOT NULL ORDER BY finished_at DESC LIMIT 1", [cabinetId])).rows[0]?.a;
  const a = Array.isArray(adapters) ? (adapters as AdapterReading[]).find(x => x?.connected) : undefined;
  return { client: k.client, site: k.site, role: k.role, agentVersion: k.agent_version, timeZone: k.time_zone_id, firewall: k.firewall_profiles,
    network: a ? { addressing: a.ipv4?.dhcp ? "dhcp" : "static", gateway: a.ipv4?.gateways?.[0] ?? null, dnsServers: a.dns?.servers ?? [],
      linkSpeedMbps: typeof a.linkSpeedBps === "number" ? Math.round(a.linkSpeedBps / 1_000_000) : null, adapter: a.description ?? a.name ?? null, mtu: a.details?.mtu ?? null } : null };
}

type Row = { id: string; title: string; solution: string; finding_key: string | null; issue_type_id: string | null; environment: Environment; created_by_name: string;
  created_at: Date; seen_count: number; last_seen_at: Date | null; cabinet_name: string | null; issue_name: string | null };
const SELECT = `SELECT f.id, f.title, f.solution, f.finding_key, f.issue_type_id, f.environment, u.name AS created_by_name, f.created_at, f.seen_count, f.last_seen_at,
    k.name AS cabinet_name, t.name AS issue_name
  FROM known_fixes f JOIN users u ON u.id = f.created_by LEFT JOIN cabinets k ON k.id = f.cabinet_id LEFT JOIN issue_types t ON t.id = f.issue_type_id`;
const view = (r: Row) => ({ id: r.id, title: r.title, solution: r.solution, symptom: r.finding_key ? { kind: "finding" as const, key: r.finding_key } : { kind: "issue" as const, issueTypeId: r.issue_type_id!, issueName: r.issue_name },
  environment: r.environment, savedBy: r.created_by_name, savedAt: r.created_at.toISOString(), fromCabinet: r.cabinet_name, seenCount: r.seen_count, lastSeenAt: r.last_seen_at?.toISOString() ?? null });
export type KnownFixView = ReturnType<typeof view>;

export async function saveKnownFix(pool: pg.Pool, userId: string, b: KnownFixCreate): Promise<KnownFixView> {
  const env = await environmentOf(pool, b.cabinetId);
  const key = b.symptom.kind === "finding" ? b.symptom.key : null, issue = b.symptom.kind === "issue" ? b.symptom.issueTypeId : null;
  if (issue && (await pool.query("SELECT 1 FROM issue_types WHERE id = $1", [issue])).rowCount !== 1) throw new Refused("not_found", 404, "no such issue type");
  const id = randomUUID();
  await pool.query("INSERT INTO known_fixes (id, title, solution, finding_key, issue_type_id, environment, cabinet_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [id, b.title, b.solution, key, issue, safeJson(env), b.cabinetId, userId]);
  await audit(pool, { actorKind: "user", actorId: userId, action: "known_fix.save", targetKind: "cabinet", targetId: b.cabinetId, outcome: "succeeded", details: { id, title: b.title, symptom: b.symptom } });
  return view((await pool.query<Row>(`${SELECT} WHERE f.id = $1`, [id])).rows[0]!);
}

export async function removeKnownFix(pool: pg.Pool, userId: string, id: string): Promise<void> {
  const r = await pool.query("UPDATE known_fixes SET removed_at = now() WHERE id = $1 AND removed_at IS NULL", [id]);
  if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such known fix");
  await audit(pool, { actorKind: "user", actorId: userId, action: "known_fix.remove", targetKind: "known_fix", targetId: id, outcome: "succeeded" });
}

export async function listKnownFixes(db: Queryable, q: { findingKey?: string; issueTypeId?: string }) {
  const where = q.findingKey ? "AND f.finding_key = $1" : q.issueTypeId ? "AND f.issue_type_id = $1" : "";
  const args = q.findingKey ? [q.findingKey] : q.issueTypeId ? [q.issueTypeId] : [];
  return (await db.query<Row>(`${SELECT} WHERE f.removed_at IS NULL ${where} ORDER BY f.created_at DESC LIMIT 200`, args)).rows.map(view);
}

/** The fixes saved for each finding key, newest first; counts each as seen once for this diagnosis. */
export async function fixesForFindings(db: Queryable, findingIds: string[]): Promise<Record<string, KnownFixView[]>> {
  const keys = [...new Set(findingIds.map(findingKey))];
  if (keys.length === 0) return {};
  const rows = (await db.query<Row>(`${SELECT} WHERE f.removed_at IS NULL AND f.finding_key = ANY($1::text[]) ORDER BY f.created_at DESC`, [keys])).rows;
  const out: Record<string, KnownFixView[]> = {};
  for (const id of findingIds) { const m = rows.filter(r => r.finding_key === findingKey(id)).map(view); if (m.length) out[id] = m; }
  return out;
}

export async function markSeen(db: Queryable, ids: string[]): Promise<void> {
  if (ids.length) await db.query("UPDATE known_fixes SET seen_count = seen_count + 1, last_seen_at = now() WHERE id = ANY($1::uuid[])", [ids]);
}
