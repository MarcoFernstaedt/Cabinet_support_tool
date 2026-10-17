// Load test of the agent API (docs/spec/08-build-plan.md "Testing to keep throughout": the agent API with 8,000
// simulated agents polling, before going wide). Each simulated agent has its own cabinet and its own client
// certificate issued by the server's issuing key, holds the 25-second long poll open, sends a heartbeat every 60
// seconds and an event batch now and then, and answers the commands it is sent. A command source issues commands to
// random cabinets through the real issuing path and measures how long each takes to reach its cabinet.
//
//   setup:  node dist/test/load/agents.js setup --count 8000 --state load-state.json
//           (needs DATABASE_URL and DEV_PKI_DIR, the same as the server; creates one client, one site and the cabinets)
//   run:    node dist/test/load/agents.js run --server https://localhost:8443 --state load-state.json --minutes 10
//           [--ramp-seconds 120] [--commands-per-second 2] [--events-per-hour 6] [--first N] [--report out.json]
//
// It prints latency percentiles per request kind, errors, and command delivery times, and exits 1 when a threshold
// is missed (see THRESHOLDS). Run the server and this tool on separate machines for a real measurement; on one
// machine they share the CPU.
import { request as httpsRequest, Agent } from "node:https";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createPool } from "../../src/db/db.js";
import { developmentIssuingKey, issueAgentCertificate } from "../../src/pki/issuing.js";
import { issueCommand } from "../../src/services/commands.js";
import { SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import { csrFor, ecKey } from "../helpers.js";

/** What a fleet of this size must sustain (docs/spec/03-protocol.md "Timing and limits"). */
export const THRESHOLDS = {
  errorRate: 0.001,              // at most 0.1% of requests fail
  heartbeatP95Ms: 1_000,
  heartbeatP99Ms: 3_000,
  eventsP95Ms: 2_000,
  commandDeliveryP95Ms: 3_000,   // from issue to the cabinet receiving it, over a held long poll
  commandDeliveryMaxMs: 26_000,  // never later than one long poll plus a little
};

interface Identity { cabinetId: string; keyPem: string; certPem: string }
interface State { caPem: string; userId: string; agents: Identity[] }

// ---- Setup ---------------------------------------------------------------------------------------

async function setup(count: number, statePath: string): Promise<void> {
  const url = process.env.DATABASE_URL, pki = process.env.DEV_PKI_DIR;
  if (!url || !pki) throw new Error("setup needs DATABASE_URL and DEV_PKI_DIR (the server's own).");
  const key = await developmentIssuingKey(pki);
  const pool = await createPool(url, 4);
  const client = randomUUID(), site = randomUUID(), userId = randomUUID();
  const tag = new Date().toISOString().replace(/[:.]/g, "-");
  await pool.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `Load test ${tag}`]);
  await pool.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Load site')", [site, client]);
  await pool.query("INSERT INTO users (id, username, name, role) VALUES ($1, $2, 'Load test', 'tier1')", [userId, `load.${tag.slice(0, 19).toLowerCase()}`]);
  const agents: Identity[] = [];
  for (let i = 0; i < count; i++) {
    const cabinetId = randomUUID();
    const k = ecKey();
    const cert = await issueAgentCertificate(key, csrFor(k), cabinetId);
    await pool.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, $3, 'standalone', 'active')", [cabinetId, site, `Load cabinet ${String(i).padStart(5, "0")}`]);
    await pool.query("INSERT INTO cabinet_certificates (serial, cabinet_id, not_after) VALUES ($1, $2, $3)", [cert.serialHex, cabinetId, cert.notAfter]);
    agents.push({ cabinetId, keyPem: k.keyPem, certPem: cert.pem });
    if ((i + 1) % 500 === 0) console.log(`  ${i + 1} of ${count} cabinets`);
  }
  await pool.end();
  writeFileSync(statePath, JSON.stringify({ caPem: key.certificatePem, userId, agents } satisfies State));
  console.log(`Set up ${count} cabinets (client ${client}); identities in ${statePath}. They hold private keys: delete the file after the test.`);
}

// ---- Run -----------------------------------------------------------------------------------------

type Kind = "poll" | "heartbeat" | "events" | "result";
const latencies: Record<Kind, number[]> = { poll: [], heartbeat: [], events: [], result: [] };
const failures: Record<string, number> = {};
let requests = 0;
const deliveries: number[] = [];
const issuedAt = new Map<string, number>();
let stopping = false;

function call(agent: Agent, base: URL, method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: any }> {
  return new Promise(resolve => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = httpsRequest({ hostname: base.hostname, port: base.port, path, method, agent, timeout: timeoutMs,
      headers: { accept: "application/json", ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}) } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => { let json: unknown = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, json }); });
      res.on("error", () => resolve({ status: 0, json: null }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", e => resolve({ status: -1, json: { error: e.message.slice(0, 60) } }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function timed(kind: Kind, f: () => Promise<{ status: number; json: any }>): Promise<{ status: number; json: any }> {
  const t = performance.now();
  const r = await f();
  requests++;
  if (r.status === 200) latencies[kind].push(performance.now() - t);
  else { const k = `${kind} ${r.status}${r.status <= 0 ? " " + (r.json?.error ?? "") : ""}`; failures[k] = (failures[k] ?? 0) + 1; }
  return r;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function runAgent(id: Identity, ca: string, base: URL, startDelayMs: number, eventsPerHour: number, output: unknown): Promise<void> {
  await sleep(startDelayMs);
  const agent = new Agent({ cert: id.certPem, key: id.keyPem, ca, keepAlive: true, maxSockets: 2, servername: base.hostname });
  // The heartbeat a current agent sends: with its load sample every time, and its drives' report once (the real one sends it once a day).
  const drive = { model: "Load SSD 500GB", serialNumber: `LOAD-${id.certPem.slice(-40, -20).replace(/[^A-Za-z0-9]/g, "x")}`, health: "healthy", predictFailure: false, temperatureCelsius: 38,
    powerOnHours: 9000, reallocatedSectors: 0, pendingSectors: 0, uncorrectableErrors: 0, wearPercent: 8 };
  let beats = 0;
  const heartbeat = (async () => {
    while (!stopping) {
      const health = { cpuPercent: Math.floor(Math.random() * 60), memoryUsedPercent: 40 + Math.floor(Math.random() * 30), diskFreePercent: 30 + Math.floor(Math.random() * 40), ...(beats++ === 0 ? { drives: [drive] } : {}) };
      await timed("heartbeat", () => call(agent, base, "POST", "/agent/v1/heartbeat", { agentVersion: "0.1.0", uptimeSeconds: 3600, readOnlyMode: false, health }, 30_000));
      if (eventsPerHour > 0 && Math.random() < eventsPerHour / 60) {
        const now = new Date().toISOString();
        await timed("events", () => call(agent, base, "POST", "/agent/v1/events", { events: [{ eventId: randomUUID(), kind: "error", occurredAt: now, severityHint: "minor",
          source: { log: "Application", source: "LoadTest", eventId: 1000 + Math.floor(Math.random() * 5), level: "error", recordId: Math.floor(Math.random() * 1e9) },
          detail: { message: "A simulated application error from the load test." } }] }, 30_000));
      }
      await sleep(60_000 * (0.95 + Math.random() * 0.1));
    }
  })();
  const poll = (async () => {
    while (!stopping) {
      const r = await timed("poll", () => call(agent, base, "GET", "/agent/v1/commands", undefined, 40_000));
      if (r.status !== 200) { await sleep(2_000 + Math.random() * 3_000); continue; }
      for (const c of r.json.commands as { commandId: string }[]) {
        const at = issuedAt.get(c.commandId);
        if (at !== undefined) { deliveries.push(Date.now() - at); issuedAt.delete(c.commandId); }
        const now = new Date().toISOString();
        await timed("result", () => call(agent, base, "POST", "/agent/v1/results", { commandId: c.commandId, status: "succeeded", startedAt: now, finishedAt: now, output }, 30_000));
      }
    }
  })();
  await Promise.all([heartbeat, poll]);
  agent.destroy();
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

async function run(o: { server: string; state: string; minutes: number; rampSeconds: number; commandsPerSecond: number; eventsPerHour: number; first?: number; report?: string }): Promise<number> {
  const state = JSON.parse(readFileSync(o.state, "utf8")) as State;
  const agents = state.agents.slice(0, o.first ?? state.agents.length);
  const base = new URL(o.server);
  const output = JSON.parse(readFileSync(join(SCHEMA_DIR, "..", "examples", "operations", "system.info", "output", "valid", "typical.json"), "utf8")) as unknown;
  console.log(`${agents.length} agents against ${base.origin}, ramping up over ${o.rampSeconds} s, for ${o.minutes} min; ${o.commandsPerSecond} commands/s, ${o.eventsPerHour} event batches per agent per hour.`);
  const started = Date.now();
  const running = agents.map((a, i) => runAgent(a, state.caPem, base, (i / agents.length) * o.rampSeconds * 1000, o.eventsPerHour, output));

  // Commands, through the server's own issuing path, to random cabinets once everyone is connected.
  const pool = process.env.DATABASE_URL && o.commandsPerSecond > 0 ? await createPool(process.env.DATABASE_URL, 2) : null;
  const commander = (async () => {
    if (!pool) return;
    await sleep(o.rampSeconds * 1000 + 30_000);
    while (!stopping) {
      const target = agents[Math.floor(Math.random() * agents.length)]!;
      const before = Date.now();
      try { const c = await issueCommand(pool, state.userId, target.cabinetId, "system.info", {}); issuedAt.set(c.commandId, before); }
      catch { failures["issue command"] = (failures["issue command"] ?? 0) + 1; }
      await sleep(1000 / o.commandsPerSecond);
    }
  })();

  const progress = setInterval(() => {
    const m = Math.round((Date.now() - started) / 1000);
    console.log(`  ${m}s: ${requests} requests, heartbeat p95 ${pct(latencies.heartbeat.slice(-5000), 95).toFixed(0)} ms, ${Object.values(failures).reduce((a, b) => a + b, 0)} failed, ` +
      `${deliveries.length} commands delivered (p95 ${pct(deliveries.slice(-500), 95).toFixed(0)} ms)`);
  }, 30_000);
  await sleep(o.minutes * 60_000);
  stopping = true;
  clearInterval(progress);
  await commander;
  await Promise.race([Promise.all(running), sleep(45_000)]);
  await pool?.end();

  const failed = Object.values(failures).reduce((a, b) => a + b, 0);
  const lost = [...issuedAt.values()].filter(t => t < Date.now() - 60_000).length;
  const summary = {
    agents: agents.length, minutes: o.minutes, requests, failed, errorRate: requests ? failed / requests : 0, failures,
    latencyMs: Object.fromEntries(Object.entries(latencies).map(([k, v]) => [k, { count: v.length, p50: pct(v, 50), p95: pct(v, 95), p99: pct(v, 99), max: pct(v, 100) }])),
    commands: { delivered: deliveries.length, undeliveredOlderThanAMinute: lost, p50: pct(deliveries, 50), p95: pct(deliveries, 95), max: pct(deliveries, 100) },
  };
  console.log(JSON.stringify(summary, null, 2));
  if (o.report) writeFileSync(o.report, JSON.stringify(summary, null, 2));
  const missed: string[] = [];
  if (summary.errorRate > THRESHOLDS.errorRate) missed.push(`error rate ${(summary.errorRate * 100).toFixed(2)}%`);
  if (summary.latencyMs.heartbeat!.p95 > THRESHOLDS.heartbeatP95Ms) missed.push(`heartbeat p95 ${summary.latencyMs.heartbeat!.p95.toFixed(0)} ms`);
  if (summary.latencyMs.heartbeat!.p99 > THRESHOLDS.heartbeatP99Ms) missed.push(`heartbeat p99 ${summary.latencyMs.heartbeat!.p99.toFixed(0)} ms`);
  if (summary.latencyMs.events!.count > 0 && summary.latencyMs.events!.p95 > THRESHOLDS.eventsP95Ms) missed.push(`events p95 ${summary.latencyMs.events!.p95.toFixed(0)} ms`);
  if (deliveries.length > 0 && summary.commands.p95 > THRESHOLDS.commandDeliveryP95Ms) missed.push(`command delivery p95 ${summary.commands.p95.toFixed(0)} ms`);
  if (deliveries.length > 0 && summary.commands.max > THRESHOLDS.commandDeliveryMaxMs) missed.push(`command delivery max ${summary.commands.max.toFixed(0)} ms`);
  if (lost > 0) missed.push(`${lost} commands never delivered`);
  console.log(missed.length ? `MISSED: ${missed.join("; ")}` : "All thresholds met.");
  return missed.length ? 1 : 0;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    count: { type: "string" }, state: { type: "string" }, server: { type: "string" }, minutes: { type: "string" }, "ramp-seconds": { type: "string" },
    "commands-per-second": { type: "string" }, "events-per-hour": { type: "string" }, first: { type: "string" }, report: { type: "string" } } });
  const state = values.state ?? "load-state.json";
  if (positionals[0] === "setup") return setup(Number(values.count ?? "100"), state);
  if (positionals[0] === "run") {
    process.exitCode = await run({ server: values.server ?? "https://localhost:8443", state, minutes: Number(values.minutes ?? "5"), rampSeconds: Number(values["ramp-seconds"] ?? "60"),
      commandsPerSecond: Number(values["commands-per-second"] ?? "1"), eventsPerHour: Number(values["events-per-hour"] ?? "6"),
      ...(values.first ? { first: Number(values.first) } : {}), ...(values.report ? { report: values.report } : {}) });
    return;
  }
  console.log("usage: agents.js setup --count N --state file | run --server URL --state file --minutes M [--ramp-seconds S] [--commands-per-second C] [--events-per-hour E]");
}

main().catch(e => { console.error(e); process.exitCode = 1; });
