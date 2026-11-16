import test from "node:test";
import assert from "node:assert/strict";
import type { Queryable } from "../src/db/db.js";
import { requireCabinetPermission, validatePermissionScope } from "../src/services/user-permissions.js";

test("permission scopes require a fleet null or a site/cabinet UUID", () => {
  validatePermissionScope("fleet", null);
  validatePermissionScope("cabinet", "11111111-1111-4111-8111-111111111111");
  for (const [kind, id] of [["fleet", "id"], ["site", null], ["cabinet", "bad"], ["rank", null]] as const)
    assert.throws(() => validatePermissionScope(kind, id));
});

test("cabinet permission checks active grants against the cabinet and never reads rank", async () => {
  let granted = false;
  const db = { query: async (sql: string, params: unknown[]) => {
    assert.match(sql, /c.site_id/);
    assert.match(sql, /p.scope_kind = 'fleet'/);
    assert.match(sql, /p.scope_kind = 'cabinet'/);
    assert.match(sql, /p.removed_at IS NULL/);
    assert.doesNotMatch(sql, /ROLE_RANK|u.role/);
    assert.deepEqual(params, ["user", "cabinet", "session.open"]);
    return { rows: granted ? [{}] : [], rowCount: granted ? 1 : 0 };
  } } as unknown as Queryable;
  await assert.rejects(requireCabinetPermission(db, "user", "cabinet", "session.open"), /matching permission/);
  granted = true;
  await requireCabinetPermission(db, "user", "cabinet", "session.open");
});
