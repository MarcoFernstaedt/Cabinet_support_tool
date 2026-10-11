// Network troubleshooting end to end (docs/spec/14-network-troubleshooting.md): the site baseline, the diagnosis on one cabinet,
// several, or a whole site, what it finds from the baseline, and the fixes: one cabinet with an authenticator code, many with
// the password, each checked by reading the settings back. The simulated cabinets keep their own network state, so a fix
// really changes what the next check sees.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import { paramsHash } from "../src/auth/canonical.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { DemoSimulator, enableDemo } from "../src/demo/demo.js";
import { initialNet } from "../src/demo/network.js";
import { ISSUE } from "../src/services/rules.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

const ORIGIN = "https://console.test";
const TIMING = { pollMs: 50, verifyMs: 5_000 };
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let sim: DemoSimulator;
let clock = Date.now();
const secrets = new SecretBox(randomBytes(32).toString("base64"));

interface Account { id: string; username: string; password: string; secret: Buffer; cookie?: string }
async function account(role: "tier1" | "tier2" | "admin"): Promise<Account> {
  const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple", secret: totp.newSecret() };
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, write_limit) VALUES ($1, $2, $3, $4, $5, false, true, $6, 100)`,
    [a.id, a.username, "Test " + a.username, role, await hashPassword(a.password), secrets.seal(a.secret)]);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ username: a.username, password: a.password }) });
  a.cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  clock += 30_000;
  assert.equal((await call("POST", "/api/auth/totp", { code: totp.code(a.secret, totp.stepAt(clock)) }, a)).body.stage, "complete");
  return a;
}
async function call(method: "GET" | "POST" | "PUT", url: string, body: unknown, a?: Account) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (a?.cookie) headers.cookie = a.cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  let parsed: any = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  return { status: r.statusCode, body: parsed };
}
/** An authenticator-code token for one action on one target, bound to the exact parameters. */
async function codeToken(a: Account, action: string, target: string, params: unknown) {
  clock += 30_000;
  const r = await call("POST", "/api/auth/step-up", { code: totp.code(a.secret, totp.stepAt(clock)), action, target, paramsHash: paramsHash(params) }, a);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token as string;
}
async function runBatch(a: Account, body: unknown, ms = 60_000) {
  const started = await call("POST", "/api/diagnose/network", body, a);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    const b = (await call("GET", `/api/diagnose/network/batches/${started.body.batchId}`, undefined, a)).body;
    if (b.state === "done") return b;
  }
  assert.fail("the diagnosis did not finish");
}
/** A job on the Fleet operations path, confirmed with the password; returns the finished job. */
async function runJob(a: Account, operation: string, cabinetIds: string[]) {
  const jobId = randomUUID(), batchSize = 10;
  const t = await call("POST", "/api/auth/confirm-password", { password: a.password, action: "fleet.job", target: jobId, paramsHash: paramsHash({ operation, cabinetIds, batchSize }) }, a);
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const started = await call("POST", "/api/fleet-operations/jobs", { jobId, operation, cabinetIds, batchSize, stepUpToken: t.body.token }, a);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (const end = Date.now() + 60_000; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    const j = (await call("GET", `/api/fleet-operations/jobs/${jobId}`, undefined, a)).body;
    if (j.state !== "running") return j;
  }
  assert.fail("the job did not finish");
}
const cab = async (name: string) => (await db.app.query<{ id: string; site_id: string }>("SELECT id, site_id FROM cabinets WHERE name = $1 AND demo_scenario IS NOT NULL", [name])).rows[0]!;
const siteOf = async (name: string) => (await db.app.query<{ id: string }>("SELECT s.id FROM sites s JOIN clients c ON c.id = s.client_id WHERE c.demo AND s.name LIKE $1", [name + "%"])).rows[0]!.id;
const openAlert = async (cabinetId: string) => (await db.app.query("SELECT 1 FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'", [cabinetId, ISSUE.networkBaseline])).rows.length > 0;
const problemGroups = (b: { groups: { severity: string }[] }) => b.groups.filter(g => g.severity === "problem");

test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => clock, fleetJobTiming: TIMING });
  const owner = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'demo.owner', 'Demo owner', 'admin', 'x')`, [owner]);
  await enableDemo(db.app, owner);
  sim = new DemoSimulator(db.app, m => assert.fail(m), 25, [0, 20]);
  sim.start();
});
test.after(async () => { sim.stop(); await app.close(); await stream.stop(); await db.drop(); });

test("turning demo mode on raises the baseline alert on the cabinets that differ from their site, and only on those", async () => {
  for (const name of ["Lab", "Front Desk", "Triage", "Uptown Sync", "Uptown Exam 1", "Uptown Exam 2", "ER North"]) assert.ok(await openAlert((await cab(name)).id), name);
  for (const name of ["Surgery", "Uptown Exam 3", "Rounds", "Central Sync"]) assert.ok(!(await openAlert((await cab(name)).id)), name);
});

test("a whole site at once: Dallas shows three cabinets with the old DNS servers as one fix; one bulk fix with the password repairs all three and reads each back", async () => {
  const t1 = await account("tier1"), t2 = await account("tier2");
  const dallas = await siteOf("Dallas");
  const b = await runBatch(t1, { siteId: dallas });
  assert.equal(b.cabinets.length, 4);
  assert.equal(b.cabinets.filter((c: { layers: { dns: string } }) => c.layers.dns === "problem").length, 3);
  assert.equal(b.cabinets.find((c: { name: string }) => c.name === "Uptown Exam 3").layers.dns, "ok");
  const g = b.groups.find((x: { key: string }) => x.key === "baseline-dns|set_dns");
  assert.ok(g, JSON.stringify(b.groups.map((x: { key: string }) => x.key)));
  assert.equal(g.operation, "network.setDns");
  assert.equal(g.targets.length, 3);
  assert.equal(g.severity, "problem");
  // The consequences (no DNS answers, the platform's name does not resolve) are not listed as separate problems.
  assert.equal(problemGroups(b).length, 1, JSON.stringify(b.groups.map((x: { key: string }) => x.key)));
  const ids = g.targets.map((x: { cabinetId: string }) => x.cabinetId);
  // Tier 1 may look but not change the network; the job needs Tier 2.
  const jobId = randomUUID();
  const forT1 = await call("POST", "/api/auth/confirm-password", { password: t1.password, action: "fleet.job", target: jobId, paramsHash: paramsHash({ operation: "network.setDns", cabinetIds: ids, batchSize: 10 }) }, t1);
  assert.equal((await call("POST", "/api/fleet-operations/jobs", { jobId, operation: "network.setDns", cabinetIds: ids, batchSize: 10, stepUpToken: forT1.body.token }, t1)).status, 403);
  assert.equal((await call("POST", "/api/fleet-operations/preview", { operation: "network.setDns", cabinetIds: ids }, t1)).status, 403);
  const preview = (await call("POST", "/api/fleet-operations/preview", { operation: "network.setDns", cabinetIds: ids }, t2)).body;
  assert.equal(preview.change, 3);
  assert.deepEqual(preview.cabinets[0].params.servers, ["192.168.60.10", "192.168.60.11"]);
  const j = await runJob(t2, "network.setDns", ids);
  assert.deepEqual(j.counts, { verified: 3 }, JSON.stringify(j.cabinets));
  assert.match(j.cabinets[0].detail, /read back/);
  const after = await runBatch(t1, { siteId: dallas });
  assert.equal(problemGroups(after).length, 0, JSON.stringify(after.groups));
  for (const name of ["Uptown Sync", "Uptown Exam 1", "Uptown Exam 2"]) assert.ok(!(await openAlert((await cab(name)).id)), `${name}: the baseline alert closed`);
});

test("a cabinet with no DHCP lease: the diagnosis offers a lease renewal; one click (Tier 1) renews it, the answer says the new address, and the next diagnosis is clean", async () => {
  const t1 = await account("tier1");
  const fd = await cab("Front Desk");
  const started = await call("POST", `/api/cabinets/${fd.id}/diagnose/network`, {}, t1);
  const d = await (async () => { for (;;) { const r = (await call("GET", `/api/diagnoses/${started.body.diagnosisId}`, undefined, t1)).body; if (r.state !== "running") return r; await new Promise(r => setTimeout(r, 100)); } })();
  const f = d.findings.find((x: { id: string }) => x.id === "ip-12");
  assert.equal(f.severity, "problem");
  assert.match(f.evidence[0], /169\.254/);
  assert.equal(f.action.kind, "renew_lease");
  assert.match(f.action.label, /Renew the DHCP lease/);
  const params = { interfaceIndex: f.action.interfaceIndex };
  // Renewing a lease changes no setting, so it needs no code: Tier 1 may do it. Anything else in the parameters is refused.
  for (const bad of [{}, { ...params, server: "10.0.0.1" }, { interfaceIndex: "12; ipconfig /release" }, { interfaceIndex: -1 }])
    assert.equal((await call("POST", `/api/cabinets/${fd.id}/commands`, { operation: "network.renewLease", params: bad }, t1)).status, 400, JSON.stringify(bad));
  const issued = await call("POST", `/api/cabinets/${fd.id}/commands`, { operation: "network.renewLease", params }, t1);
  assert.equal(issued.status, 202, JSON.stringify(issued.body));
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise(r => setTimeout(r, 50)))
    if ((await db.app.query("SELECT status FROM commands WHERE id = $1", [issued.body.commandId])).rows[0].status === "succeeded") break;
  const out = (await db.app.query("SELECT result FROM commands WHERE id = $1", [issued.body.commandId])).rows[0].result.output;
  assert.equal(out.result, "renewed");
  assert.match(out.addressBefore, /^169\.254\./);
  assert.ok(!out.addressAfter.startsWith("169.254."));
  const again = await runBatch(t1, { cabinetIds: [fd.id] });
  assert.equal(problemGroups(again).length, 0, JSON.stringify(again.groups));
  assert.ok(!(await openAlert(fd.id)));
  // The cabinet list shows the address it now has (read by that diagnosis).
  assert.equal((await db.app.query("SELECT ipv4 FROM cabinets WHERE id = $1", [fd.id])).rows[0].ipv4, out.addressAfter);
});

test("renewing leases for several cabinets is a fleet job with the password, read back from each; a fixed-address cabinet answers not_dhcp and is not touched", async () => {
  const t1 = await account("tier1");
  const fd = await cab("Front Desk");
  // Break it again the way the demo does: no lease, a 169.254 address.
  const baseline = (await db.app.query("SELECT s.network_baseline AS b FROM sites s WHERE s.id = $1", [fd.site_id])).rows[0].b;
  await db.app.query("UPDATE cabinets SET demo_scenario = 'net_dhcp_failed', demo_net = $2 WHERE id = $1", [fd.id, JSON.stringify(initialNet("net_dhcp_failed", baseline, "10.33.8", 0))]);
  const b = await runBatch(t1, { cabinetIds: [fd.id] });
  const g = b.groups.find((x: { kind: string | null }) => x.kind === "renew_lease");
  assert.ok(g, JSON.stringify(b.groups));
  assert.equal(g.operation, "network.renewLease");
  const j = await runJob(t1, "network.renewLease", [fd.id]);
  assert.deepEqual(j.counts, { verified: 1 }, JSON.stringify(j.cabinets));
  assert.match(j.cabinets[0].detail, /read back/);
  // A fixed-address cabinet (Triage) in a job of its own: no diagnosis finding for a lease, so the preview skips it.
  const triage = await cab("Triage");
  await runBatch(t1, { cabinetIds: [triage.id] });
  const pre = (await call("POST", "/api/fleet-operations/preview", { operation: "network.renewLease", cabinetIds: [triage.id] }, t1)).body;
  assert.equal(pre.change, 0);
});

test("a fixed address from another network (DHCP site) and a wrong gateway (fixed-address site) each get their own fix, run as jobs", async () => {
  const t1 = await account("tier1"), t2 = await account("tier2");
  const lab = await cab("Lab"), triage = await cab("Triage");
  const b1 = await runBatch(t1, { cabinetIds: [lab.id, triage.id] });
  const lg = b1.groups.find((g: { key: string }) => g.key.startsWith("baseline-subnet"));
  assert.equal(lg.kind, "use_dhcp");
  assert.match(lg.affected[0], /Lab/);
  const tg = b1.groups.find((g: { key: string }) => g.key.startsWith("baseline-gateway"));
  assert.equal(tg.kind, "set_static");
  assert.equal(tg.targets[0].label, "Set the gateway to 172.20.10.1");
  // Both are network.setIp, each cabinet gets its own change from its own diagnosis, and a job covers one site: two sites, two jobs.
  const jobId = randomUUID();
  const t = await call("POST", "/api/auth/confirm-password", { password: t2.password, action: "fleet.job", target: jobId, paramsHash: paramsHash({ operation: "network.setIp", cabinetIds: [lab.id, triage.id], batchSize: 10 }) }, t2);
  const mixed = await call("POST", "/api/fleet-operations/jobs", { jobId, operation: "network.setIp", cabinetIds: [lab.id, triage.id], batchSize: 10, stepUpToken: t.body.token }, t2);
  assert.equal(mixed.status, 409, JSON.stringify(mixed.body));
  assert.equal(mixed.body.error, "one_site_only");
  for (const one of [lab, triage]) {
    const j = await runJob(t2, "network.setIp", [one.id]);
    assert.deepEqual(j.counts, { verified: 1 }, JSON.stringify(j.cabinets));
  }
  // What was wrong with the two cabinets is gone; the sync cabinet's firewall (a different site problem) is still there until it is fixed.
  const b2 = await runBatch(t1, { cabinetIds: [lab.id, triage.id] });
  assert.deepEqual(b2.groups.filter((g: { key: string }) => g.key.startsWith("baseline-")), [], JSON.stringify(b2.groups));
});

test("the sync cabinet's firewall: a site diagnosis names it once with the one cabinet to fix; the fix is the firewall policy; a link negotiated at 100 Mbps has no remote fix", async () => {
  const t1 = await account("tier1");
  const ny = await siteOf("New York");
  const b = await runBatch(t1, { siteId: ny });
  const g = b.groups.find((x: { key: string }) => x.key === "sync-firewall|apply_policy");
  assert.ok(g, JSON.stringify(b.groups.map((x: { key: string }) => x.key)));
  assert.equal(g.targets.length, 1);
  assert.equal(g.targets[0].cabinetName, "Pharmacy Sync");
  assert.ok(g.affected.length >= 3);
  const j = await runJob(t1, "firewall.applyPolicy", [g.targets[0].cabinetId]);
  assert.deepEqual(j.counts, { verified: 1 });
  const again = await runBatch(t1, { siteId: ny });
  assert.ok(!again.groups.some((x: { key: string }) => x.key.startsWith("sync-firewall")), JSON.stringify(again.groups.map((x: { key: string }) => x.key)));
  // Denver: the offline cabinet is listed, not waited for; the 100 Mbps link is a warning with advice and no button.
  const denver = await runBatch(t1, { siteId: await siteOf("Denver") });
  assert.equal(denver.cabinets.find((c: { name: string }) => c.name === "Step-down").state, "offline");
  const slow = denver.groups.find((x: { key: string }) => x.key.startsWith("speed"));
  assert.equal(slow.kind, null);
  assert.equal(slow.severity, "warning");
  assert.match(slow.fix, /patch cable/);
});

test("a network fix needs a current diagnosis: without one, or when nothing needs fixing, the cabinet is skipped and nothing is sent", async () => {
  const t2 = await account("tier2");
  const [ok1] = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE name = 'Uptown Exam 3' AND demo_scenario IS NOT NULL")).rows;
  const none = (await call("POST", "/api/fleet-operations/preview", { operation: "network.setDns", cabinetIds: [ok1!.id] }, t2)).body;
  assert.equal(none.change, 0);
  assert.match(none.cabinets[0].skip, /nothing this change would fix|diagnosis/);
  await db.app.query("UPDATE diagnoses SET finished_at = now() - interval '2 hours' WHERE cabinet_id = $1", [ok1!.id]);
  assert.match((await call("POST", "/api/fleet-operations/preview", { operation: "network.setDns", cabinetIds: [ok1!.id] }, t2)).body.cabinets[0].skip, /last 30 minutes/);
});

test("the site baseline: Tier 2 sets it with a code bound to the exact baseline; Tier 1 cannot; hostile values are refused; the audit log records it", async () => {
  const t1 = await account("tier1"), t2 = await account("tier2");
  const site = await siteOf("Austin");
  const baseline = { addressing: "dhcp", prefixLength: 24, gateway: "192.168.40.1", dnsServers: ["192.168.40.10", "192.168.40.11"] };
  const put = (a: Account, body: unknown) => call("PUT", `/api/sites/${site}/network-baseline`, body, a);
  assert.equal((await put(t1, { baseline, stepUpToken: "A".repeat(43) })).status, 403);
  for (const bad of [{ ...baseline, gateway: "999.1.1.1" }, { ...baseline, dnsServers: [] }, { ...baseline, prefixLength: 2 }, { ...baseline, proxy: "x" }, { ...baseline, dnsServers: ["1.1.1.1", "1.1.1.1"] }])
    assert.equal((await put(t2, { baseline: bad, stepUpToken: "A".repeat(43) })).status, 400, JSON.stringify(bad));
  const other = await codeToken(t2, "site.network_baseline", site, { baseline: { ...baseline, gateway: "192.168.40.254" } });
  assert.equal((await put(t2, { baseline, stepUpToken: other })).status, 403, "a code confirmed for another baseline");
  assert.equal((await put(t2, { baseline, stepUpToken: await codeToken(t2, "site.network_baseline", site, { baseline }) })).status, 200);
  assert.deepEqual((await call("GET", `/api/fleet/sites/${site}`, undefined, t1)).body.networkBaseline, baseline);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'site.network_baseline' AND target_id = $1", [site])).rows[0].n, 1);
  assert.equal((await put(t2, { baseline: null, stepUpToken: await codeToken(t2, "site.network_baseline", site, { baseline: null }) })).status, 200);
});

test("hostile and excessive diagnosis requests are refused; one batch at a time per person; offline cabinets do not hold it up", async () => {
  const t1 = await account("tier1");
  const ids = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE demo_scenario IS NOT NULL ORDER BY name LIMIT 61")).rows.map(r => r.id);
  assert.equal((await call("POST", "/api/diagnose/network", { cabinetIds: ids }, t1)).status, 400, "more than 60 cabinets");
  for (const body of [{}, { cabinetIds: [] }, { siteId: "../x" }, { cabinetIds: [ids[0], ids[0]] }, { siteId: randomUUID(), cabinetIds: [ids[0]] }, { cabinetIds: ids.slice(0, 2), x: 1 }])
    assert.equal((await call("POST", "/api/diagnose/network", body, t1)).status, 400, JSON.stringify(body).slice(0, 60));
  assert.equal((await call("POST", "/api/diagnose/network", { siteId: randomUUID() }, t1)).status, 404);
  assert.equal((await call("POST", "/api/diagnose/network", { cabinetIds: [randomUUID()] }, t1)).status, 404);
  assert.equal((await call("POST", "/api/diagnose/network", { siteId: await siteOf("Austin") })).status, 401);
  // Two at once from the same person: the second waits for the first.
  const quiet = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE demo_scenario = 'incident_loop' LIMIT 1")).rows[0]!.id;
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = now() WHERE id = $1", [quiet]);   // looks online, never answers
  const first = await call("POST", "/api/diagnose/network", { cabinetIds: [quiet] }, t1);
  assert.equal(first.status, 202);
  assert.equal((await call("POST", "/api/diagnose/network", { siteId: await siteOf("Austin") }, t1)).status, 429);
  await db.app.query("UPDATE diagnoses SET state = 'failed', finished_at = now() WHERE state = 'running'");
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = now() - interval '20 hours' WHERE id = $1", [quiet]);
});
