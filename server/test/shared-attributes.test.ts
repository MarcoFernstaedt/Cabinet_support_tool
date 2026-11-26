// What the affected cabinets of a fleet incident have in common (roadmap module 11, plan item 2.3, decision-log D157): their model,
// Windows build, BIOS version and agent version, each counted among the affected cabinets and among the others. A value stands out only
// when it is far more common among the affected; one nobody reported never does. The BIOS version is remembered on the cabinet from
// the reports that already carry the model.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fleetCrashIncident } from "../src/services/crashes.js";
import { rememberCabinetModel } from "../src/services/config-ingest.js";
import { ingestAndEvaluate } from "../src/services/config-service.js";
import { configHash, type Item } from "../src/services/config-canonical.js";
import { sharedAttributes } from "../src/services/shared-attributes.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let user: string;
test.before(async () => {
  db = await createTestDatabase();
  user = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, $2, 'Tester', 'tier1', 'x')", [user, `t.${user.slice(0, 8)}`]);
});
test.after(async () => { await db?.drop(); });

interface Facts { model: string; bios: string | null; build: string | null; agent: string }
/** One client's cabinets, each with the facts given: the model and BIOS on the row, the build in a stored system.info answer. */
async function fleet(list: Facts[]): Promise<{ client: string; ids: string[] }> {
  const client = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  const ids: string[] = [];
  for (const [i, f] of list.entries()) {
    const k = randomUUID();
    ids.push(k);
    await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, manufacturer, model, bios_version, agent_version)
                        VALUES ($1, $2, $3, 'standalone', 'active', 'Dell Inc.', $4, $5, $6)`, [k, site, `K${i}`, f.model, f.bios, f.agent]);
    if (f.build) await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result_at, result)
        VALUES ($1, $2, 'system.info', '{}', $3, SYSUTCDATETIME(), DATEADD(minute, 5, SYSUTCDATETIME()), 'succeeded', SYSUTCDATETIME(), $4)`,
      [randomUUID(), k, user, JSON.stringify({ status: "succeeded", output: { osBuild: f.build } })]);
  }
  return { client, ids };
}
const bugcheck = (cabinet: string) => db.app.query(
  `INSERT INTO events (event_id, cabinet_id, kind, occurred_at, source, detail) VALUES ($1, $2, 'error', DATEADD(hour, -2, SYSUTCDATETIME()), $3, $4)`,
  [randomUUID(), cabinet, JSON.stringify({ log: "System", source: "BugCheck", eventId: 1001, level: "error", recordId: 1 }),
   JSON.stringify({ message: "The computer has rebooted from a bugcheck.  The bugcheck was: 0x0000007e (0x1, 0x2, 0x3, 0x4)." })]);
const window = () => ({ from: new Date(Date.now() - 3 * 86_400_000), to: new Date(Date.now() + 60_000) });

test("a crash incident whose cabinets share exactly one attribute, the BIOS version, names that one as standing out and no other", async () => {
  // Ten cabinets: two models and two builds spread evenly over both sides; the four that crash all have BIOS 1.4.2, which one other has.
  const facts: Facts[] = [
    { model: "OptiPlex 7090", bios: "1.4.2", build: "19044.5011", agent: "0.3.1" }, { model: "OptiPlex 3080", bios: "1.4.2", build: "22631.4460", agent: "0.3.1" },
    { model: "OptiPlex 7090", bios: "1.4.2", build: "22631.4460", agent: "0.3.0" }, { model: "OptiPlex 3080", bios: "1.4.2", build: "19044.5011", agent: "0.3.0" },
    { model: "OptiPlex 7090", bios: "1.5.0", build: "19044.5011", agent: "0.3.1" }, { model: "OptiPlex 3080", bios: "1.5.0", build: "22631.4460", agent: "0.3.1" },
    { model: "OptiPlex 7090", bios: "1.5.0", build: "22631.4460", agent: "0.3.0" }, { model: "OptiPlex 3080", bios: "1.4.2", build: "19044.5011", agent: "0.3.0" },
    { model: "OptiPlex 7090", bios: null, build: null, agent: "0.3.1" }, { model: "OptiPlex 3080", bios: "1.5.0", build: "22631.4460", agent: "0.3.0" },
  ];
  const { client, ids } = await fleet(facts);
  for (const k of ids.slice(0, 4)) await bugcheck(k);
  const inc = await fleetCrashIncident(db.app, { ...window(), clientId: client });
  assert.equal(inc.affected, 4);
  const out = inc.sharedAttributes.filter(a => a.standsOut);
  assert.deepEqual(out.map(a => [a.attribute, a.name, a.value, a.affected, a.affectedShare, a.unaffected, a.unaffectedShare]),
    [["biosVersion", "BIOS version", "1.4.2", 4, 100, 1, 16.7]]);
  const model = inc.sharedAttributes.find(a => a.attribute === "model" && a.value === "Dell Inc. OptiPlex 7090")!;
  assert.deepEqual([model.affected, model.affectedShare, model.standsOut], [2, 50, false], "half the affected have it, and half the others too");
  assert.ok(inc.sharedAttributes.some(a => a.attribute === "windowsBuild" && a.value === "19044.5011" && !a.standsOut), "the build is read from the stored system.info answer");
  assert.ok(!inc.sharedAttributes.some(a => a.value === "" || /unknown|null/i.test(a.value)), "a value nobody reported is never counted");
});

test("one affected cabinet never makes anything stand out, an empty fleet compares nothing, and values match whatever their case", async () => {
  const { ids } = await fleet([
    { model: "M", bios: "A1", build: "1.0", agent: "1" }, { model: "M", bios: "B1", build: "1.0", agent: "1" }, { model: "M", bios: "b1", build: "1.0", agent: "1" }]);
  const one = await sharedAttributes(db.app, { ids, affected: new Set([ids[0]!.toLowerCase()]) });
  assert.ok(one.length > 0 && one.every(a => !a.standsOut), "a single affected cabinet");
  const two = await sharedAttributes(db.app, { ids, affected: new Set([ids[1]!, ids[2]!].map(x => x.toLowerCase())) });
  assert.deepEqual(two.filter(a => a.standsOut).map(a => [a.attribute, a.affected]), [["biosVersion", 2]], "B1 and b1 are one value");
  assert.deepEqual(await sharedAttributes(db.app, { ids: [], affected: new Set() }), []);
});

test("the BIOS version is remembered from the hardware item and from a system.hardware answer; a blank or hostile value is not trusted further", async () => {
  const { ids: [k] } = await fleet([{ model: "Old", bios: null, build: null, agent: "1" }]);
  const bios = async () => (await db.app.query<{ bios_version: string | null; model: string | null }>("SELECT bios_version, model FROM cabinets WHERE id = $1", [k])).rows[0]!;
  const hardware = (values: Item["values"]): Item => ({ key: "hardware", values });
  const items = [hardware({ manufacturer: "Dell Inc.", model: "OptiPlex 7090", biosVersion: "1.4.2" })];
  await ingestAndEvaluate(db.app, k!, [{ observedAt: new Date().toISOString(), category: "system", hash: configHash(items), truncated: false, items }] as never, "agent");
  assert.deepEqual(await bios(), { bios_version: "1.4.2", model: "OptiPlex 7090" });
  await rememberCabinetModel(db.app, k!, { manufacturer: null, model: null, bios: { version: "1.6.0" } });
  assert.equal((await bios()).bios_version, "1.6.0", "a system.hardware answer");
  await rememberCabinetModel(db.app, k!, { biosVersion: "   " });
  assert.equal((await bios()).bios_version, "1.6.0", "a blank value keeps what was known");
  await rememberCabinetModel(db.app, k!, { biosVersion: "'; DROP TABLE cabinets; --" + "x".repeat(300) });
  const stored = (await bios()).bios_version!;
  assert.equal(stored.length, 200, "cut to the column");
  assert.ok(stored.startsWith("'; DROP TABLE cabinets; --"), "kept as text, a parameter, never SQL");
  await assert.rejects(rememberCabinetModel(db.app, "not-a-cabinet", { biosVersion: "1" }), /uuid/);
});
