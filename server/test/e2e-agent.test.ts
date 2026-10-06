// End to end: the real agent connection code (agent/tests/Cabinet.Agent.TestAgent)
// against this server and PostgreSQL. Runs when TEST_AGENT_DLL points at the built
// test agent; CI sets it. Milestone 2 is done when this passes.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { CommandNotifier } from "../src/agent-api/notifier.js";
import { buildAgentApi } from "../src/agent-api/server.js";
import { developmentIssuingKey, developmentServerCertificate } from "../src/pki/issuing.js";
import { listCabinets, revokeCabinet } from "../src/services/cabinets.js";
import { commandRecord, issueCommand } from "../src/services/commands.js";
import { approveEnrollment, createBootstrapToken, pendingRequests } from "../src/services/enrollment.js";
import { verifyAuditChain } from "../src/db/db.js";
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
