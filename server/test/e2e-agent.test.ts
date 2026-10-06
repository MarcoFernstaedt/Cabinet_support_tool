// End to end: the real agent connection code (agent/tests/Cabinet.Agent.TestAgent)
// against this server and PostgreSQL. Runs when TEST_AGENT_DLL points at the built
// test agent; CI sets it. Milestone 2 is done when the first test passes; the second
// is milestone 4's done-when, driven through the agent's real monitors and event queue.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { CommandNotifier } from "../src/agent-api/notifier.js";
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
  const notifier = new CommandNotifier(db.appUrl);
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
    await db.drop();
  }
});

test("the agent's monitors: a forced scanner disconnect raises Fingerprint scanner problem; an unrecognized error is mapped, approved, and raises it next time",
  { skip: !dll && "set TEST_AGENT_DLL to run", timeout: 120_000 }, async () => {
  const db: TestDatabase = await createTestDatabase();
  const dir = tempDir();
  const key = await developmentIssuingKey(dir);
  const notifier = new CommandNotifier(db.appUrl);
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
    await db.drop();
  }

  function require_(name: string): string { return readFileSync(join(state, name), "utf8"); }
});
