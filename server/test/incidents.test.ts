// The unified incident record (docs/spec/18-built-designs.md §2, items 2 and 5; migration 0017):
// one incident followed from its symptom to a verified repair, each step appended in order and audited, a person's approval required
// before a repair runs, links only to the incident's own cabinet, hostile input refused, steps that cannot be changed, and retention.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "../src/auth/passwords.js";
import { NULL_BINARY } from "../src/db/db.js";
import { appendStep, cabinetIncidents, checkDetail, getIncident, linkIncident, nextState, openIncident, type Actor, type IncidentState, type StepInput } from "../src/services/incidents.js";
import { runRetention } from "../src/services/maintenance.js";
import { Refused } from "../src/services/errors.js";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let userId: string;
let person: Actor;
const engine: Actor = { kind: "system", name: "engine" };

test.before(async () => {
  db = await createTestDatabase();
  userId = randomUUID();
  person = { kind: "user", userId };
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, $2, 'Incident Admin', 'admin', $3, 0, 0, $4, 1)`, [userId, "inc." + randomBytes(3).toString("hex"), await hashPassword(randomBytes(12).toString("hex")), NULL_BINARY]);
});
test.after(async () => { await db.drop(); });

async function cabinet(name = "EXAM 1"): Promise<string> {
  const [client, site, id] = [randomUUID(), randomUUID(), randomUUID()];
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `Client ${randomBytes(3).toString("hex")}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'North')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, $3, 'satellite', 'active')", [id, site, name]);
  return id;
}
async function command(cabinetId: string): Promise<string> {
  const id = randomUUID();
  await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status)
                      VALUES ($1, $2, 'service.control', '{"name":"BioScanSvc","action":"restart"}', $3, SYSUTCDATETIME(), DATEADD(minute, 5, SYSUTCDATETIME()), 'succeeded')`, [id, cabinetId, userId]);
  return id;
}
async function alert(cabinetId: string): Promise<string> {
  const id = randomUUID();
  await db.app.query(`INSERT INTO alerts (id, cabinet_id, severity, signature, title, first_seen, last_seen) VALUES ($1, $2, 'major', $3, 'Scanner offline', SYSUTCDATETIME(), SYSUTCDATETIME())`,
    [id, cabinetId, `sig-${randomUUID()}`]);
  return id;
}
async function refusedWith(p: Promise<unknown>, code: string): Promise<string> {
  try { await p; } catch (e) { assert.ok(e instanceof Refused, String(e)); assert.equal(e.code, code, e.message); return e.message; }
  assert.fail(`expected ${code}`);
}
const auditFor = async (incidentId: string) => (await db.app.query<{ action: string; outcome: string; actor_kind: string; details: string }>(
  "SELECT action, outcome, actor_kind, details FROM audit_log WHERE target_kind = 'incident' AND target_id = $1 ORDER BY seq", [incidentId])).rows;

test("an incident runs from symptom to a verified repair, every step in order and in the audit log", async () => {
  const cab = await cabinet();
  const id = await openIncident(db.app, { cabinetId: cab, symptom: "The fingerprint scanner is not answering", module: { id: "scanner-offline", version: 1 }, by: engine });
  const steps: [StepInput, Actor, IncidentState][] = [
    [{ kind: "evidence", summary: "No scanner on any USB port", detail: { ports: 4, scannerSeen: false } }, engine, "open"],
    [{ kind: "hypothesis", summary: "The scanner's service is stopped", detail: { findingKey: "scanner.service_stopped" } }, engine, "open"],
    [{ kind: "proposed_repair", summary: "Restart the scanner's service", detail: { operation: "service.control" } }, engine, "awaiting_approval"],
    [{ kind: "approval", summary: "Approved" }, person, "approved"],
  ];
  for (const [s, by, state] of steps) assert.equal((await appendStep(db.app, id, s, by)).state, state);
  const cmd = await command(cab);
  assert.deepEqual(await appendStep(db.app, id, { kind: "execution", summary: "Sent the restart", commandId: cmd }, person), { position: 6, state: "repairing" });
  assert.deepEqual(await appendStep(db.app, id, { kind: "verification", summary: "The service is running again", result: "passed" }, engine), { position: 7, state: "resolved" });

  const inc = (await getIncident(db.app, id))!;
  assert.equal(inc.state, "resolved");
  assert.ok(inc.closedAt);
  assert.equal(inc.outcome, "The service is running again");
  assert.deepEqual(inc.module, { id: "scanner-offline", version: 1 });
  assert.deepEqual(inc.steps.map(s => s.kind), ["symptom", "evidence", "hypothesis", "proposed_repair", "approval", "execution", "verification"]);
  assert.deepEqual(inc.steps.map(s => s.position), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(inc.steps[4]!.actor, person);
  assert.deepEqual(inc.steps[1]!.detail, { ports: 4, scannerSeen: false });
  assert.equal(inc.steps[5]!.detail!.commandId, cmd);
  assert.deepEqual(inc.links.map(l => [l.kind, l.refId]), [["command", cmd]]);

  const log = await auditFor(id);
  assert.deepEqual(log.map(a => a.action), ["incident.open", ...Array(6).fill("incident.step")]);
  assert.ok(log.every(a => a.outcome === "succeeded"));
  assert.equal(log[4]!.actor_kind, "user");
  assert.deepEqual((await cabinetIncidents(db.app, cab)).map(i => i.id), [id]);
});

test("the state machine allows only the next step that makes sense, and never a system approval", () => {
  const all: IncidentState[] = ["open", "awaiting_approval", "approved", "repairing", "resolved", "unresolved"];
  const ok = (state: IncidentState, step: Pick<StepInput, "kind" | "result">, actor: Actor = person) => {
    const r = nextState(state, step, actor);
    return "state" in r ? r.state : null;
  };
  for (const s of all) assert.equal(ok(s, { kind: "approval" }, engine), null, `system approval in ${s}`);
  assert.equal(ok("awaiting_approval", { kind: "approval" }), "approved");
  for (const s of all.filter(s => s !== "awaiting_approval")) assert.equal(ok(s, { kind: "approval" }), null, `approval in ${s}`);
  for (const s of all.filter(s => s !== "approved")) assert.equal(ok(s, { kind: "execution" }), null, `execution in ${s}`);
  for (const s of all.filter(s => s !== "repairing")) assert.equal(ok(s, { kind: "verification", result: "passed" }), null, `verification in ${s}`);
  assert.equal(ok("repairing", { kind: "verification", result: "failed" }), "open");
  assert.equal(ok("repairing", { kind: "verification", result: "incomplete" }), "open");
  assert.equal(ok("repairing", { kind: "verification" }), null, "a verification must say what it showed");
  assert.equal(ok("repairing", { kind: "verification", result: "resolved" }), null);
  assert.equal(ok("approved", { kind: "proposed_repair" }), null, "a new proposal does not replace an approved one");
  assert.equal(ok("repairing", { kind: "close", result: "unresolved" }), "unresolved");
  assert.equal(ok("open", { kind: "close", result: "passed" }), null);
  for (const s of ["resolved", "unresolved"] as const) for (const kind of ["note", "evidence", "close"] as const) assert.equal(ok(s, { kind, result: "resolved" }), null, `${kind} after ${s}`);
});

test("a refused step writes nothing but is still recorded as refused", async () => {
  const cab = await cabinet();
  const id = await openIncident(db.app, { cabinetId: cab, symptom: "Slow logins", by: person });
  await refusedWith(appendStep(db.app, id, { kind: "execution", summary: "Ran it anyway", commandId: await command(cab) }, person), "wrong_stage");
  await appendStep(db.app, id, { kind: "proposed_repair", summary: "Restart the service" }, engine);
  assert.match(await refusedWith(appendStep(db.app, id, { kind: "approval", summary: "I approve myself" }, engine), "wrong_stage"), /only a person approves/);
  const inc = (await getIncident(db.app, id))!;
  assert.equal(inc.state, "awaiting_approval");
  assert.deepEqual(inc.steps.map(s => s.kind), ["symptom", "proposed_repair"]);
  assert.deepEqual(inc.links, [], "the refused execution linked nothing");
  const refused = (await auditFor(id)).filter(a => a.outcome === "refused");
  assert.equal(refused.length, 2);
  assert.match(JSON.stringify(refused[1]!.details), /only a person approves/);
});

test("a failed verification reopens the incident for another try; a closed one takes nothing more", async () => {
  const cab = await cabinet();
  const id = await openIncident(db.app, { cabinetId: cab, symptom: "Drawer not opening", by: person });
  await appendStep(db.app, id, { kind: "proposed_repair", summary: "Set the drawer address" }, engine);
  await appendStep(db.app, id, { kind: "approval", summary: "Approved" }, person);
  await appendStep(db.app, id, { kind: "execution", summary: "Sent", commandId: await command(cab) }, person);
  assert.equal((await appendStep(db.app, id, { kind: "verification", summary: "Still no drawer", result: "failed" }, engine)).state, "open");
  assert.equal((await appendStep(db.app, id, { kind: "proposed_repair", summary: "Try another adapter" }, engine)).state, "awaiting_approval");
  assert.equal((await appendStep(db.app, id, { kind: "close", summary: "Replaced the cable on site", result: "unresolved" }, person)).state, "unresolved");
  await refusedWith(appendStep(db.app, id, { kind: "note", summary: "One more thing" }, person), "wrong_stage");
  const inc = (await getIncident(db.app, id))!;
  assert.equal(inc.outcome, "Replaced the cable on site");
  assert.ok(inc.closedAt);
});

test("an execution and every link must belong to the incident's own cabinet", async () => {
  const [mine, other] = [await cabinet("MINE"), await cabinet("OTHER")];
  const id = await openIncident(db.app, { cabinetId: mine, symptom: "Scanner offline", by: engine });
  await appendStep(db.app, id, { kind: "proposed_repair", summary: "Restart" }, engine);
  await appendStep(db.app, id, { kind: "approval", summary: "Approved" }, person);
  await refusedWith(appendStep(db.app, id, { kind: "execution", summary: "Sent", commandId: await command(other) }, person), "not_found");
  await refusedWith(appendStep(db.app, id, { kind: "execution", summary: "Sent", commandId: randomUUID() }, person), "not_found");
  await refusedWith(appendStep(db.app, id, { kind: "execution", summary: "Sent" }, person), "invalid_request");
  await refusedWith(appendStep(db.app, id, { kind: "note", summary: "x", commandId: await command(mine) }, person), "invalid_request");
  assert.equal((await getIncident(db.app, id))!.state, "approved");

  await refusedWith(linkIncident(db.app, id, "alert", await alert(other), person), "not_found");
  const a = await alert(mine);
  assert.deepEqual(await linkIncident(db.app, id, "alert", a, person), { added: true });
  assert.deepEqual(await linkIncident(db.app, id, "alert", a.toUpperCase(), person), { added: false }, "the same link twice changes nothing");
  await refusedWith(linkIncident(db.app, id, "diagnosis", randomUUID(), person), "not_found");
  await refusedWith(linkIncident(db.app, id, "fleet_job", randomUUID(), person), "not_found");
  await refusedWith(linkIncident(db.app, id, "events" as never, a, person), "invalid_request");
  await refusedWith(linkIncident(db.app, randomUUID(), "alert", a, person), "not_found");
  assert.deepEqual((await getIncident(db.app, id))!.links.map(l => l.kind), ["alert"]);
  assert.equal((await auditFor(id)).filter(e => e.action === "incident.link").length, 1);
});

test("hostile and malformed input is refused before anything is written", async () => {
  const cab = await cabinet();
  for (const symptom of ["", "   ", "x".repeat(201), "line one\nline two", "bell\u0007", "line\u2028separator", 42 as unknown as string])
    await refusedWith(openIncident(db.app, { cabinetId: cab, symptom, by: person }), "invalid_request");
  for (const cabinetId of ["", "not-a-uuid", "'; DROP TABLE incidents; --", `${randomUUID()}x`])
    await refusedWith(openIncident(db.app, { cabinetId, symptom: "x", by: person }), "invalid_request");
  await refusedWith(openIncident(db.app, { cabinetId: randomUUID(), symptom: "x", by: person }), "not_found");
  await refusedWith(openIncident(db.app, { cabinetId: cab, symptom: "x", by: { kind: "user", userId: randomUUID() } }), "not_found");
  await refusedWith(openIncident(db.app, { cabinetId: cab, symptom: "x", by: { kind: "user", userId: "admin" } }), "invalid_request");
  await refusedWith(openIncident(db.app, { cabinetId: cab, symptom: "x", by: { kind: "system", name: "a\u0000b" } }), "invalid_request");
  await refusedWith(openIncident(db.app, { cabinetId: cab, symptom: "x", module: { id: "m", version: 0 }, by: person }), "invalid_request");
  await refusedWith(openIncident(db.app, { cabinetId: cab, symptom: "x", module: { id: "m", version: 1.5 }, by: person }), "invalid_request");
  assert.deepEqual(await cabinetIncidents(db.app, cab), [], "nothing was opened");

  const id = await openIncident(db.app, { cabinetId: cab, symptom: "Scanner offline", by: person });
  await refusedWith(appendStep(db.app, id, { kind: "symptom" as never, summary: "a second symptom" }, person), "invalid_request");
  await refusedWith(appendStep(db.app, id, { kind: "delete" as never, summary: "x" }, person), "invalid_request");
  await refusedWith(appendStep(db.app, id, { kind: "note", summary: "x".repeat(301) }, person), "invalid_request");
  await refusedWith(appendStep(db.app, "nope", { kind: "note", summary: "x" }, person), "invalid_request");
  await refusedWith(appendStep(db.app, randomUUID(), { kind: "note", summary: "x" }, person), "not_found");
  await refusedWith(appendStep(db.app, id, { kind: "note", summary: "x" }, { kind: "user", userId: randomUUID() }), "not_found");
  assert.equal((await getIncident(db.app, id))!.steps.length, 1);
  assert.equal(await getIncident(db.app, "not-an-id"), null);
  assert.deepEqual(await cabinetIncidents(db.app, "not-an-id"), []);
});

test("a step's detail is a small flat record: nested values, prototypes, odd keys and oversize are refused", () => {
  const refused = (d: unknown) => assert.throws(() => checkDetail(d), (e: unknown) => e instanceof Refused && e.code === "invalid_request", JSON.stringify(d) ?? String(d));
  assert.deepEqual(checkDetail({ ports: 4, ok: true, note: "fine", gone: null }), { ports: 4, ok: true, note: "fine", gone: null });
  for (const d of [null, [], "text", 7, { a: { b: 1 } }, { a: [1] }, { a: Number.NaN }, { a: Number.POSITIVE_INFINITY }, { a: "x\ny" }, { a: "x".repeat(301) },
    { "": 1 }, { "1abc": 1 }, { "a-b": 1 }, { ["a".repeat(41)]: 1 }, { "__proto__x": 1 }, Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])),
    new Date(), new Map(), Object.create({ inherited: 1 })])
    refused(d);
  const proto = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
  refused(proto);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  // 20 fields of 300 characters each is within every per-field limit but over the 8 KB total.
  refused(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "é".repeat(300)])));
});

test("steps appended at the same moment each get their own position", async () => {
  const cab = await cabinet();
  const id = await openIncident(db.app, { cabinetId: cab, symptom: "Many notes at once", by: person });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => appendStep(db.app, id, { kind: "note", summary: `note ${i}` }, person)));
  assert.deepEqual(results.map(r => r.position).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 2));
  assert.deepEqual((await getIncident(db.app, id))!.steps.map(s => s.position), Array.from({ length: 13 }, (_, i) => i + 1));
});

test("the application's account cannot change or remove a step or a link", async () => {
  const cab = await cabinet();
  const id = await openIncident(db.app, { cabinetId: cab, symptom: "Tamper check", by: person });
  await linkIncident(db.app, id, "alert", await alert(cab), person);
  for (const sql of ["UPDATE incident_steps SET summary = 'changed' WHERE incident_id = $1", "DELETE FROM incident_steps WHERE incident_id = $1",
    "UPDATE incident_links SET kind = 'command' WHERE incident_id = $1", "DELETE FROM incident_links WHERE incident_id = $1"])
    await assert.rejects(db.app.query(sql, [id]), /permission was denied/i, sql);
  assert.equal((await getIncident(db.app, id))!.steps[0]!.summary, "Tamper check");
});

test("retention removes closed incidents past the resolved-alerts period with their steps and links; open ones stay", async () => {
  const cab = await cabinet();
  const [old, recent, open] = [await openIncident(db.app, { cabinetId: cab, symptom: "Old", by: person }),
    await openIncident(db.app, { cabinetId: cab, symptom: "Recent", by: person }), await openIncident(db.app, { cabinetId: cab, symptom: "Still open", by: person })];
  await linkIncident(db.app, old, "alert", await alert(cab), person);
  for (const id of [old, recent]) await appendStep(db.app, id, { kind: "close", summary: "Done", result: "resolved" }, person);
  await asOwner(db, async o => {
    await o.query("UPDATE incidents SET closed_at = DATEADD(day, -400, SYSUTCDATETIME()), opened_at = DATEADD(day, -401, SYSUTCDATETIME()) WHERE id = $1", [old]);
    await o.query("UPDATE incidents SET opened_at = DATEADD(day, -900, SYSUTCDATETIME()) WHERE id = $1", [open]);
  });
  const run = await runRetention(db.app);
  assert.ok(run.incidents >= 1);
  assert.equal(await getIncident(db.app, old), null);
  for (const t of ["incident_steps", "incident_links"])
    assert.equal(Number((await db.app.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE incident_id = $1`, [old])).rows[0]!.n), 0, t);
  assert.ok(await getIncident(db.app, recent));
  assert.equal((await getIncident(db.app, open))!.state, "open", "an open incident is never removed, however old");
});

test("an incident goes with its cabinet", async () => {
  const cab = await cabinet();
  const id = await openIncident(db.app, { cabinetId: cab, symptom: "Removed cabinet", by: person });
  await asOwner(db, o => o.query("DELETE FROM cabinets WHERE id = $1", [cab]));
  assert.equal(await getIncident(db.app, id), null);
});
