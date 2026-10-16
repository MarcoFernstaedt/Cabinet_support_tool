// Security alerts (docs/spec/05-server-spec.md "Security alerts"): raised to Admins as major
// alerts, kept apart from cabinet alerts because most concern people, not cabinets. Repeats of
// the same alert fold into one open alert with a count, so a flood stays one line.
import { isIPv4, isIPv6 } from "node:net";
import type pg from "pg";
import { audit, safeJson, transaction, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { Refused } from "./errors.js";

export type SecurityKind = "write_volume" | "failed_logins" | "failed_step_ups" | "new_location" | "new_device" | "audit_chain"
  | "agent_self_check" | "package_refused" | "signature_failure" | "certificate";

export interface SecurityAlertInput {
  kind: SecurityKind;
  /** What folds repeats together: one open alert per signature. */
  signature: string;
  title: string;
  detail?: Record<string, unknown>;
  userId?: string | null;
  cabinetId?: string | null;
}

/** Raises (or adds an occurrence to) a security alert, in the caller's transaction, and wakes the Admins' live streams. */
export async function raiseSecurityAlert(db: Queryable, a: SecurityAlertInput): Promise<{ id: string; created: boolean }> {
  const r = (await db.query<{ id: string; created: boolean }>(
    `INSERT INTO security_alerts (kind, signature, title, detail, user_id, cabinet_id) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (signature) WHERE state = 'open'
       DO UPDATE SET occurrences = security_alerts.occurrences + 1, last_seen = now(), detail = EXCLUDED.detail, title = EXCLUDED.title
     RETURNING id, (xmax = 0) AS created`,
    [a.kind, a.signature.slice(0, 256), a.title.slice(0, 256), safeJson(a.detail ?? {}), a.userId ?? null, a.cabinetId ?? null])).rows[0]!;
  if (r.created)
    await audit(db, { actorKind: "system", actorId: "security", action: "security.alert", targetKind: "security_alert", targetId: r.id, outcome: "succeeded",
      details: { kind: a.kind, title: a.title, userId: a.userId ?? null, cabinetId: a.cabinetId ?? null } });
  await db.query("SELECT pg_notify('security_alerts', $1)", [JSON.stringify({ id: r.id, created: r.created, kind: a.kind, title: a.title.slice(0, 256) })]);
  return r;
}

/** Raises a security alert in its own transaction; for places that must not fail because of it (refused connections, sign-in). */
export async function raiseSecurityAlertNow(pool: pg.Pool, a: SecurityAlertInput): Promise<void> {
  await transaction(pool, c => raiseSecurityAlert(c, a)).catch(() => undefined);
}

export async function listSecurityAlerts(db: Queryable, state: "open" | "resolved" | "all") {
  const rows = (await db.query<{ id: string; kind: SecurityKind; title: string; detail: Record<string, unknown>; state: string; occurrences: number;
    first_seen: Date; last_seen: Date; user_id: string | null; user_name: string | null; cabinet_id: string | null; cabinet_name: string | null;
    resolved_by_name: string | null; resolved_at: Date | null; resolution: string | null }>(
    `SELECT a.id, a.kind, a.title, a.detail, a.state, a.occurrences, a.first_seen, a.last_seen, a.user_id, u.name AS user_name,
            a.cabinet_id, k.name AS cabinet_name, r.name AS resolved_by_name, a.resolved_at, a.resolution
       FROM security_alerts a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN cabinets k ON k.id = a.cabinet_id LEFT JOIN users r ON r.id = a.resolved_by
      WHERE $1 = 'all' OR a.state = $1 ORDER BY a.state = 'open' DESC, a.last_seen DESC LIMIT 500`, [state])).rows;
  return rows.map(r => ({
    id: r.id, kind: r.kind, title: r.title, detail: r.detail, state: r.state, occurrences: r.occurrences, firstSeen: r.first_seen.toISOString(),
    lastSeen: r.last_seen.toISOString(), user: r.user_id ? { id: r.user_id, name: r.user_name } : null,
    cabinet: r.cabinet_id ? { id: r.cabinet_id, name: r.cabinet_name } : null,
    resolvedBy: r.resolved_by_name, resolvedAt: r.resolved_at?.toISOString() ?? null, resolution: r.resolution,
  }));
}

export async function openSecurityAlertCount(db: Queryable): Promise<number> {
  return Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM security_alerts WHERE state = 'open'")).rows[0]!.n);
}

export async function resolveSecurityAlert(pool: pg.Pool, adminId: string, id: string, note: string, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "security_alert.resolve", id);
    const r = await c.query("UPDATE security_alerts SET state = 'resolved', resolved_by = $2, resolved_at = now(), resolution = $3 WHERE id = $1 AND state = 'open'",
      [id, adminId, note]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such open security alert");
    await audit(c, { actorKind: "user", actorId: adminId, action: "security_alert.resolve", targetKind: "security_alert", targetId: id, outcome: "succeeded",
      details: { note } });
  });
}

/**
 * The network an address belongs to, for "a sign-in from a network location the account has not used before":
 * an IPv4 /24 or an IPv6 /64, so a changing address on the same network is not new. Unknown forms count as themselves.
 */
export function networkOf(address: string): string {
  const a = address.startsWith("::ffff:") && isIPv4(address.slice(7)) ? address.slice(7) : address;
  if (isIPv4(a)) return a.split(".").slice(0, 3).join(".") + ".0/24";
  if (isIPv6(a)) {
    const [head, tail = ""] = a.split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const groups = a.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
    return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(":") + "::/64";
  }
  return a.slice(0, 64);
}
