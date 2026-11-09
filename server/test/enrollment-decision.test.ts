// A cabinet's baseline decision at approval, recorded by the baselines module that owns the table (F21.R2, decision-log D67): what it
// is given is checked first, the same decision recorded again writes nothing, and a different one is refused, never overwritten.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { recordEnrollmentDecision, type EnrollmentDecision } from "../src/services/baselines.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

async function placed(): Promise<{ cabinetId: string; siteId: string }> {
  const client = randomUUID(), siteId = randomUUID(), cabinetId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [siteId, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'K', 'standalone', 'active')", [cabinetId, siteId]);
  return { cabinetId, siteId };
}
const rows = async (cabinetId: string) => (await db.app.query<{ decision: string; attached_version_id: string | null; capture_state: string | null }>(
  "SELECT decision, attached_version_id, capture_state FROM enrollment_baselines WHERE cabinet_id = $1", [cabinetId])).rows
  .map(r => ({ ...r, attached_version_id: r.attached_version_id?.toLowerCase() ?? null }));

test("each decision is recorded as the table has it: a capture waits for the cabinet's first configuration, an attach names its version", async () => {
  const by = randomUUID(), version = randomUUID();
  for (const [decision, attachedVersionId, expected] of [["inherited", null, null], ["capture", null, "waiting"], ["attach", version.toUpperCase(), null]] as const) {
    const k = await placed();
    await recordEnrollmentDecision(db.app, { ...k, decision, decidedBy: by, attachedVersionId });
    assert.deepEqual(await rows(k.cabinetId), [{ decision, attached_version_id: attachedVersionId?.toLowerCase() ?? null, capture_state: expected }]);
  }
});

test("the same decision again writes nothing; a different one for the same cabinet is refused and the first stands", async () => {
  const k = await placed(), by = randomUUID(), version = randomUUID();
  const d: EnrollmentDecision = { ...k, decision: "attach", decidedBy: by, attachedVersionId: version };
  await recordEnrollmentDecision(db.app, d);
  await recordEnrollmentDecision(db.app, { ...d, attachedVersionId: version.toUpperCase() });
  assert.equal((await rows(k.cabinetId)).length, 1);
  await assert.rejects(recordEnrollmentDecision(db.app, { ...d, decision: "inherited", attachedVersionId: null }), /different baseline decision/);
  await assert.rejects(recordEnrollmentDecision(db.app, { ...d, attachedVersionId: randomUUID() }), /different baseline decision/);
  assert.deepEqual(await rows(k.cabinetId), [{ decision: "attach", attached_version_id: version, capture_state: null }]);
});

test("malformed and hostile decisions are refused before anything is written", async () => {
  const k = await placed(), by = randomUUID();
  const base: EnrollmentDecision = { ...k, decision: "inherited", decidedBy: by, attachedVersionId: null };
  for (const bad of [{ cabinetId: "" }, { cabinetId: "' OR 1=1 --" }, { siteId: `${randomUUID()}; DELETE FROM enrollment_baselines` }, { decidedBy: null }, { decidedBy: 7 },
    { decision: "skip" }, { decision: "INHERITED" }, { decision: "attach" }, { decision: "attach", attachedVersionId: "not-a-version" },
    { decision: "capture", attachedVersionId: randomUUID() }, { attachedVersionId: randomUUID() }, { decision: "inherited", attachedVersionId: "" }])
    await assert.rejects(recordEnrollmentDecision(db.app, { ...base, ...bad } as never), /baseline decision|baseline version/, JSON.stringify(bad));
  assert.deepEqual(await rows(k.cabinetId), [], "nothing was written");
});
