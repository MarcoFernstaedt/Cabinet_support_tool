// A difference nobody declared, as it appears (F17, decision-log D54). A cabinet whose recent change leaves a setting unlike the same
// setting on every other cabinet of its role at its site, where no baseline declares it, gets one minor alert saying what differs; it
// closes, audited, once it matches again. Fields that differ by nature, peers that do not agree, too few peers, and settings a baseline
// declares raise nothing. Through the real configuration ingest on a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { configHash, type Item } from "../src/services/config-canonical.js";
import { ingestAndEvaluate } from "../src/services/config-service.js";
import { PEER_DIFFERENCE_SIGNATURE, peerDifferences } from "../src/services/peer-differences.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let clientId: string;
test.before(async () => {
  db = await createTestDatabase();
  clientId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour')", [clientId]);
});
test.after(async () => { await db.drop(); });

let minute = 0;
const it = (key: string, values: Record<string, unknown>) => ({ key, values }) as Item;
/** The cabinet reports its services: W32Time with this start type and state, and Spooler unless left out. */
const services = (cabinetId: string, startType: string, state = "running", spooler = true) => {
  const items = [it("service:W32Time", { startType, state }), ...(spooler ? [it("service:Spooler", { startType: "automatic", state: "running" })] : [])];
  return ingestAndEvaluate(db.app, cabinetId, [{ observedAt: new Date(Date.now() - 3_600_000 + (minute += 1) * 60_000).toISOString(), category: "services",
    hash: configHash(items), truncated: false, items }] as never, "agent");
};
async function site(n: number, name: string) {
  const siteId = randomUUID();
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [siteId, clientId, name]);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, $3, 'standalone', 'active', SYSUTCDATETIME())", [id, siteId, `${name} ${i + 1}`]);
    ids.push(id);
  }
  return ids;
}
const alerts = async (cabinetId: string) => (await db.app.query<{ state: string; title: string; severity: string }>(
  "SELECT state, title, severity FROM alerts WHERE cabinet_id = $1 AND signature = $2", [cabinetId, PEER_DIFFERENCE_SIGNATURE])).rows;

test("a change that leaves one cabinet unlike all its peers opens one minor alert saying what differs; changing back closes it, audited", async () => {
  const [a, b, c] = await site(3, "Pier");
  for (const k of [a, b, c]) await services(k!, "automatic");
  assert.deepEqual(await alerts(a!), [], "all alike");
  await services(a!, "manual");
  const [x] = await alerts(a!);
  assert.deepEqual([x?.state, x?.severity], ["open", "minor"]);
  assert.equal(x!.title, "Differs from the other 2 standalone cabinets at Pier: service:W32Time startType manual (they have automatic)");
  await services(a!, "automatic");
  assert.deepEqual((await alerts(a!)).map(r => r.state), ["resolved"]);
  const audit = (await db.app.query<{ actor_id: string }>("SELECT TOP (1) actor_id FROM audit_log WHERE action = 'alert.resolve' AND actor_kind = 'system' ORDER BY seq DESC")).rows[0]!;
  assert.equal(audit.actor_id, "peer-difference");
});

test("a missing item is a difference; a field that differs by nature, peers that disagree, or a single peer raise nothing", async () => {
  const [a, b, c] = await site(3, "Quay");
  for (const k of [a, b, c]) await services(k!, "automatic");
  await services(a!, "automatic", "running", false); // Spooler gone on a only
  assert.match((await alerts(a!))[0]!.title, /: service:Spooler is missing \(they all have it\)$/);

  const [d, e, f] = await site(3, "Dock");
  for (const k of [d, e, f]) await services(k!, "automatic");
  await services(d!, "automatic", "stopped");
  assert.deepEqual(await alerts(d!), [], "a service's running state differs by nature");

  const [g, h, i] = await site(3, "Wharf");
  await services(g!, "automatic"); await services(h!, "manual"); await services(i!, "automatic");
  await services(i!, "disabled");
  assert.deepEqual(await alerts(i!), [], "its peers do not agree among themselves");

  const [j, k2] = await site(2, "Jetty");
  await services(j!, "automatic"); await services(k2!, "automatic");
  await services(j!, "manual");
  assert.deepEqual(await alerts(j!), [], "one peer is not enough to stand out from");
});

test("an item a baseline declares is left to drift; the comparison itself is pure and ignores the per-cabinet devices", () => {
  const svc = (startType: string) => new Map([["services", [it("service:W32Time", { startType, state: "running" })]]]) as never;
  const candidates = [{ category: "services", itemKey: "service:W32Time" }] as never;
  assert.equal(peerDifferences(svc("manual"), [svc("automatic"), svc("automatic")], candidates, new Set()).length, 1);
  assert.deepEqual(peerDifferences(svc("manual"), [svc("automatic"), svc("automatic")], candidates, new Set(["services|service:W32Time"])), [], "declared: drift's job");
  const dev = (name: string) => new Map([["devices", [it("device:USB1", { name })]]]) as never;
  assert.deepEqual(peerDifferences(dev("x"), [dev("y"), dev("y")], [{ category: "devices", itemKey: "device:USB1" }] as never, new Set()), []);
});
