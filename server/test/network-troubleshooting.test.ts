// Network troubleshooting end to end (docs/spec/16-network-troubleshooting.md): the site baseline, the diagnosis on one cabinet,
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
import { paramsHash } from "../src/auth/canonical.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { DemoSimulator, enableDemo } from "../src/demo/demo.js";
import { initialNet } from "../src/demo/network.js";
import type { NetworkBaseline } from "../src/diagnose/network-findings.js";
import { ISSUE } from "../src/services/rules.js";
import { preview, runJob as runJobToEnd, startJob } from "../src/services/fleet-jobs.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { raiseBaselineAlert } from "../src/diagnose/network.js";
import { createPool } from "../src/db/db.js";
import { ConsoleHarness, ORIGIN, type Account, type Role } from "./console-harness.js";
import { createTestDatabase, type TestDatabase, startFeed } from "./database.js";
import { tempDir } from "./helpers.js";

const TIMING = { pollMs: 50, verifyMs: 5_000 };
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let sim: DemoSimulator;
const secrets = new SecretBox(randomBytes(32).toString("base64"));

const h = new ConsoleHarness(secrets);
const account = (role: Role) => h.account(role);
const call = h.call.bind(h);
const codeToken = h.codeToken.bind(h);
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
  const planDigest = (await preview(db.app, { role: a.role }, operation as Parameters<typeof preview>[2], cabinetIds)).planDigest;
  const t = await call("POST", "/api/auth/confirm-password", { password: a.password, action: "fleet.job", target: jobId, paramsHash: paramsHash({ operation, cabinetIds, batchSize, planDigest }) }, a);
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const started = await call("POST", "/api/fleet-operations/jobs", { jobId, operation, cabinetIds, batchSize, planDigest, stepUpToken: t.body.token }, a);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (const end = Date.now() + 60_000; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    const j = (await call("GET", `/api/fleet-operations/jobs/${jobId}`, undefined, a)).body;
    if (j.state !== "running") return j;
  }
  assert.fail("the job did not finish");
}
const cab = async (name: string) => (await db.app.query<{ id: string; site_id: string }>("SELECT id, site_id FROM cabinets WHERE name = $1 AND demo_scenario IS NOT NULL", [name])).rows[0]!;
const siteOf = async (name: string) => (await db.app.query<{ id: string }>("SELECT s.id FROM sites s JOIN clients c ON c.id = s.client_id WHERE c.demo = 1 AND s.name LIKE $1", [name + "%"])).rows[0]!.id;
const openAlert = async (cabinetId: string) => (await db.app.query("SELECT 1 AS x FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'", [cabinetId, ISSUE.networkBaseline])).rows.length > 0;
const problemGroups = (b: { groups: { severity: string }[] }) => b.groups.filter(g => g.severity === "problem");

test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => h.clock, fleetJobTiming: TIMING });
  h.db = db; h.app = app;
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
  assert.equal((await call("POST", "/api/fleet-operations/jobs", { jobId, operation: "network.setDns", cabinetIds: ids, batchSize: 10, planDigest: "0".repeat(64), stepUpToken: forT1.body.token }, t1)).status, 403);
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
    if ((await db.app.query<{ status: string }>("SELECT status FROM commands WHERE id = $1", [issued.body.commandId])).rows[0]?.status === "succeeded") break;
  const out = (await db.app.query<{ result: { output: any } }>("SELECT result FROM commands WHERE id = $1", [issued.body.commandId])).rows[0]!.result.output;
  assert.equal(out.result, "renewed");
  assert.match(out.addressBefore, /^169\.254\./);
  assert.ok(!out.addressAfter.startsWith("169.254."));
  const again = await runBatch(t1, { cabinetIds: [fd.id] });
  assert.equal(problemGroups(again).length, 0, JSON.stringify(again.groups));
  assert.ok(!(await openAlert(fd.id)));
  // The cabinet list shows the address it now has (read by that diagnosis).
  assert.equal((await db.app.query<{ ipv4: string }>("SELECT ipv4 FROM cabinets WHERE id = $1", [fd.id])).rows[0]!.ipv4, out.addressAfter);
});

test("renewing leases for several cabinets is a fleet job with the password, read back from each; a fixed-address cabinet answers not_dhcp and is not touched", async () => {
  const t1 = await account("tier1");
  const fd = await cab("Front Desk");
  // Break it again the way the demo does: no lease, a 169.254 address.
  const baseline = (await db.app.query<{ network_baseline: any }>("SELECT s.network_baseline FROM sites s WHERE s.id = $1", [fd.site_id])).rows[0]!.network_baseline;
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
  const t = await call("POST", "/api/auth/confirm-password", { password: t2.password, action: "fleet.job", target: jobId, paramsHash: paramsHash({ operation: "network.setIp", cabinetIds: [lab.id, triage.id], batchSize: 10, planDigest: "0".repeat(64) }) }, t2);
  const mixed = await call("POST", "/api/fleet-operations/jobs", { jobId, operation: "network.setIp", cabinetIds: [lab.id, triage.id], batchSize: 10, planDigest: "0".repeat(64), stepUpToken: t.body.token }, t2);
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
  await db.app.query("UPDATE diagnoses SET finished_at = DATEADD(hour, -2, SYSUTCDATETIME()) WHERE cabinet_id = $1", [ok1!.id]);
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
  assert.equal((await db.app.query<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE action = 'site.network_baseline' AND target_id = $1", [site])).rows[0]!.n, 1);
  assert.equal((await put(t2, { baseline: null, stepUpToken: await codeToken(t2, "site.network_baseline", site, { baseline: null }) })).status, 200);
});

test("hostile and excessive diagnosis requests are refused; one batch at a time per person; offline cabinets do not hold it up", async () => {
  const t1 = await account("tier1");
  const ids = (await db.app.query<{ id: string }>("SELECT TOP (61) id FROM cabinets WHERE demo_scenario IS NOT NULL ORDER BY name")).rows.map(r => r.id);
  assert.equal((await call("POST", "/api/diagnose/network", { cabinetIds: ids }, t1)).status, 400, "more than 60 cabinets");
  for (const body of [{}, { cabinetIds: [] }, { siteId: "../x" }, { cabinetIds: [ids[0], ids[0]] }, { siteId: randomUUID(), cabinetIds: [ids[0]] }, { cabinetIds: ids.slice(0, 2), x: 1 }])
    assert.equal((await call("POST", "/api/diagnose/network", body, t1)).status, 400, JSON.stringify(body).slice(0, 60));
  assert.equal((await call("POST", "/api/diagnose/network", { siteId: randomUUID() }, t1)).status, 404);
  assert.equal((await call("POST", "/api/diagnose/network", { cabinetIds: [randomUUID()] }, t1)).status, 404);
  assert.equal((await call("POST", "/api/diagnose/network", { siteId: await siteOf("Austin") })).status, 401);
  // Two at once from the same person: the second waits for the first.
  const quiet = (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM cabinets WHERE demo_scenario = 'incident_loop'")).rows[0]!.id;
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME() WHERE id = $1", [quiet]);   // looks online, never answers
  const first = await call("POST", "/api/diagnose/network", { cabinetIds: [quiet] }, t1);
  assert.equal(first.status, 202);
  assert.equal((await call("POST", "/api/diagnose/network", { siteId: await siteOf("Austin") }, t1)).status, 429);
  await db.app.query("UPDATE diagnoses SET state = 'failed', finished_at = SYSUTCDATETIME() WHERE state = 'running'");
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(hour, -20, SYSUTCDATETIME()) WHERE id = $1", [quiet]);
});

test("asking again for the same cabinets while a check is running joins it; a different set waits", async () => {
  const t1 = await account("tier1");
  const dallas = await siteOf("Dallas Uptown"), austin = await siteOf("Austin North");
  const first = await call("POST", "/api/diagnose/network", { siteId: dallas }, t1);
  const again = await call("POST", "/api/diagnose/network", { siteId: dallas }, t1);
  assert.equal(first.status, 202);
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.equal(again.body.batchId, first.body.batchId, "the second click joins the running check");
  assert.equal((await call("POST", "/api/diagnose/network", { siteId: austin }, t1)).status, 429, "a different set waits for the first");
  for (const end = Date.now() + 60_000; Date.now() < end; await new Promise(r => setTimeout(r, 100)))
    if ((await call("GET", `/api/diagnose/network/batches/${first.body.batchId}`, undefined, t1)).body.state === "done") break;
});

test("a diagnosis is shown as done only once its baseline alert is settled: a reader never sees it done with the alert it closes still open", { timeout: 60_000 }, async () => {
  const t1 = await account("tier1");
  const k = await cab("Uptown Exam 3");   // its settings match the site's baseline
  await raiseBaselineAlert(db.app, k.id, ["left open for this test"]);
  assert.ok(await openAlert(k.id));
  // The holder and the probe below lock and look up the alert by its id, a seek that reads that row alone. Found by cabinet and issue
  // type, the holder's update-lock read could block on another cabinet's alert held by other work, while the probe, which skips locked
  // rows, saw this one free and waited out its limit.
  const alertId = (await db.app.query<{ id: string }>("SELECT id FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'",
    [k.id, ISSUE.networkBaseline])).rows[0]!.id;
  // A diagnosis of this cabinet that finished a moment ago, as the batch in the test above leaves when it takes under a second.
  await db.app.query("INSERT INTO diagnoses (id, cabinet_id, kind, run_by, state, finished_at) VALUES ($1, $2, 'network', $3, 'done', SYSUTCDATETIME())",
    [randomUUID(), k.id, t1.id]);
  // The holder waits for this test's own diagnosis: one that was already there does not end its wait.
  const before = JSON.stringify((await db.app.query<{ id: string }>("SELECT id FROM diagnoses WHERE cabinet_id = $1", [k.id])).rows.map(r => r.id));
  // Another connection holds the alert row until the diagnosis says it is done (at most 7 s, inside the pools' 10 s limit). With the
  // alert settled first, the diagnosis cannot say done while the row is held; with done written first, it does, with the alert open.
  const holder = await createPool(db.ownerUrl, { max: 1, requestTimeoutMs: 30_000 });
  try {
    const held = holder.query<{ done_while_held: number; held: string | null }>(`BEGIN TRAN;
        DECLARE @held uniqueidentifier;
        SELECT @held = id FROM alerts WITH (UPDLOCK, ROWLOCK) WHERE id = $2 AND state <> 'resolved';
        DECLARE @until datetime2 = DATEADD(second, 7, SYSUTCDATETIME());
        WHILE SYSUTCDATETIME() < @until AND NOT EXISTS (SELECT 1 FROM diagnoses WITH (READUNCOMMITTED) WHERE cabinet_id = $1 AND id NOT IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($3)) AND state = 'done')
          WAITFOR DELAY '00:00:00.100';
        SELECT CASE WHEN EXISTS (SELECT 1 FROM diagnoses WITH (READUNCOMMITTED) WHERE cabinet_id = $1 AND id NOT IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($3)) AND state = 'done') THEN 1 ELSE 0 END AS done_while_held, @held AS held;
        COMMIT;`, [k.id, alertId, before]);
    // Start the diagnosis only once the holder holds the row. A fixed wait was not enough under load: when the holder was late
    // taking the row, the diagnosis closed the alert and said done first, the holder then held nothing and reported done_while_held = 1.
    // An update-lock read that skips locked rows finds the alert only while nobody holds it.
    const stillFree = async () => (await db.app.query("SELECT id FROM alerts WITH (UPDLOCK, READPAST) WHERE id = $1 AND state <> 'resolved'", [alertId])).rows.length > 0;
    for (const end = Date.now() + 10_000; await stillFree(); await new Promise(r => setTimeout(r, 50)))
      if (Date.now() > end) assert.fail("the holder never took the alert row");
    const started = await call("POST", `/api/cabinets/${k.id}/diagnose/network`, {}, t1);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const heldRows = (await held).rows;
    assert.ok(heldRows[0]?.held, "the holder held the alert row");
    assert.equal(heldRows[0]?.done_while_held, 0, "the diagnosis said done while its alert was still being settled");
    for (const end = Date.now() + 30_000; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
      const d = (await call("GET", `/api/diagnoses/${started.body.diagnosisId}`, undefined, t1)).body;
      if (d.state === "running") continue;
      assert.equal(d.state, "done", JSON.stringify(d.failure));
      assert.equal(await openAlert(k.id), false, "done, and the alert it found matching is closed");
      return;
    }
    assert.fail("the diagnosis did not finish");
  } finally {
    await holder.end();
  }
});

// The permission a fleet job runs under is re-read for every batch, so taking a person's role away stops the rest of the job
// instead of letting it keep sending (docs/spec/02-security-model.md, roles; the batch check in services/fleet-jobs.ts).
// Three Dallas cabinets put back into a wrong-DNS state and then diagnosed. A fleet change of this kind must come from a current
// diagnosis, and earlier tests in this file repair Dallas, so a test here may not depend on the state it inherits: it sets the
// state it needs. The cabinets' own reported settings are what the diagnosis reads.
const dnsTargets = async () => {
  const site = await siteOf("Dallas");
  const baseline = (await db.app.query<{ network_baseline: NetworkBaseline }>("SELECT s.network_baseline FROM sites s WHERE s.id = $1", [site])).rows[0]!.network_baseline;
  // The site's own address space: a cabinet put outside it would be diagnosed with a subnet problem instead of the DNS one the job fixes.
  const subnet = baseline.gateway!.split(".").slice(0, 3).join(".");
  const rows = (await db.app.query<{ id: string }>("SELECT TOP 3 id FROM cabinets WHERE site_id = $1 AND demo_scenario IS NOT NULL ORDER BY name", [site])).rows;
  assert.equal(rows.length, 3, "three Dallas cabinets to aim the job at");
  for (const [i, r] of rows.entries())
    await db.app.query("UPDATE cabinets SET demo_scenario = 'net_dns_wrong', demo_net = $2 WHERE id = $1", [r.id, JSON.stringify(initialNet("net_dns_wrong", baseline, subnet, i))]);
  const b = await runBatch(await account("tier2"), { siteId: site });
  const g = b.groups.find((x: { key: string }) => x.key === "baseline-dns|set_dns");
  assert.ok(g, JSON.stringify(b.groups.map((x: { key: string }) => x.key)));
  const ids = g.targets.map((x: { cabinetId: string }) => x.cabinetId).slice(0, 3);
  assert.equal(ids.length, 3, "three cabinets for the job to work through");
  return ids;
};

test("a job whose starter is demoted before its first batch sends nothing at all", async () => {
  const t2 = await account("tier2");
  const ids = await dnsTargets();
  const jobId = randomUUID(), batchSize = 1;
  const planDigest = (await preview(db.app, { role: "tier2" }, "network.setDns", ids)).planDigest;
  await startJob(db.app, { userId: t2.id, role: "tier2" }, { jobId, planDigest, operation: "network.setDns", cabinetIds: ids, batchSize,
    stepUpToken: await issueStepUpToken(db.app, t2.id, "fleet.job", jobId, paramsHash({ operation: "network.setDns", cabinetIds: ids, batchSize, planDigest })) });
  await db.app.query("UPDATE users SET role = 'tier1' WHERE id = $1", [t2.id]);
  await runJobToEnd(db.app, jobId, TIMING);
  assert.equal(Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE bulk_id = $1", [jobId])).rows[0]!.n), 0, "nothing was sent");
  const targets = (await db.app.query<{ state: string; detail: string }>("SELECT state, detail FROM fleet_job_targets WHERE job_id = $1", [jobId])).rows;
  assert.equal(targets.length, 3);
  assert.ok(targets.every(t => t.state === "skipped" && /role this operation needs/.test(t.detail)), JSON.stringify(targets));
});

test("a demotion between two batches stops the rest, and the batch already sent still finishes", async () => {
  const t1 = await account("tier1"), t2 = await account("tier2");
  const ids = await dnsTargets();
  const jobId = randomUUID(), batchSize = 1;
  const planDigest = (await preview(db.app, { role: "tier2" }, "network.setDns", ids)).planDigest;
  await startJob(db.app, { userId: t2.id, role: "tier2" }, { jobId, planDigest, operation: "network.setDns", cabinetIds: ids, batchSize,
    stepUpToken: await issueStepUpToken(db.app, t2.id, "fleet.job", jobId, paramsHash({ operation: "network.setDns", cabinetIds: ids, batchSize, planDigest })) });
  // The runner is driven here rather than by the route, so the demotion can land between two batches.
  const running = runJobToEnd(db.app, jobId, TIMING);
  const count = async () => Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE bulk_id = $1", [jobId])).rows[0]!.n);
  for (const end = Date.now() + 30_000; (await count()) < 1; await new Promise(r => setTimeout(r, 25))) assert.ok(Date.now() < end, "the first batch was never sent");
  // One statement: the sent command fails and the role goes at the same instant, so no later batch can slip through.
  await db.app.query("UPDATE commands SET status = 'failed', result_at = SYSUTCDATETIME() WHERE bulk_id = $1 AND status = 'queued'; UPDATE users SET role = 'tier1' WHERE id = $2", [jobId, t2.id]);
  await running;
  assert.equal(await count(), 1, "only what was already sent");
  const targets = (await db.app.query<{ state: string; detail: string }>("SELECT state, detail FROM fleet_job_targets WHERE job_id = $1 ORDER BY [position]", [jobId])).rows;
  assert.equal(targets.length, 3);
  assert.ok(targets.slice(1).every(t => t.state === "skipped" && /role this operation needs/.test(t.detail)), JSON.stringify(targets));
  assert.equal((await call("GET", `/api/fleet-operations/jobs/${jobId}`, undefined, t1)).body.state, "done", "the job ends rather than sitting running");
});
