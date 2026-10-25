// End to end: the real agent connection code (agent/tests/Cabinet.Agent.TestAgent)
// against this server and PostgreSQL. Runs when TEST_AGENT_DLL points at the built
// test agent; CI sets it. Milestone 2 is done when the first test passes; the second
// is milestone 4's done-when, driven through the agent's real monitors and event queue.
import { setWatched } from "../src/services/watched-services.js";
import { appsHash, normalizeEntries, rawEntry } from "../src/services/approved-apps.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { connect, createServer } from "node:net";
import { TrustList } from "../src/packages/trust.js";
import { approvePackage, receiveUpload, startUpload } from "../src/services/packages.js";
import { pe, TestPki, zip } from "./package-pki.js";
import { asOwner } from "./database.js";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { CommandNotifier } from "../src/agent-api/notifier.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { buildAgentApi } from "../src/agent-api/server.js";
import { developmentIssuingKey, developmentServerCertificate } from "../src/pki/issuing.js";
import { listCabinets, revokeCabinet } from "../src/services/cabinets.js";
import { commandRecord, issueCommand } from "../src/services/commands.js";
import { approveEnrollment, createBootstrapToken, pendingRequests } from "../src/services/enrollment.js";
import { verifyAuditChain } from "../src/db/db.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { decideRule, ISSUE, proposeRule } from "../src/services/rules.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

const dll = process.env.TEST_AGENT_DLL;

test("a real agent enrolls, is approved, stays online, runs a command, and is refused once revoked", { skip: !dll && "set TEST_AGENT_DLL to run", timeout: 120_000 }, async () => {
  const db: TestDatabase = await createTestDatabase();
  const dir = tempDir();
  const key = await developmentIssuingKey(dir);
  const feed = new NotificationFeed(db.app, 50);
  await feed.start();
  const notifier = new CommandNotifier(feed);
  await notifier.start();
  const api: FastifyInstance = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, tls: await developmentServerCertificate(key, dir, ["localhost"]), longPollMs: 3000, logger: false });
  await api.listen({ host: "127.0.0.1", port: 0 });
  const port = (api.server.address() as { port: number }).port;
  const admin = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'e2e.admin', 'E2E Admin', 'admin')", [admin]);

  const state = join(dir, "agent-state");
  mkdirSync(state);
  const caPath = join(dir, "platform-ca.pem");
  writeFileSync(caPath, key.certificatePem);
  writeFileSync(join(state, "bootstrap-token"), (await createBootstrapToken(db.app, admin)).token);

  const lines: string[] = [];
  const agent: ChildProcess = spawn("dotnet", [dll!, `https://localhost:${port}`, caPath, state], { stdio: ["ignore", "pipe", "pipe"] });
  agent.stdout!.on("data", d => lines.push(...String(d).split("\n").filter(Boolean)));
  agent.stderr!.on("data", d => lines.push(...String(d).split("\n").filter(Boolean)));
  const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 200))) if (await check()) return;
    assert.fail(`timed out waiting for ${what}. Agent log:\n${lines.join("\n")}`);
  };
  const logged = (text: string) => () => lines.some(l => l.includes(text));

  try {
    await until("the enrollment request", logged("waiting for an administrator"));
    const [pending] = await pendingRequests(db.app);
    assert.equal(pending?.fingerprints.hostname, "TEST-AGENT");

    const { cabinetId } = await approveEnrollment(db.app, key, pending!.id, { clientName: "E2E Client", siteName: "Lab", cabinetName: "Test agent", role: "standalone" }, admin);
    await until("enrollment", logged(`Enrolled as cabinet ${cabinetId}`));
    await until("the cabinet online", async () => (await listCabinets(db.app)).some(c => c.id === cabinetId && c.online));
    const firstBeat = (await listCabinets(db.app)).find(c => c.id === cabinetId)!.lastHeartbeatAt!;
    await until("a later heartbeat (stays online)", async () => (await listCabinets(db.app)).find(c => c.id === cabinetId)!.lastHeartbeatAt! > firstBeat, 10_000);

    const info = await issueCommand(db.app, admin, cabinetId, "system.info", {});
    await until("the system.info result", async () => (await commandRecord(db.app, info.commandId))?.status === "succeeded");
    const record = await commandRecord(db.app, info.commandId);
    assert.equal((record!.result!.output as { hostname: string }).hostname, "TEST-AGENT");

    // The agent's own checks still apply to server commands: TCP to a port its configuration does not allow is rejected.
    const tcp = await issueCommand(db.app, admin, cabinetId, "network.test", { target: "gateway", method: "tcp", port: 445 });
    await until("the rejection", async () => (await commandRecord(db.app, tcp.commandId))?.status === "rejected");
    assert.equal((await commandRecord(db.app, tcp.commandId))!.result!.error!.code, "invalid_params");

    await revokeCabinet(db.app, cabinetId, admin);
    await until("the agent to be refused", logged("refused this cabinet's certificate"));
    assert.equal((await listCabinets(db.app)).find(c => c.id === cabinetId)!.status, "removed");
    assert.equal((await verifyAuditChain(db.app)).ok, true);
  } finally {
    agent.kill("SIGINT");
    await api.close();
    await notifier.stop();
    feed.stop();
    await db.drop();
  }
});

test("the agent's monitors: a forced scanner disconnect raises Fingerprint scanner problem; an unrecognized error is mapped, approved, and raises it next time",
  { skip: !dll && "set TEST_AGENT_DLL to run", timeout: 120_000 }, async () => {
  const db: TestDatabase = await createTestDatabase();
  const dir = tempDir();
  const key = await developmentIssuingKey(dir);
  const feed = new NotificationFeed(db.app, 50);
  await feed.start();
  const notifier = new CommandNotifier(feed);
  await notifier.start();
  const api: FastifyInstance = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, tls: await developmentServerCertificate(key, dir, ["localhost"]), longPollMs: 3000, logger: false });
  await api.listen({ host: "127.0.0.1", port: 0 });
  const port = (api.server.address() as { port: number }).port;
  const admin = randomUUID();
  const tier2 = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'e2e.admin', 'E2E Admin', 'admin'), ($2, 'e2e.tier2', 'E2E Tier 2', 'tier2')", [admin, tier2]);
  const state = join(dir, "agent-state");
  const simulate = join(state, "simulate");
  mkdirSync(simulate, { recursive: true });
  const caPath = join(dir, "platform-ca.pem");
  writeFileSync(caPath, key.certificatePem);
  writeFileSync(join(state, "bootstrap-token"), (await createBootstrapToken(db.app, admin)).token);
  const scannerId = "USB\\VID_1234&PID_5678";
  const scanner = { instanceId: "USB\\VID_1234&PID_5678\\5&2A1B&0&3", name: "Fingerprint Reader", present: true, problemCode: 0, hardwareIds: [scannerId] };
  writeFileSync(join(simulate, "devices.json"), JSON.stringify([scanner]));

  const lines: string[] = [];
  const agent: ChildProcess = spawn("dotnet", [dll!, `https://localhost:${port}`, caPath, state], { stdio: ["ignore", "pipe", "pipe"] });
  agent.stdout!.on("data", d => lines.push(...String(d).split("\n").filter(Boolean)));
  agent.stderr!.on("data", d => lines.push(...String(d).split("\n").filter(Boolean)));
  const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 200))) if (await check()) return;
    assert.fail(`timed out waiting for ${what}. Agent log:\n${lines.join("\n")}`);
  };
  const openAlerts = async (cabinetId: string) => (await db.app.query<{ id: string; issue_type_id: string | null; title: string; occurrences: number }>(
    "SELECT id, issue_type_id, title, occurrences FROM alerts WHERE cabinet_id = $1 AND state <> 'resolved' ORDER BY created_at", [cabinetId])).rows;
  let record = 100;
  const logError = () => {
    record++;
    writeFileSync(join(simulate, "events-System.json"), JSON.stringify([{ recordId: record, time: new Date().toISOString(), level: "error",
      source: "Biometric Lock Driver", eventId: 4242, firstLine: "Fingerprint sensor timed out." }]));
  };

  try {
    await until("the enrollment request", () => lines.some(l => l.includes("waiting for an administrator")));
    const [pending] = await pendingRequests(db.app);
    const { cabinetId } = await approveEnrollment(db.app, key, pending!.id, { clientName: "E2E Client", siteName: "Lab", cabinetName: "Monitored", role: "standalone" }, admin);
    // The scanner's hardware ID is set in the console; the agent learns it from its heartbeat answer.
    await db.app.query("UPDATE cabinets SET scanner_hardware_ids = $2 WHERE id = $1", [cabinetId, JSON.stringify([scannerId])]);
    await until("the scanner ID to reach the agent", () => {
      try { return require_("monitor-settings.json").includes("VID_1234"); } catch { return false; }
    });
    await new Promise(r => setTimeout(r, 1500)); // a healthy look first
    assert.deepEqual(await openAlerts(cabinetId), []);

    // Force the disconnect.
    writeFileSync(join(simulate, "devices.json"), "[]");
    await until("Fingerprint scanner problem", async () => (await openAlerts(cabinetId)).some(a => a.issue_type_id === ISSUE.scanner));
    // Plug it back in: the alert resolves itself.
    writeFileSync(join(simulate, "devices.json"), JSON.stringify([scanner]));
    await until("the scanner alert to resolve", async () => !(await openAlerts(cabinetId)).some(a => a.issue_type_id === ISSUE.scanner));

    // An error nobody has seen before is unrecognized.
    logError();
    await until("the unrecognized alert", async () => (await openAlerts(cabinetId)).some(a => a.issue_type_id === null && a.title.includes("4242")));
    const unrecognized = (await openAlerts(cabinetId)).find(a => a.issue_type_id === null)!;

    // Map it to Fingerprint scanner problem (Tier 2 proposes, an Admin approves, both with step-up).
    const proposal = await proposeRule(db.app, { userId: tier2, role: "tier2" }, ISSUE.scanner,
      { kind: "error", log: "System", source: "Biometric Lock Driver", eventId: 4242 }, true, await issueStepUpToken(db.app, tier2, "rule.propose", ISSUE.scanner));
    assert.equal(proposal.state, "proposed");
    const approved = await decideRule(db.app, admin, proposal.ruleId, true, await issueStepUpToken(db.app, admin, "rule.approve", proposal.ruleId));
    assert.equal(approved.regrouped, 1);
    assert.ok(!(await openAlerts(cabinetId)).some(a => a.id === unrecognized.id));

    // The next occurrence raises the issue.
    const before = (await openAlerts(cabinetId)).find(a => a.issue_type_id === ISSUE.scanner)?.occurrences ?? 0;
    logError();
    await until("the mapped error to raise Fingerprint scanner problem", async () =>
      ((await openAlerts(cabinetId)).find(a => a.issue_type_id === ISSUE.scanner)?.occurrences ?? 0) > before);
    assert.ok(!(await openAlerts(cabinetId)).some(a => a.issue_type_id === null), "no new unrecognized alert");
    assert.equal((await verifyAuditChain(db.app)).ok, true);
  } finally {
    agent.kill("SIGINT");
    await api.close();
    await notifier.stop();
    feed.stop();
    await db.drop();
  }

  function require_(name: string): string { return readFileSync(join(state, name), "utf8"); }
});

// ---- Milestone 5: writes through a real agent --------------------------------------------------

/** A TCP relay between the agent and the agent API, so a test can cut the cabinet off from the server mid-command. */
function relay(targetPort: number) {
  let open = true;
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(client => {
    if (!open) { client.destroy(); return; }
    const upstream = connect(targetPort, "127.0.0.1");
    sockets.add(client); sockets.add(upstream);
    client.pipe(upstream); upstream.pipe(client);
    const end = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on("error", end); upstream.on("error", end); client.on("close", end); upstream.on("close", end);
  });
  return {
    listen: () => new Promise<number>(r => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port))),
    cut: () => { open = false; for (const s of sockets) s.destroy(); },
    restore: () => { open = true; },
    close: () => new Promise<void>(r => { open = false; for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

async function startAgent(o: { db: TestDatabase; api: FastifyInstance; port: number; key: Awaited<ReturnType<typeof developmentIssuingKey>>; dir: string; admin: string; name: string; env?: Record<string, string> }) {
  const state = join(o.dir, `agent-${o.name}`);
  mkdirSync(state);
  writeFileSync(join(state, "bootstrap-token"), (await createBootstrapToken(o.db.app, o.admin)).token);
  const lines: string[] = [];
  const started = Date.now();
  const agent = spawn("dotnet", [dll!, `https://localhost:${o.port}`, join(o.dir, "platform-ca.pem"), state], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...o.env } });
  agent.stdout!.on("data", d => lines.push(...String(d).split("\n").filter(Boolean)));
  agent.stderr!.on("data", d => lines.push(...String(d).split("\n").filter(Boolean)));
  const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 200))) if (await check()) return;
    assert.fail(`timed out waiting for ${what}. Agent log:\n${lines.join("\n")}`);
  };
  await until("the enrollment request", () => lines.some(l => l.includes("waiting for an administrator")));
  const [pending] = await pendingRequests(o.db.app);
  const { cabinetId } = await approveEnrollment(o.db.app, o.key, pending!.id, { clientName: "E2E Client", siteName: "Lab", cabinetName: `Cabinet ${o.name}`, role: "standalone" }, o.admin);
  await until("enrollment", () => lines.some(l => l.includes(`Enrolled as cabinet ${cabinetId}`)));
  // The firewall change detector's first look (its baseline) is 10 s after start; changes before it are not reported.
  await new Promise(r => setTimeout(r, Math.max(0, started + 12_000 - Date.now())));
  return { agent, cabinetId, lines, until, state };
}

test("writes through a real agent: kept when delivered, rolled back when the server is unreachable, packages checked again on the cabinet, read-only refuses every write",
  { skip: !dll && "set TEST_AGENT_DLL to run", timeout: 240_000 }, async () => {
  const db: TestDatabase = await createTestDatabase();
  const dir = tempDir();
  const key = await developmentIssuingKey(dir);
  writeFileSync(join(dir, "platform-ca.pem"), key.certificatePem);
  const pki = new TestPki();
  const vendor = pki.signer("Scanner Vendor Inc", "Scanner Vendor");
  const trustDir = pki.trustFolder([{ cn: "Scanner Vendor Inc", o: "Scanner Vendor", types: ["driver"] }]);
  const store = { dir: tempDir(), maxBytes: 1024 * 1024, trust: TrustList.fromFolder(trustDir) };
  const feed = new NotificationFeed(db.app, 50);
  await feed.start();
  const notifier = new CommandNotifier(feed);
  await notifier.start();
  const api: FastifyInstance = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, packages: store, tls: await developmentServerCertificate(key, dir, ["localhost"]), longPollMs: 3000, logger: false });
  await api.listen({ host: "127.0.0.1", port: 0 });
  const apiPort = (api.server.address() as { port: number }).port;
  const link = relay(apiPort);
  const port = await link.listen();
  const [admin, admin2, tier2] = [randomUUID(), randomUUID(), randomUUID()];
  await db.app.query(`INSERT INTO users (id, username, name, role) VALUES ($1, 'e2e.admin', 'E2E Admin', 'admin'), ($2, 'e2e.admin2', 'Second Admin', 'admin'), ($3, 'e2e.tier2', 'E2E Tier 2', 'tier2')`, [admin, admin2, tier2]);
  const agents: ChildProcess[] = [];
  const result = async (commandId: string) => commandRecord(db.app, commandId);
  try {
    const a = await startAgent({ db, api, port, key, dir, admin, name: "a", env: { TEST_SAFETY_NET_SECONDS: "6", TEST_TRUST_DIR: trustDir, TEST_WRITE_DELAY_MS: "3000" } });
    agents.push(a.agent);
    const done = (id: string) => async () => !["queued", "delivered"].includes((await result(id))!.status);

    // 1. A firewall rule: delivered in time, so the agent keeps it; the change detector attributes it to the command.
    const rule = { change: "create", rule: { name: "MashuraDiag Sync 1433", direction: "in", action: "allow", protocol: "tcp", localPorts: [{ from: 1433, to: 1433 }], profiles: ["domain", "private"], enabled: true } };
    const create = await issueCommand(db.app, tier2, a.cabinetId, "firewall.setRule", rule, "command.issue", { viaCli: true });
    await a.until("the rule's result", done(create.commandId));
    const created = (await result(create.commandId))!;
    assert.equal(created.status, "succeeded", JSON.stringify(created.result));
    await a.until("the change to be kept", () => a.lines.some(l => l.includes(`Command ${create.commandId}: the server was reached; the change is kept.`)));
    await a.until("the firewall change event, attributed", async () =>
      (await db.app.query("SELECT 1 FROM firewall_changes WHERE command_id = $1 AND event_id IS NOT NULL", [create.commandId])).rows.length > 0, 30_000);
    assert.equal((await db.app.query("SELECT COUNT(*) AS n FROM alerts WHERE issue_type_id = $1", [ISSUE.firewall])).rows[0]!.n, 0, "a platform change raises no alert");

    // 2. Cut the cabinet off while the next change is being made: the safety net rolls it back, and the result says so once it is back.
    const disable = await issueCommand(db.app, tier2, a.cabinetId, "firewall.setRule", { change: "disable", ruleName: "MashuraDiag Sync 1433" }, "command.issue", { viaCli: true });
    await a.until("delivery", async () => (await result(disable.commandId))!.status !== "queued", 10_000);
    link.cut();
    await a.until("the rollback", () => a.lines.some(l => l.includes(`Command ${disable.commandId}: the server was not reached in time`)), 30_000);
    await new Promise(r => setTimeout(r, 20_000));
    link.restore();
    await a.until("the rolled-back result", done(disable.commandId), 120_000);
    const rolled = (await result(disable.commandId))!;
    assert.equal(rolled.status, "failed");
    assert.equal(rolled.result!.error!.code, "safety_net_rollback");
    const state = await issueCommand(db.app, tier2, a.cabinetId, "firewall.state", {});
    await a.until("firewall.state", done(state.commandId));
    const fw = (await result(state.commandId))!.result!.output as { rules: { name: string; enabled: boolean }[]; snapshots: unknown[] };
    assert.equal(fw.rules.find(r => r.name === "MashuraDiag Sync 1433")!.enabled, true, "the disable was undone");
    assert.ok(fw.snapshots.length >= 2);
    await a.until("the safety-net security event", async () =>
      (await db.app.query("SELECT 1 FROM events WHERE cabinet_id = $1 AND kind = 'security' AND JSON_VALUE(detail, '$.fields.commandId') = $2", [a.cabinetId, disable.commandId])).rows.length > 0, 30_000);

    // 3. A package: checked by the server, approved by a second Admin, downloaded and checked again by the agent, installed.
    const INF = Buffer.from("[Version]\r\nSignature=\"$WINDOWS NT$\"\r\nClass=Biometric\r\nCatalogFile=scanner.cat\r\n");
    const SYS = pe("scanner driver");
    const good = zip([["scanner.inf", INF], ["x64/scanner.sys", SYS], ["scanner.cat", pki.catalog(vendor, [INF, SYS])]]);
    const goodFile = join(dir, "good.zip"); writeFileSync(goodFile, good);
    const packageId = await startUpload(db.app, admin, { name: "Scanner driver", version: "1.0", vendor: "Scanner Vendor", packageType: "driver", hardwareIds: [] }, null);
    const uploaded = await receiveUpload(db.app, store, admin, packageId, createReadStream(goodFile));
    await approvePackage(db.app, admin2, packageId, null);
    const install = await issueCommand(db.app, tier2, a.cabinetId, "package.install", { packageId, packageType: "driver", sha256: uploaded.sha256! }, "command.issue", { viaCli: true });
    await a.until("the install", done(install.commandId), 60_000);
    const installed = (await result(install.commandId))!;
    assert.equal(installed.status, "succeeded", JSON.stringify(installed.result));
    assert.equal((installed.result!.output as { signer: string }).signer, "Scanner Vendor Inc");

    // ...and one forced past the server (approved by hand, file swapped for a tampered one): the agent refuses it.
    const tampered = zip([["scanner.inf", INF], ["x64/scanner.sys", pe("evil")], ["scanner.cat", pki.catalog(vendor, [INF, SYS])]]);
    const sha = createHash("sha256").update(tampered).digest("hex");
    writeFileSync(join(store.dir, `${sha}.pkg`), tampered);
    const forced = randomUUID();
    await asOwner(db, c => c.query(`INSERT INTO packages (id, name, version, vendor, type, state, sha256, size_bytes, signer, uploaded_by, approved_by, approved_at)
      VALUES ($1, 'Forced', '1', 'x', 'driver', 'approved', $2, $3, 'forced', $4, $5, SYSUTCDATETIME())`, [forced, sha, tampered.length, admin, admin2]));
    const bad = await issueCommand(db.app, tier2, a.cabinetId, "package.install", { packageId: forced, packageType: "driver", sha256: sha }, "command.issue", { viaCli: true });
    await a.until("the refusal", done(bad.commandId), 60_000);
    const refused = (await result(bad.commandId))!;
    assert.equal(refused.status, "rejected");
    assert.equal(refused.result!.error!.code, "signature_invalid");

    // 4. A read-only cabinet refuses every write, whatever the server sends.
    const ro = await startAgent({ db, api, port, key, dir, admin, name: "ro", env: { TEST_READ_ONLY: "1" } });
    agents.push(ro.agent);
    // The server refuses writes to a cabinet that reports read-only...
    await ro.until("the read-only heartbeat", async () => (await db.app.query("SELECT read_only FROM cabinets WHERE id = $1", [ro.cabinetId])).rows[0]?.read_only === true);
    await assert.rejects(issueCommand(db.app, tier2, ro.cabinetId, "firewall.setRule", { change: "delete", ruleName: "x" }, "command.issue", { viaCli: true }), /read-only/);
    // ...and when a server sends them anyway (queued straight into the database here), the agent refuses each one itself.
    const writes: [string, unknown][] = [
      ["network.setIp", { interfaceIndex: 12, mode: "dhcp" }], ["network.setDns", { interfaceIndex: 12, mode: "automatic" }],
      ["firewall.setProfile", { profile: "public", enabled: true, defaultInbound: "block", defaultOutbound: "allow" }],
      ["firewall.setRule", { change: "delete", ruleName: "x" }], ["firewall.restore", { snapshotId: randomUUID() }],
      ["package.install", { packageId, packageType: "driver", sha256: uploaded.sha256! }], ["driver.uninstall", { publishedName: "oem1.inf" }],
    ];
    for (const [op, params] of writes) {
      const c = { commandId: randomUUID() };
      await asOwner(db, k => k.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status)
        VALUES ($1, $2, $3, $4, $5, SYSUTCDATETIME(), DATEADD(second, 60, SYSUTCDATETIME()), 'queued')`, [c.commandId, ro.cabinetId, op, JSON.stringify(params), tier2]));
      await ro.until(`${op} refused`, done(c.commandId));
      const r = (await result(c.commandId))!;
      assert.deepEqual([op, r.status, r.result!.error!.code], [op, "rejected", "read_only_mode"]);
    }
    const audit = (await db.app.query<{ action: string; n: number }>("SELECT action, COUNT(*) AS n FROM audit_log WHERE action IN ('command.write', 'command.result', 'package.download') GROUP BY action")).rows;
    // The four writes this test issued through the server (the read-only ones were queued around it on purpose).
    assert.equal(audit.find(r => r.action === "command.write")!.n, 4, "every write is in the audit log");
    assert.ok(audit.find(r => r.action === "package.download")!.n >= 2);
    assert.equal((await verifyAuditChain(db.app)).ok, true);
  } finally {
    for (const ag of agents) ag.kill("SIGINT");
    await link.close();
    await api.close();
    await notifier.stop();
    feed.stop();
    await db.drop();
  }
});

test("watched services on the real agent code: a stopped service is started again within seconds, one that never starts raises the major alert, and recovery closes it",
  { skip: !dll && "set TEST_AGENT_DLL to run", timeout: 180_000 }, async () => {
  const db: TestDatabase = await createTestDatabase();
  const dir = tempDir();
  const key = await developmentIssuingKey(dir);
  writeFileSync(join(dir, "platform-ca.pem"), key.certificatePem);
  const feed = new NotificationFeed(db.app, 50);
  await feed.start();
  const notifier = new CommandNotifier(feed);
  await notifier.start();
  const api: FastifyInstance = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, tls: await developmentServerCertificate(key, dir, ["localhost"]), longPollMs: 3000, logger: false });
  await api.listen({ host: "127.0.0.1", port: 0 });
  const port = (api.server.address() as { port: number }).port;
  const [admin, tier2] = [randomUUID(), randomUUID()];
  await db.app.query(`INSERT INTO users (id, username, name, role) VALUES ($1, 'svc.admin', 'Svc Admin', 'admin'), ($2, 'svc.tier2', 'Svc Tier 2', 'tier2')`, [admin, tier2]);
  const agents: ChildProcess[] = [];
  const alert = async (cabinetId: string, signature: string) => (await db.app.query<{ state: string; severity: string; occurrences: number }>(
    "SELECT TOP (1) state, severity, occurrences FROM alerts WHERE cabinet_id = $1 AND signature = $2 ORDER BY first_seen DESC", [cabinetId, signature])).rows[0];
  try {
    const a = await startAgent({ db, api, port, key, dir, admin, name: "svc" });
    agents.push(a.agent);
    // The watcher starts only services that are also on the cabinet's approved list, so the owner approves the two it is
    // meant to keep running (the simulated service manager reports C:\Program Files\Simulated\<name>.exe for each).
    const approvedEntries = normalizeEntries(["BioScanSvc", "FlakySvc"].map(name => ({
      key: `app:${name}`, kind: "service", name, path: `C:\\Program Files\\Simulated\\${name}.exe`, serviceName: name })));
    assert.equal(approvedEntries.ok, true, JSON.stringify(approvedEntries));
    const entries = approvedEntries.ok ? approvedEntries.entries : [];
    await asOwner(db, c => c.query("UPDATE cabinets SET approved_apps = $1 WHERE id = $2", [JSON.stringify({
      version: 1, entries: entries.map(rawEntry), hash: appsHash(entries), setBy: admin, setAt: new Date().toISOString() }), a.cabinetId]));
    // Tess watches the scanner service and a service that will not start, on this cabinet.
    await setWatched(db.app, tier2, "cabinet", a.cabinetId, ["BioScanSvc", "FlakySvc", "NoSuchSvc"]);
    await a.until("the watch list to reach the broker", () => a.lines.some(l => l.includes("Watching 3 services: BioScanSvc, FlakySvc, NoSuchSvc.")), 20_000);

    // FlakySvc never starts: after 3 failed restarts, the major alert.
    await a.until("Service will not stay running: FlakySvc", async () => (await alert(a.cabinetId, "service:failing:FlakySvc"))?.severity === "major", 30_000);
    // A service that does not exist on the cabinet: the minor alert that says the watch list names the wrong service.
    await a.until("the missing service alert", async () => (await alert(a.cabinetId, "service:watch:NoSuchSvc"))?.state === "open", 30_000);

    // Someone stops the scanner service: it is running again at the next check, and the minor alert counts it.
    writeFileSync(join(a.state, "simulate", "stop-services.json"), JSON.stringify(["BioScanSvc"]));
    await a.until("BioScanSvc restarted", () => a.lines.some(l => l.includes("Watched service BioScanSvc was stopped; started it again.")), 20_000);
    await a.until("Service restarted automatically: BioScanSvc", async () => (await alert(a.cabinetId, "service:restarted:BioScanSvc"))?.state === "open", 30_000);

    // services.list shows each watched service's status, through a real command.
    const list = await issueCommand(db.app, tier2, a.cabinetId, "services.list", {});
    await a.until("services.list", async () => (await commandRecord(db.app, list.commandId))?.status === "succeeded");
    const out = (await commandRecord(db.app, list.commandId))!.result!.output as { services: { name: string; state: string }[]; watched: { name: string; state: string; restartsToday: number }[] };
    assert.equal(out.services.find(s => s.name === "BioScanSvc")!.state, "running");
    assert.deepEqual(out.watched.map(w => [w.name, w.state]), [["BioScanSvc", "restarted"], ["FlakySvc", "failing"], ["NoSuchSvc", "missing"]]);

    // service.control is refused for the agent's own and remote-access services, on the cabinet itself.
    const rdp = await issueCommand(db.app, tier2, a.cabinetId, "service.control", { name: "TermService", action: "start" }, "command.issue", { viaCli: true });
    await a.until("the refusal", async () => (await commandRecord(db.app, rdp.commandId))?.status === "failed");
    assert.match((await commandRecord(db.app, rdp.commandId))!.result!.error!.message, /never/);
  } finally {
    for (const ag of agents) ag.kill("SIGINT");
    await api.close();
    await notifier.stop();
    feed.stop();
    await db.drop();
  }
});
