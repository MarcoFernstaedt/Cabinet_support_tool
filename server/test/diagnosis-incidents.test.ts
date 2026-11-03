// Incidents opened by diagnoses (decision D16): a problem opens one incident per cabinet and module, later runs add evidence and are
// linked, a clean run closes it (as a passed verification when a repair was running), a run that could not tell changes nothing, and
// hostile titles are stored as one line of bounded text rather than refused.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "../src/auth/passwords.js";
import { NULL_BINARY } from "../src/db/db.js";
import { appendStep, getIncident, type Actor } from "../src/services/incidents.js";
import { cabinetOutcomes, networkOutcome, recordCheck, type CheckOutcome } from "../src/services/diagnosis-incidents.js";
import type { Finding } from "../src/diagnose/network-findings.js";
import type { AreaSummary } from "../src/diagnose/cabinet-findings.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let userId: string;
const NET = { id: "network-diagnosis", version: 1 };
const STORAGE = { id: "cabinet-storage", version: 1 };

test.before(async () => {
  db = await createTestDatabase();
  userId = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, $2, 'Diagnosis Admin', 'admin', $3, 0, 0, $4, 1)`, [userId, "dx." + randomBytes(3).toString("hex"), await hashPassword(randomBytes(12).toString("hex")), NULL_BINARY]);
});
test.after(async () => { await db.drop(); });

async function cabinet(): Promise<string> {
  const [client, site, id] = [randomUUID(), randomUUID(), randomUUID()];
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `Client ${randomBytes(3).toString("hex")}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'North')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'EXAM 1', 'satellite', 'active')", [id, site]);
  return id;
}
async function diagnosis(cabinetId: string, kind: "network" | "cabinet" = "network"): Promise<string> {
  const id = randomUUID();
  await db.app.query("INSERT INTO diagnoses (id, cabinet_id, kind, run_by, state, finished_at) VALUES ($1, $2, $3, $4, 'done', SYSUTCDATETIME())", [id, cabinetId, kind, userId]);
  return id;
}
const record = async (cabinetId: string, outcome: CheckOutcome, module = NET) =>
  recordCheck(db.app, { cabinetId, diagnosisId: await diagnosis(cabinetId), module, label: "The network diagnosis", outcome });
const incidentsOf = async (cabinetId: string) => (await db.app.query<{ id: string; state: string; module_id: string }>(
  "SELECT id, state, module_id FROM incidents WHERE cabinet_id = $1 ORDER BY opened_at, id", [cabinetId])).rows;

const f = (x: Partial<Finding> & Pick<Finding, "id" | "severity">): Finding => ({ layer: "link", certainty: "confirmed", title: x.id, evidence: [], fix: null, ...x } as Finding);
const problem: CheckOutcome = { state: "problem", titles: ["The gateway does not answer"], problems: 1, warnings: 0 };

test("a network diagnosis's findings become one outcome", () => {
  assert.equal(networkOutcome([f({ id: "gw", severity: "problem", title: "No gateway" }), f({ id: "dns", severity: "warning" })]).state, "problem");
  // A problem explained by another counts once, through the one that explains it.
  const o = networkOutcome([f({ id: "gw", severity: "problem" }), f({ id: "dns", severity: "problem", causedBy: "gw" })]);
  assert.equal(o.state === "problem" && o.problems, 1);
  assert.equal(networkOutcome([f({ id: "config", severity: "info", certainty: "not_checked" })]).state, "unknown", "a run that could not read the settings tells nothing");
  assert.equal(networkOutcome([f({ id: "dns", severity: "warning" })]).state, "warning");
  assert.equal(networkOutcome([f({ id: "sync-none", severity: "info", certainty: "not_checked" }), f({ id: "gw", severity: "ok" })]).state, "clean");
  assert.equal(networkOutcome([]).state, "clean");
});

test("a cabinet diagnosis gives one outcome per cabinet module, leaving the network to its own diagnosis", () => {
  const areas: AreaSummary[] = [
    { area: "storage", label: "Storage", state: "problem", summary: "Drive C: is failing" },
    { area: "time", label: "Time", state: "ok", summary: "Clock in step" },
    { area: "logs", label: "Logs", state: "unknown", summary: "Not checked" },
    { area: "updates", label: "Updates", state: "warning", summary: "Updates pending" },
    { area: "network", label: "Network", state: "problem", summary: "No gateway" },
  ];
  const modules = new Map([["storage", STORAGE], ["time", { id: "cabinet-time", version: 1 }], ["logs", { id: "cabinet-logs", version: 1 }], ["updates", { id: "cabinet-updates", version: 2 }]]);
  const out = cabinetOutcomes(areas, modules);
  assert.deepEqual(out.map(o => [o.module.id, o.outcome.state]), [["cabinet-storage", "problem"], ["cabinet-time", "clean"], ["cabinet-logs", "unknown"], ["cabinet-updates", "warning"]]);
  assert.equal(cabinetOutcomes([{ area: "storage", label: "Storage", state: "problem", summary: "x" }], new Map()).length, 0, "an area with no module records nothing");
});

test("a problem opens an incident, later runs add to it, and a clean run closes it", async () => {
  const cab = await cabinet();
  const first = await record(cab, problem);
  assert.equal(first.action, "opened");
  const again = await record(cab, { state: "problem", titles: ["The gateway does not answer", "No DNS server answers"], problems: 2, warnings: 0 });
  assert.equal(again.action, "added");
  assert.equal(again.incidentId, first.incidentId, "one open incident per cabinet and module");
  assert.equal((await record(cab, { state: "warning", titles: ["Packet loss to the gateway"], warnings: 1 })).action, "added");
  assert.equal((await record(cab, { state: "unknown" })).action, "none", "a run that could not tell changes nothing");
  assert.equal((await record(cab, { state: "clean" })).action, "closed");

  const inc = (await getIncident(db.app, first.incidentId!))!;
  assert.equal(inc.state, "resolved");
  assert.equal(inc.symptom, "The gateway does not answer");
  assert.deepEqual(inc.module, NET);
  assert.deepEqual(inc.steps.map(s => s.kind), ["symptom", "evidence", "evidence", "evidence", "evidence", "close"]);
  assert.ok(inc.steps.every(s => s.actor.kind === "system"), "the platform, not a person, records diagnoses");
  assert.equal(inc.links.filter(l => l.kind === "diagnosis").length, 4, "every run that said something is linked; the one that could not tell is not");
  assert.equal(inc.steps[2]!.detail?.problems, 2);

  // The next problem is a new incident: a closed one takes no more steps.
  const next = await record(cab, problem);
  assert.equal(next.action, "opened");
  assert.notEqual(next.incidentId, first.incidentId);
});

test("with no open incident, a clean, warning or unknown run opens nothing", async () => {
  const cab = await cabinet();
  for (const o of [{ state: "clean" }, { state: "warning", titles: ["x"], warnings: 1 }, { state: "unknown" }] as CheckOutcome[])
    assert.equal((await record(cab, o)).action, "none");
  assert.equal((await incidentsOf(cab)).length, 0);
});

test("modules keep their own incidents on the same cabinet", async () => {
  const cab = await cabinet();
  await record(cab, problem, NET);
  await record(cab, { state: "problem", titles: ["Drive C: is failing"], problems: 1, warnings: 0 }, STORAGE);
  await record(cab, { state: "clean" }, NET);
  const rows = await incidentsOf(cab);
  assert.deepEqual(rows.map(r => [r.module_id, r.state]).sort(), [["cabinet-storage", "open"], ["network-diagnosis", "resolved"]]);
});

test("a clean run after a repair that ran is recorded as a passed verification", async () => {
  const cab = await cabinet();
  const { incidentId } = await record(cab, problem);
  const person: Actor = { kind: "user", userId };
  const command = randomUUID();
  await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status)
                      VALUES ($1, $2, 'network.renewLease', '{}', $3, SYSUTCDATETIME(), DATEADD(minute, 5, SYSUTCDATETIME()), 'succeeded')`, [command, cab, userId]);
  await appendStep(db.app, incidentId!, { kind: "proposed_repair", summary: "Renew the DHCP lease" }, person);
  await appendStep(db.app, incidentId!, { kind: "approval", summary: "Approved" }, person);
  await appendStep(db.app, incidentId!, { kind: "execution", summary: "Lease renewed", commandId: command }, person);
  assert.equal((await record(cab, { state: "clean" })).action, "closed");
  const inc = (await getIncident(db.app, incidentId!))!;
  assert.equal(inc.state, "resolved");
  assert.equal(inc.steps.at(-1)!.kind, "verification");
  assert.equal(inc.steps.at(-1)!.detail?.result, "passed");
});

test("hostile finding titles are stored as one bounded line, never refused", async () => {
  const cab = await cabinet();
  const nasty = `Line one\r\nLine two\u0000 ${"x".repeat(5000)}`;
  const { incidentId, action } = await record(cab, { state: "problem", titles: [nasty, "<script>alert(1)</script>", "\u0007\u0008"], problems: 3, warnings: 0 });
  assert.equal(action, "opened");
  const inc = (await getIncident(db.app, incidentId!))!;
  assert.ok(inc.symptom.length <= 200);
  for (const s of inc.steps) {
    assert.ok(s.summary.length <= 300, s.kind);
    assert.ok([...s.summary].every(ch => { const c = ch.codePointAt(0)!; return c >= 32 && c !== 127 && c !== 0x2028; }), "one line, no control characters");
  }
  // A title that is nothing but control characters still gives a symptom.
  const empty = await record(await cabinet(), { state: "problem", titles: ["\u0001\u0002"], problems: 1, warnings: 0 });
  assert.equal((await getIncident(db.app, empty.incidentId!))!.symptom, "The network diagnosis found a problem");
});
