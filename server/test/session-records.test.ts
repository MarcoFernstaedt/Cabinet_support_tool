import test from "node:test";
import assert from "node:assert/strict";
import type { Tx } from "../src/db/db.js";
import { closeSessionRecord, insertSessionRecord, recordSessionRefusal } from "../src/services/session-records.js";

// Validation must finish before touching persistence, including before appending an audit entry.
const untouched = { query: async () => { assert.fail("invalid input touched the database"); } } as unknown as Tx;

test("session history refuses empty and oversized reasons and kinds before writing", async () => {
  const valid = { cabinetId: "unused", operatorId: "unused", kind: "diagnostic", reason: "Investigate the outage" };
  for (const reason of ["", " \t\n", "x".repeat(1001)]) {
    await assert.rejects(insertSessionRecord(untouched, { ...valid, reason }), { code: "invalid_session_record" });
    await assert.rejects(closeSessionRecord(untouched, "unused", "explicit", reason, { actorKind: "user", actorId: "unused" }), { code: "invalid_session_record" });
    await assert.rejects(recordSessionRefusal(untouched, { actorKind: "agent", actorId: "unused" }, "unused", reason), { code: "invalid_session_record" });
  }
  for (const kind of ["", "  ", "x".repeat(65)])
    await assert.rejects(insertSessionRecord(untouched, { ...valid, kind }), { code: "invalid_session_record" });
});

test("unknown close endings are rejected before persistence", async () => {
  await assert.rejects(closeSessionRecord(untouched, "unused", "unknown" as "explicit", "Reason", { actorKind: "system", actorId: "test" }), { code: "invalid_session_record" });
});
