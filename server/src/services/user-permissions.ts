import { randomUUID } from "node:crypto";
import { audit, type Queryable, type Tx } from "../db/db.js";
import { isOperationName } from "../contracts.js";
import { Refused } from "./errors.js";

export function validatePermissionScope(kind: string, id: string | null): void {
  if (!(kind === "fleet" ? id === null : ["site", "cabinet"].includes(kind) && typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))
    throw new Refused("invalid_scope", 400, "a fleet, site or cabinet scope is required");
}

/** HOLDLOCK keeps a grant from being revoked between this check and the transaction's action. */
export async function requireCabinetPermission(db: Queryable, userId: string, cabinetId: string, permission: string): Promise<void> {
  const found = await db.query(`SELECT TOP (1) p.id FROM user_permissions p WITH (HOLDLOCK)
    JOIN users u ON u.id = p.user_id AND u.status = 'active'
    JOIN cabinets c ON c.id = $2 AND c.status = 'active'
    WHERE p.user_id = $1 AND p.permission = $3 AND p.removed_at IS NULL AND
      (p.scope_kind = 'fleet' OR (p.scope_kind = 'site' AND p.scope_id = c.site_id) OR
       (p.scope_kind = 'cabinet' AND p.scope_id = c.id))`, [userId, cabinetId, permission]);
  if (!found.rows.length) throw new Refused("permission_required", 403, "a matching permission grant is required");
}

/** Caller authenticates an Admin and consumes step-up in this same transaction. */
export async function grantPermission(tx: Tx, actorId: string, userId: string, permission: string, scopeKind: string, scopeId: string | null): Promise<string> {
  validatePermissionScope(scopeKind, scopeId);
  if (!isOperationName(permission)) throw new Refused("invalid_permission", 400, "permission must name a catalog operation");
  if (scopeKind !== "fleet") {
    const table = scopeKind === "site" ? "sites" : "cabinets";
    if (!(await tx.query(`SELECT id FROM ${table} WHERE id = $1`, [scopeId])).rows.length)
      throw new Refused("not_found", 404, "no such scope");
  }
  const id = randomUUID();
  await tx.query(`INSERT INTO user_permissions (id, user_id, permission, scope_kind, scope_id, granted_by)
    VALUES ($1, $2, $3, $4, $5, $6)`, [id, userId, permission, scopeKind, scopeId, actorId]);
  await audit(tx, { actorKind: "user", actorId, action: "permission.grant", targetKind: "user", targetId: userId,
    outcome: "succeeded", details: { permissionId: id, permission, scopeKind, scopeId } });
  return id;
}

export async function revokePermission(tx: Tx, actorId: string, id: string): Promise<boolean> {
  const row = (await tx.query<{ user_id: string }>(`UPDATE user_permissions SET removed_at = SYSUTCDATETIME(), removed_by = $2
    OUTPUT inserted.user_id WHERE id = $1 AND removed_at IS NULL`, [id, actorId])).rows[0];
  if (!row) return false;
  await audit(tx, { actorKind: "user", actorId, action: "permission.revoke", targetKind: "user", targetId: row.user_id,
    outcome: "succeeded", details: { permissionId: id } });
  return true;
}
