// Security alerts (docs/spec/05-server-spec.md "Security alerts"): raised to Admins as major
// alerts, kept apart from cabinet alerts because most concern people, not cabinets. Repeats of
// the same alert fold into one open alert with a count, so a flood stays one line.
import { isIPv4, isIPv6 } from "node:net";
import { audit, isUniqueViolation, notify, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { Refused } from "./errors.js";

export type SecurityKind = "ops_database" | "ops_disk" | "ops_backup" | "ops_errors" | "ops_shed" | "ops_migration" | "ops_ca" | "write_volume" | "failed_logins" | "failed_step_ups" | "new_location" | "new_device" | "audit_chain"
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
  // One open alert per signature: an open one gains an occurrence, otherwise a new one is added. The MERGE holds the key range, so two
  // raisers of the same signature at once cannot both insert; if the unique rule still refuses one, the second try finds the open alert.
  const upsert = () => db.query<{ id: string; created: boolean }>(
    `MERGE security_alerts WITH (HOLDLOCK) AS t
     USING (SELECT $1 AS kind, $2 AS signature, $3 AS title, $4 AS detail, CAST($5 AS uniqueidentifier) AS user_id, CAST($6 AS uniqueidentifier) AS cabinet_id) AS s
        ON t.signature = s.signature AND t.state = 'open'
      WHEN MATCHED THEN UPDATE SET occurrences = t.occurrences + 1, last_seen = SYSUTCDATETIME(), detail = s.detail, title = s.title
      WHEN NOT MATCHED THEN INSERT (kind, signature, title, detail, user_id, cabinet_id) VALUES (s.kind, s.signature, s.title, s.detail, s.user_id, s.cabinet_id)
      OUTPUT inserted.id, CAST(CASE WHEN $action = 'INSERT' THEN 1 ELSE 0 END AS bit) AS created;`,
    [a.kind, a.signature.slice(0, 256), a.title.slice(0, 256), safeJson(a.detail ?? {}), a.userId ?? null, a.cabinetId ?? null]);
  const r = (await upsert().catch(e => { if (!isUniqueViolation(e)) throw e; return upsert(); })).rows[0]!;
  // Every change to a security alert is auditworthy, not only the first: a repeat that overwrites the stored title and detail is a change
  // to security evidence, and the count it adds is what the alert shows. `added` says which of the two it was.
  await audit(db, { actorKind: "system", actorId: "security", action: "security.alert", targetKind: "security_alert", targetId: r.id, outcome: "succeeded",
    details: { kind: a.kind, title: a.title, userId: a.userId ?? null, cabinetId: a.cabinetId ?? null, added: r.created } });
  // The payload column holds 450 characters; a long title is left out rather than cutting the JSON in half.
  const payload = { id: r.id, created: r.created, kind: a.kind, title: a.title.slice(0, 256) };
  await notify(db, "security_alerts", JSON.stringify(payload).length <= 450 ? JSON.stringify(payload) : JSON.stringify({ id: r.id, created: r.created, kind: a.kind }));
  return r;
}

/** Raises a security alert in its own transaction; for places that must not fail because of it (refused connections, sign-in). */
export async function raiseSecurityAlertNow(pool: Pool, a: SecurityAlertInput): Promise<void> {
  await transaction(pool, c => raiseSecurityAlert(c, a)).catch(() => undefined);
}

export async function listSecurityAlerts(db: Queryable, state: "open" | "resolved" | "all") {
  const rows = (await db.query<{ id: string; kind: SecurityKind; title: string; detail: Record<string, unknown>; state: string; occurrences: number;
    first_seen: Date; last_seen: Date; user_id: string | null; user_name: string | null; cabinet_id: string | null; cabinet_name: string | null;
    resolved_by_name: string | null; resolved_at: Date | null; resolution: string | null }>(
    `SELECT TOP (500) a.id, a.kind, a.title, a.detail, a.state, a.occurrences, a.first_seen, a.last_seen, a.user_id, u.name AS user_name,
            a.cabinet_id, k.name AS cabinet_name, r.name AS resolved_by_name, a.resolved_at, a.resolution
       FROM security_alerts a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN cabinets k ON k.id = a.cabinet_id LEFT JOIN users r ON r.id = a.resolved_by
      WHERE $1 = 'all' OR a.state = $1 ORDER BY CASE WHEN a.state = 'open' THEN 0 ELSE 1 END, a.last_seen DESC`, [state])).rows;
  return rows.map(r => ({
    id: r.id, kind: r.kind, title: r.title, detail: r.detail, state: r.state, occurrences: r.occurrences, firstSeen: r.first_seen.toISOString(),
    lastSeen: r.last_seen.toISOString(), user: r.user_id ? { id: r.user_id, name: r.user_name } : null,
    cabinet: r.cabinet_id ? { id: r.cabinet_id, name: r.cabinet_name } : null,
    resolvedBy: r.resolved_by_name, resolvedAt: r.resolved_at?.toISOString() ?? null, resolution: r.resolution,
  }));
}

export async function openSecurityAlertCount(db: Queryable): Promise<number> {
  return Number((await db.query<{ n: string }>("SELECT COUNT(*) AS n FROM security_alerts WHERE state = 'open'")).rows[0]!.n);
}

export async function resolveSecurityAlert(pool: Pool, adminId: string, id: string, note: string, stepUpToken: string): Promise<void> {
  await transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "security_alert.resolve", id);
    const r = await c.query("UPDATE security_alerts SET state = 'resolved', resolved_by = $2, resolved_at = SYSUTCDATETIME(), resolution = $3 WHERE id = $1 AND state = 'open'",
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
