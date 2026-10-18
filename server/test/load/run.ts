// The load run: starts the workers that hold the simulated agents, drives the scenario (ramp, restart, outage,
// failovers), issues commands through the server's real issuing path, samples the server process and the database,
// and at the end checks every command and result against the database and prints the summary and thresholds.
import { Worker } from "node:worker_threads";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { get as httpsGet } from "node:https";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "../../src/db/db.js";
import { issueCommand } from "../../src/services/commands.js";
import { ISSUE } from "../../src/services/rules.js";
import { Counters, HistogramSet, SeriesStore, pct, seeded, hash32 } from "./metrics.js";
import { parseLinkMix, pickLinkClass, LINK_CLASSES, type LinkClassName } from "./link.js";
import { REGIONS, type State } from "./setup.js";
import type { Protocol } from "./agent-sim.js";
import type { ToWorker, WorkerAgent, WorkerFinal, WorkerInit } from "./worker.js";

export const SCENARIOS = ["steady", "restart", "no-ramp", "regional-outage", "nat-drop", "failover-during-command", "event-storm"] as const;
export type Scenario = typeof SCENARIOS[number];

export interface RunOptions {
  scenario: Scenario;
  protocol: Protocol;
  server: string;
  state: string;
  minutes: number;
  rampSeconds: number;
  commandsPerSecond: number;
  eventsPerHour: number;
  first?: number;
  report?: string;
  workers: number;
  seed: number;
  links: string;
  timeCompression: number;
  clockSkewShare: number;
  restartAtMinute: number;
  restartExec?: string;
  outageAtMinute: number;
  outageMinutes: number;
  outageShare: number;
  preloadHours: number;
  failoverEveryMinutes?: number;
  serverPid?: number;
  serverPidFile?: string;
  http: "auto" | "h1" | "h2";
  gzip: "auto" | "on" | "off";
  keepaliveSeconds?: number;
  drainSeconds: number;
  installMinutes: number;
  offlineCommandShare: number;
  stormShare: number;
}

/** What a run must show (docs/platform/performance.md "Thresholds"). */
export const THRESHOLDS = {
  lostCommands: 0,
  lostResults: 0,
  falseOfflinesSteadyRestart: 0,
  restartReconnect99Ms: 180_000,
  steadyHandshakeShare: 0.01,
  deliveryP95Ms: { fiber: 3_000, dsl: 3_000, "4g": 10_000, bad: 10_000 } as Record<string, number>,
  /** The server's own speed, measured on fiber agents outside disturbances. */
  heartbeatP95Ms: 1_000,
  heartbeatP99Ms: 3_000,
};

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, Math.max(0, ms)));

// ---- Server process sampling (/proc) -------------------------------------------------------------

interface ProcSample { at: number; cpuTicks: number; rssKb: number }
const CLK_TCK = 100;

function readProc(pid: number): ProcSample | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const cpuTicks = Number(after[11]) + Number(after[12]);
    const rss = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return { at: Date.now(), cpuTicks, rssKb: rss ? Number(rss[1]) : 0 };
  } catch { return null; }
}

/** The SQL Server process, when this machine can see it (a container on the same kernel). */
function findProcess(comm: string): number | null {
  try {
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try { if (readFileSync(`/proc/${d}/comm`, "utf8").trim() === comm) return Number(d); } catch { /* gone */ }
    }
  } catch { /* no /proc */ }
  return null;
}

class ProcWatch {
  samples: { at: number; cpuPercent: number; rssMb: number }[] = [];
  private last: ProcSample | null = null;
  constructor(private readonly pid: () => number | null) {}
  sample(): void {
    const pid = this.pid();
    if (!pid) { this.last = null; return; }
    const s = readProc(pid);
    if (!s) { this.last = null; return; }
    if (this.last && s.cpuTicks >= this.last.cpuTicks) {
      const cpuPercent = ((s.cpuTicks - this.last.cpuTicks) / CLK_TCK) / ((s.at - this.last.at) / 1000) * 100;
      this.samples.push({ at: s.at, cpuPercent, rssMb: s.rssKb / 1024 });
    }
    this.last = s;
  }
  summary(from = 0): { samples: number; cpuPercentAvg: number; cpuPercentP95: number; cpuPercentMax: number; rssMbMax: number; rssMbLast: number } | null {
    const s = this.samples.filter(x => x.at >= from);
    if (s.length === 0) return null;
    const cpu = s.map(x => x.cpuPercent);
    return { samples: s.length, cpuPercentAvg: Math.round(cpu.reduce((a, b) => a + b, 0) / s.length), cpuPercentP95: Math.round(pct(cpu, 95)),
      cpuPercentMax: Math.round(Math.max(...cpu)), rssMbMax: Math.round(Math.max(...s.map(x => x.rssMb))), rssMbLast: Math.round(s[s.length - 1]!.rssMb) };
  }
}

// ---- The run -------------------------------------------------------------------------------------

function healthOk(base: URL, ca: string): Promise<boolean> {
  return new Promise(resolve => {
    const req = httpsGet({ hostname: base.hostname, port: base.port, path: "/health", ca, timeout: 2_000, agent: false }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

export async function run(o: RunOptions): Promise<number> {
  const state = JSON.parse(readFileSync(o.state, "utf8")) as State;
  const all = state.agents.slice(0, o.first ?? state.agents.length);
  const base = new URL(o.server);
  const t0 = Date.now();
  const cpu0 = process.cpuUsage();
  const rand = seeded(o.seed);
  const mix = parseLinkMix(o.links);
  const scenario = o.scenario;
  const rampMs = (scenario === "no-ramp" ? 2 : o.rampSeconds) * 1000;
  const keepalive = o.keepaliveSeconds ?? (o.protocol === "1.1" ? 20 : 0);

  // Each agent's link class, clock, storm role; whole regions for an outage.
  const outageRegions = new Set<number>();
  for (let r = 0; outageRegions.size < Math.round(REGIONS * o.outageShare) && r < 1000; r++) outageRegions.add(Math.floor(rand() * REGIONS));
  const classCount: Record<string, number> = {};
  const wagents: WorkerAgent[] = all.map((a, index) => {
    const linkClass = pickLinkClass(mix, (hash32(`${o.seed}|${a.cabinetId}`) % 1_000_000) / 1_000_000);
    classCount[linkClass] = (classCount[linkClass] ?? 0) + 1;
    const skewed = rand() < o.clockSkewShare;
    return { index, cabinetId: a.cabinetId, keyPem: a.keyPem, certPem: a.certPem, site: a.site, region: a.region, linkClass,
      storm: scenario === "event-storm" && rand() < o.stormShare, clockOffsetMs: skewed ? (rand() < 0.5 ? -1 : 1) * (60_000 + rand() * 120_000) : 0,
      startDelayMs: (index / all.length) * rampMs };
  });
  const outageMembers = scenario === "regional-outage" ? wagents.filter(a => outageRegions.has(a.region)).map(a => a.index) : [];
  const outageSites = new Set(scenario === "regional-outage" ? wagents.filter(a => outageRegions.has(a.region)).map(a => a.site) : []);

  const nWorkers = Math.max(1, Math.min(o.workers, all.length));
  console.log(`${all.length} agents (protocol ${o.protocol}, scenario ${scenario}) against ${base.origin} in ${nWorkers} worker(s); ramp ${rampMs / 1000} s, ` +
    `${o.minutes} min; links ${Object.entries(classCount).map(([k, v]) => `${k} ${v}`).join(", ")}; ${o.commandsPerSecond} commands/s; ${o.eventsPerHour} events/agent/hour; ` +
    `time compression x${o.timeCompression}.`);

  const hist = new HistogramSet();
  const counters = new Counters();
  const series = new SeriesStore();
  const gauges = new Map<number, { open: number; online: number; queued: number; outbox: number; linkDown: number }>();
  const gaugeSeries: { at: number; open: number; online: number; queued: number; outbox: number; linkDown: number }[] = [];
  const linkDown = new Map<number, number>(); // agent index -> down since
  const linkHistory = new Map<number, [number, number][]>();
  /** Was the agent's link down at any time in [from, to]? */
  const wasDown = (i: number, from: number, to: number): boolean =>
    (linkDown.get(i) ?? Infinity) <= to || (linkHistory.get(i) ?? []).some(([a, b]) => a <= to && b >= from);
  const finals: WorkerFinal[] = [];
  const owner = new Map<number, Worker>();
  const workers: Worker[] = [];
  const workerFile = fileURLToPath(new URL("./worker.js", import.meta.url));
  let resolveFinals: () => void = () => undefined;
  const allFinal = new Promise<void>(r => { resolveFinals = r; });

  for (let w = 0; w < nWorkers; w++) {
    const mine = wagents.filter(a => a.index % nWorkers === w);
    const init: WorkerInit = { workerId: w, t0, agents: mine, seed: o.seed * 7919 + w, failovers: scenario !== "nat-drop",
      ...(o.failoverEveryMinutes !== undefined ? { failoverEveryMinutes: o.failoverEveryMinutes } : {}),
      config: { protocol: o.protocol, host: base.hostname, port: Number(base.port || 443), servername: base.hostname, ca: state.caPem, eventsPerHour: o.eventsPerHour,
        timeCompression: o.timeCompression, installMinutes: o.installMinutes, gzip: o.gzip, httpOffer: o.http,
        keepaliveSec: keepalive } };
    const worker = new Worker(workerFile, { workerData: init, resourceLimits: { maxOldGenerationSizeMb: 4096 } });
    worker.on("message", (m: { t: string } & Record<string, unknown>) => {
      if (m.t === "tick") { series.merge(m["series"] as Record<string, [number, number][]>); gauges.set(w, m["gauges"] as never); }
      else if (m.t === "link") {
        const i = m["index"] as number;
        if (m["down"]) linkDown.set(i, m["at"] as number);
        else { const from = linkDown.get(i); linkDown.delete(i); if (from !== undefined) linkHistory.set(i, [...(linkHistory.get(i) ?? []), [from, m["at"] as number]]); }
      }
      else if (m.t === "final") { finals.push(m as unknown as WorkerFinal); if (finals.length === nWorkers) resolveFinals(); }
    });
    worker.on("error", e => { console.error(`worker ${w} failed:`, e); counters.inc("workerErrors"); });
    for (const a of mine) owner.set(a.index, worker);
    workers.push(worker);
  }
  const broadcast = (m: ToWorker): void => { for (const w of workers) w.postMessage(m); };
  const toAgents = (indices: number[], make: (ix: number[]) => ToWorker): void => {
    const by = new Map<Worker, number[]>();
    for (const i of indices) { const w = owner.get(i)!; by.set(w, [...(by.get(w) ?? []), i]); }
    for (const [w, ix] of by) w.postMessage(make(ix));
  };

  // ---- Phases and scenario events ----
  const phases: { name: string; from: number; to: number }[] = [];
  const setPhase = (name: string): void => {
    const now = (Date.now() - t0) / 1000;
    const last = phases[phases.length - 1];
    if (last) last.to = now;
    phases.push({ name, from: now, to: Infinity });
    broadcast({ t: "phase", phase: name });
    console.log(`  ${Math.round(now)}s: phase ${name}`);
  };
  setPhase("ramp");
  const endAt = t0 + o.minutes * 60_000;
  const timers: NodeJS.Timeout[] = [];
  const at = (ms: number, f: () => void): void => { timers.push(setTimeout(f, Math.max(0, ms - (Date.now() - t0)))); };
  at(rampMs + 30_000, () => setPhase("steady"));

  let restart: { killAt: number; readyAt: number | null; exitCode: number | null } | null = null;
  let serverDown = false;
  if (scenario === "restart") {
    at(o.restartAtMinute * 60_000, () => {
      void (async () => {
        setPhase("restart");
        restart = { killAt: Date.now(), readyAt: null, exitCode: null };
        serverDown = true;
        broadcast({ t: "marker", name: "restart", at: restart.killAt });
        if (!o.restartExec) console.log("  RESTART NOW: no --restart-exec given; restart the server process by hand (the run waits for /health).");
        else execFile(o.restartExec, [], { timeout: 120_000 }, (e, stdout, stderr) => {
          if (restart) restart.exitCode = e ? (typeof e.code === "number" ? e.code : 1) : 0;
          if (e) console.error(`  restart command failed: ${e.message}\n${stderr}`); else if (stdout.trim()) console.log(`  restart: ${stdout.trim().slice(-300)}`);
        });
        await sleep(1_000);
        while (Date.now() < endAt && !(await healthOk(base, state.caPem))) await sleep(500);
        restart.readyAt = Date.now();
        serverDown = false;
        broadcast({ t: "marker", name: "restart-ready", at: restart.readyAt });
        console.log(`  server back after ${((restart.readyAt - restart.killAt) / 1000).toFixed(1)} s`);
        await sleep(180_000);
        if (Date.now() < endAt) setPhase("after-restart");
      })();
    });
  }
  let outage: { startAt: number; endAt: number | null } | null = null;
  if (scenario === "regional-outage") {
    at(o.outageAtMinute * 60_000, () => {
      outage = { startAt: Date.now(), endAt: null };
      setPhase("outage");
      if (o.preloadHours > 0) toAgents(outageMembers, ix => ({ t: "preload", indices: ix, hours: o.preloadHours }));
      toAgents(outageMembers, ix => ({ t: "blackhole", indices: ix, on: true, reason: "outage" }));
      console.log(`  regional outage: ${outageMembers.length} agents in ${outageSites.size} sites black-holed${o.preloadHours > 0 ? `, queues preloaded with ${o.preloadHours} h of events` : ""}`);
    });
    at((o.outageAtMinute + o.outageMinutes) * 60_000, () => {
      if (outage) outage.endAt = Date.now();
      toAgents(outageMembers, ix => ({ t: "drainWatch", indices: ix }));
      toAgents(outageMembers, ix => ({ t: "blackhole", indices: ix, on: false, reason: "outage" }));
      broadcast({ t: "marker", name: "outage-end", at: Date.now() });
      setPhase("recovery");
    });
  }

  // ---- Database: commands, and the server's view of who is offline ----
  const pool: Pool | null = process.env.DATABASE_URL ? await createPool(process.env.DATABASE_URL, 4) : null;
  if (!pool) console.log("  DATABASE_URL is not set: no commands are issued and nothing is checked in the database.");
  const ops: { op: string; params: unknown; share: number }[] = [
    { op: "system.info", params: {}, share: 0.7 }, { op: "eventlog.query", params: { log: "System" }, share: 0.25 }, { op: "system.checkHealth", params: {}, share: 0.05 }];
  const issuedCmds: { id: string; index: number; at: number; op: string; tag: string }[] = [];
  const offlineCmds: string[] = [];
  const stopIssuingAt = endAt - o.drainSeconds * 1000;
  const commander = (async () => {
    if (!pool || o.commandsPerSecond <= 0) return;
    await sleep(rampMs + 30_000);
    while (Date.now() < stopIssuingAt) {
      const tick = Date.now();
      let op = ops[0]!;
      for (let u = Math.random(), acc = 0, i = 0; i < ops.length; i++) { acc += ops[i]!.share; if (u < acc) { op = ops[i]!; break; } }
      const toOffline = state.offline.length > 0 && Math.random() < o.offlineCommandShare;
      let index = Math.floor(Math.random() * all.length);
      // failover-during-command: half of the commands go to a cabinet whose link is down right now.
      if (scenario === "failover-during-command" && linkDown.size > 0 && Math.random() < 0.5) index = [...linkDown.keys()][Math.floor(Math.random() * linkDown.size)]!;
      const cabinetId = toOffline ? state.offline[Math.floor(Math.random() * state.offline.length)]! : all[index]!.cabinetId;
      const tag = serverDown ? "restart" : linkDown.has(index) ? "blackout" : "normal";
      try {
        const c = await issueCommand(pool, state.userId, cabinetId, toOffline ? "system.info" : op.op, toOffline ? {} : op.params);
        hist.add("issue", Date.now() - tick);
        if (toOffline) offlineCmds.push(c.commandId.toLowerCase());
        else {
          issuedCmds.push({ id: c.commandId.toLowerCase(), index, at: tick, op: op.op, tag });
          owner.get(index)!.postMessage({ t: "issued", commandId: c.commandId.toLowerCase(), index, at: tick, tag } satisfies ToWorker);
        }
      } catch (e) { counters.inc(`issueFailed.${(e as Error).name}`); }
      await sleep(1000 / o.commandsPerSecond - (Date.now() - tick));
    }
  })();

  const contactColumn = pool ? ((await pool.query<{ c: string }>(
    "SELECT TOP (1) COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'cabinets' AND COLUMN_NAME IN ('last_contact_at', 'last_heartbeat_at') ORDER BY CASE COLUMN_NAME WHEN 'last_contact_at' THEN 0 ELSE 1 END")).rows[0]?.c ?? "last_heartbeat_at") : "last_heartbeat_at";
  const byCabinet = new Map(all.map((a, i) => [a.cabinetId.toLowerCase(), i]));
  const serverViewOffline = new Set<number>();
  let serverViewOfflineMax = 0;
  const dbSampler = setInterval(() => {
    if (!pool) return;
    // Presence is written in batches up to a minute late, so 6 min 10 s (not 5) without a record counts here.
    void pool.query<{ id: string }>(`SELECT k.id FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE s.client_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))
        AND k.${contactColumn} IS NOT NULL AND k.${contactColumn} < DATEADD(second, -370, SYSUTCDATETIME())`, [JSON.stringify(state.clientIds)]).then(r => {
      let n = 0;
      for (const row of r.rows) {
        const i = byCabinet.get(row.id.toLowerCase());
        if (i === undefined) continue;
        const since = linkDown.get(i);
        if (since !== undefined) continue;
        n++; serverViewOffline.add(i);
      }
      serverViewOfflineMax = Math.max(serverViewOfflineMax, n);
    }).catch(() => counters.inc("dbSampleFailed"));
  }, 30_000);

  // ---- Server process ----
  const serverPid = (): number | null => {
    if (o.serverPidFile && existsSync(o.serverPidFile)) { const p = Number(readFileSync(o.serverPidFile, "utf8").trim()); return Number.isInteger(p) && p > 0 ? p : null; }
    return o.serverPid ?? null;
  };
  const serverProc = new ProcWatch(serverPid);
  const sqlPid = findProcess("sqlservr");
  const sqlProc = new ProcWatch(() => sqlPid);
  const procTimer = setInterval(() => {
    serverProc.sample(); sqlProc.sample();
    const g = [...gauges.values()].reduce((s, x) => ({ open: s.open + x.open, online: s.online + x.online, queued: s.queued + x.queued, outbox: s.outbox + x.outbox, linkDown: s.linkDown + x.linkDown }),
      { open: 0, online: 0, queued: 0, outbox: 0, linkDown: 0 });
    gaugeSeries.push({ at: Date.now(), ...g });
  }, 5_000);

  const progress = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    const g = gaugeSeries[gaugeSeries.length - 1];
    const sp = serverProc.samples[serverProc.samples.length - 1];
    const req = series.totalPrefix("req|", s - 30, s);
    console.log(`  ${s}s: ${(req / 30).toFixed(0)} req/s, ${g?.open ?? 0} connections, ${g?.online ?? 0} online, ${g?.linkDown ?? 0} links down, ${g?.queued ?? 0} events queued, ` +
      `${issuedCmds.length} commands issued, hs full ${series.total("hs|full", s - 30, s)} / resumed ${series.total("hs|resumed", s - 30, s)} in 30 s` +
      (sp ? `, server ${sp.cpuPercent.toFixed(0)}% CPU ${sp.rssMb.toFixed(0)} MB` : ""));
  }, 30_000);

  await sleep(endAt - Date.now());
  for (const t of timers) clearTimeout(t);
  clearInterval(progress);
  await commander;
  const lastPhase = phases[phases.length - 1];
  if (lastPhase) lastPhase.to = (Date.now() - t0) / 1000;
  broadcast({ t: "stop" });
  await Promise.race([allFinal, sleep(60_000)]);
  clearInterval(procTimer);
  clearInterval(dbSampler);
  for (const w of workers) void w.terminate();
  const runSeconds = (Date.now() - t0) / 1000;
  const cpuUsed = process.cpuUsage(cpu0);

  // ---- Merge ----
  const received = new Map<string, [number, number]>();
  const results = new Map<string, string>();
  const pendingResults = new Set<string>();
  const reconnect: Record<string, { delays: number[]; notBack: number }> = {};
  const drained: number[] = [];
  const falseOfflines: WorkerFinal["falseOfflines"] = [];
  const linkDownSeconds: Record<string, number> = {};
  let queuedAtEnd = 0;
  for (const f of finals) {
    hist.merge(f.hist); counters.merge(f.counters); series.merge(f.series);
    for (const [id, i, t] of f.received) received.set(id, [i, t]);
    for (const [id, r] of f.results) results.set(id, r);
    for (const id of f.pendingResults) pendingResults.add(id);
    for (const [k, v] of Object.entries(f.reconnect)) { const r = (reconnect[k] ??= { delays: [], notBack: 0 }); r.delays.push(...v.delays); r.notBack += v.notBack; }
    drained.push(...f.drained);
    falseOfflines.push(...f.falseOfflines);
    for (const [k, v] of Object.entries(f.linkDownSeconds)) linkDownSeconds[k] = (linkDownSeconds[k] ?? 0) + v;
    queuedAtEnd += f.queuedEvents;
  }
  if (finals.length < nWorkers) counters.inc("workersWithoutFinal", nWorkers - finals.length);

  // ---- Commands and results against the database ----
  const lost: { id: string; index: number; op: string; tag: string; status: string }[] = [];
  const undeliveredReachable: typeof lost = [];
  const undeliveredBlackout: typeof lost = [];
  let lostResults = 0, resultsChecked = 0, deliveredOk = 0, stillRunning = 0;
  const lostResultIds: string[] = [];
  let siteOutage = { raised: 0, inOutageSites: 0, elsewhere: 0, sitesElsewhere: 0 };
  let offlineCmdStatus: Record<string, number> = {};
  if (pool) {
    const rows = new Map<string, { status: string; delivered: number; has_result: number }>();
    const ids = [...issuedCmds.map(c => c.id), ...offlineCmds];
    for (let i = 0; i < ids.length; i += 500) {
      const r = await pool.query<{ id: string; status: string; delivered: number; has_result: number }>(
        `SELECT id, status, CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END AS delivered, CASE WHEN result IS NOT NULL THEN 1 ELSE 0 END AS has_result
           FROM commands WHERE id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))`, [JSON.stringify(ids.slice(i, i + 500))]);
      for (const row of r.rows) rows.set(row.id.toLowerCase(), row);
    }
    for (const c of issuedCmds) {
      const row = rows.get(c.id);
      const got = received.has(c.id);
      const status = row?.status ?? "missing";
      if (got) deliveredOk++;
      if (!got && row && row.delivered === 1) lost.push({ ...c, status });
      else if (!got && !wasDown(c.index, c.at, c.at + 300_000)) undeliveredReachable.push({ ...c, status });
      else if (!got) undeliveredBlackout.push({ ...c, status });
    }
    offlineCmdStatus = {};
    for (const id of offlineCmds) { const s = rows.get(id)?.status ?? "missing"; offlineCmdStatus[s] = (offlineCmdStatus[s] ?? 0) + 1; }
    for (const [id, outcome] of results) {
      if (outcome === "abandoned") { lostResults++; lostResultIds.push(id); continue; }
      if (outcome !== "accepted" && outcome !== "already") continue;
      resultsChecked++;
      const row = rows.get(id);
      if (row && row.has_result !== 1) { lostResults++; lostResultIds.push(id); }
    }
    for (const id of received.keys()) if (!results.has(id) && !pendingResults.has(id)) stillRunning++;
    const alerts = (await pool.query<{ site_id: string }>(
      `SELECT k.site_id FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id JOIN sites s ON s.id = k.site_id
        WHERE a.issue_type_id = $1 AND a.created_at >= $2 AND s.client_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($3))`,
      [ISSUE.siteOutage, new Date(t0), JSON.stringify(state.clientIds)])).rows;
    const siteIndex = new Map(state.siteIds.map((s, i) => [s.toLowerCase(), i]));
    const elsewhereSites = new Set<number>();
    for (const a of alerts) {
      const s = siteIndex.get(a.site_id.toLowerCase()) ?? -1;
      if (outageSites.has(s)) siteOutage.inOutageSites++; else { siteOutage.elsewhere++; elsewhereSites.add(s); }
    }
    siteOutage = { ...siteOutage, raised: alerts.length, sitesElsewhere: elsewhereSites.size };
    await pool.end();
  }

  // ---- Summary ----
  const phaseWindow = (name: string): [number, number] => {
    const ps = phases.filter(p => p.name === name);
    return ps.length ? [Math.min(...ps.map(p => p.from)), Math.max(...ps.map(p => p.to))] : [0, 0];
  };
  const [sFrom, sTo] = phaseWindow("steady");
  const steadySeconds = Math.max(0, sTo - sFrom);
  const kinds = ["poll", "heartbeat", "events", "result"];
  const reqTotal = series.totalPrefix("req|");
  const steadyReq = series.totalPrefix("req|", sFrom, sTo);
  const steadyFull = series.total("hs|full", sFrom, sTo);
  const r1 = (v: number): number => Math.round(v * 10) / 10;
  const delivery: Record<string, unknown> = {};
  for (const cls of Object.keys(LINK_CLASSES)) {
    const h = hist.select("delivery", cls, "normal");
    if (h.count > 0) delivery[cls] = h.summary();
  }
  const blackoutDelivery = hist.select("delivery", "", "blackout");
  const afterUp = hist.select("delivery-after-link-up");
  const bytesPerDay: Record<string, { up: number; down: number; payloadUp: number; payloadDown: number }> = {};
  const [bFrom, bTo] = steadySeconds > 60 ? [sFrom, sTo] : [rampMs / 1000, runSeconds];
  for (const cls of Object.keys(classCount)) {
    const k = (classCount[cls] ?? 1) * Math.max(1, bTo - bFrom);
    const per = (key: string): number => Math.round(series.total(key, bFrom, bTo) / k * 86_400);
    bytesPerDay[cls] = { up: per(`bytes|up|${cls}`), down: per(`bytes|down|${cls}`), payloadUp: per(`payload|up|${cls}`), payloadDown: per(`payload|down|${cls}`) };
  }
  const recon = (name: string): Record<string, number> | null => {
    const r = reconnect[name];
    if (!r) return null;
    const n = r.delays.length + r.notBack;
    const sorted = [...r.delays].sort((a, b) => a - b);
    const q = (p: number): number => { const k = Math.ceil(p * n) - 1; return k < sorted.length ? Math.round(sorted[Math.max(0, k)]! / 100) / 10 : Infinity; };
    return { agents: n, notBack: r.notBack, p50Seconds: q(0.5), p95Seconds: q(0.95), p99Seconds: q(0.99), p999Seconds: q(0.999), maxSeconds: sorted.length ? Math.round(sorted[sorted.length - 1]! / 100) / 10 : NaN };
  };
  const statusPeak = (code: string): { total: number; peakPerSecond: number; atSecond: number } => {
    const p = series.peak(`st|${code}`);
    return { total: series.total(`st|${code}`), peakPerSecond: p.perSecond, atSecond: p.atSecond };
  };
  const latency: Record<string, unknown> = {};
  for (const k of ["poll-held", "poll-commands", "heartbeat", "events", "result"]) latency[k] = hist.select(k).summary();
  const latencySteadyFiber: Record<string, unknown> = {};
  for (const k of ["poll-held", "heartbeat", "events", "result"]) latencySteadyFiber[k] = hist.select(k, "fiber", "steady").summary();
  const handshake = { full: hist.select("handshake", "", "full").summary(), resumed: hist.select("handshake", "", "resumed").summary() };
  const heartbeatSteadyFiber = hist.select("heartbeat", "fiber", "steady");
  const isolation = scenario === "regional-outage" ? {
    heartbeatUnaffectedDuringOutage: hist.select("heartbeat", "", "outage", "u").summary(), heartbeatUnaffectedSteady: hist.select("heartbeat", "", "steady", "u").summary(),
    eventsUnaffectedDuringOutage: hist.select("events", "", "outage", "u").summary() } : undefined;
  const drainSorted = [...drained].sort((a, b) => a - b);

  const summary = {
    scenario, protocol: o.protocol, agents: all.length, workers: nWorkers, minutes: o.minutes, rampSeconds: rampMs / 1000, links: classCount, timeCompression: o.timeCompression,
    keepaliveSeconds: keepalive, http: o.http, phases: phases.map(p => ({ name: p.name, from: Math.round(p.from), to: Math.round(p.to) })),
    requests: { total: reqTotal, perSecond: r1(reqTotal / runSeconds), steadyPerSecond: steadySeconds ? r1(steadyReq / steadySeconds) : null,
      byKindPerSecond: Object.fromEntries(kinds.map(k => [k, r1(series.total(`req|${k}`) / runSeconds)])),
      steadyByKindPerSecond: steadySeconds ? Object.fromEntries(kinds.map(k => [k, r1(series.total(`req|${k}`, sFrom, sTo) / steadySeconds)])) : null },
    outcomes: Object.fromEntries([...series.map.keys()].filter(k => k.startsWith("st|")).map(k => [k.slice(3), series.total(k)])),
    refusals: { "503": statusPeak("503"), "429": statusPeak("429") },
    tls: { fullHandshakes: series.total("hs|full"), resumed: series.total("hs|resumed"), steadyFullPerSecond: steadySeconds ? r1(steadyFull / steadySeconds) : null,
      steadyFullShareOfRequests: steadyReq ? Math.round((steadyFull / steadyReq) * 10_000) / 10_000 : null,
      peakFullPerSecond: series.peak("hs|full").perSecond, handshakeMs: handshake, protocols: Object.fromEntries(Object.entries(counters.data()).filter(([k]) => k.startsWith("connections."))) },
    connections: { max: Math.max(0, ...gaugeSeries.map(g => g.open)), last: gaugeSeries[gaugeSeries.length - 1]?.open ?? 0 },
    bytesPerCabinetPerDay: bytesPerDay,
    latencyMs: latency, latencySteadyFiberMs: latencySteadyFiber,
    commands: { issued: issuedCmds.length, received: deliveredOk, issueMs: hist.select("issue").summary(), delivery, blackout: { count: blackoutDelivery.count, latency: blackoutDelivery.summary(), afterLinkUp: afterUp.summary() },
      redelivered: counters.get("commands.redelivered"), lost: lost.length, lostSample: lost.slice(0, 10), undeliveredReachable: undeliveredReachable.length,
      undeliveredReachableSample: undeliveredReachable.slice(0, 10), undeliveredWhileUnreachable: undeliveredBlackout.length, toOfflineCabinets: { issued: offlineCmds.length, status: offlineCmdStatus } },
    results: { checkedAccepted: resultsChecked, lost: lostResults, lostSample: lostResultIds.slice(0, 10), pendingInOutboxAtEnd: pendingResults.size, commandsStillRunningAtEnd: stillRunning,
      outcomes: Object.fromEntries(Object.entries(counters.data()).filter(([k]) => k.startsWith("results."))) },
    falseOfflines: { agentView: falseOfflines.length, agents: new Set(falseOfflines.map(f => f.index)).size, sample: falseOfflines.slice(0, 10),
      serverView: { distinctCabinets: serverViewOffline.size, maxAtOnce: serverViewOfflineMax, column: contactColumn } },
    siteOutageAlerts: siteOutage,
    reconnect: { restartFromKill: recon("restart"), restartFromReady: recon("restart-ready"), afterOutage: recon("outage-end") },
    restart: restart ? { killAtSecond: Math.round(((restart as { killAt: number }).killAt - t0) / 1000), downSeconds: (restart as { readyAt: number | null }).readyAt ? r1(((restart as { readyAt: number }).readyAt - (restart as { killAt: number }).killAt) / 1000) : null } : undefined,
    outage: outage ? { agents: outageMembers.length, sites: outageSites.size, preloadHours: o.preloadHours } : undefined,
    eventDrain: drained.length || outageMembers.length ? { watched: outageMembers.length, drained: drained.length, p50Seconds: r1((pct(drainSorted, 50) || 0) / 1000),
      p95Seconds: r1((pct(drainSorted, 95) || 0) / 1000), maxSeconds: r1((drainSorted[drainSorted.length - 1] ?? 0) / 1000) } : undefined,
    events: { sent: counters.get("events.sent"), queuedAtEnd, duplicateIds: counters.get("events.duplicateId"), gzipAccepted: counters.get("events.gzipAccepted"),
      gzipNotAccepted: counters.get("events.gzipNotAccepted"), droppedQueueFull: counters.get("events.droppedQueueFull"), setAside: counters.get("events.setAside") },
    isolation,
    linkEvents: { failovers: counters.get("failovers"), linkDownSeconds: Object.fromEntries(Object.entries(linkDownSeconds).map(([k, v]) => [k, Math.round(v)])) },
    serverProcess: serverProc.summary(), serverProcessSteady: serverProc.summary(t0 + sFrom * 1000), sqlServerProcess: sqlProc.summary(),
    counters: counters.data(),
    generator: { cores: cpus().length, cpuPercentOfOneCore: Math.round((cpuUsed.user + cpuUsed.system) / 1e4 / runSeconds), rssMb: Math.round(process.memoryUsage().rss / 1048576) },
  };

  // ---- Thresholds ----
  const missed: string[] = [];
  if (lost.length > THRESHOLDS.lostCommands) missed.push(`${lost.length} commands delivered by the server but never received`);
  if (lostResults > THRESHOLDS.lostResults) missed.push(`${lostResults} results lost`);
  if ((scenario === "steady" || scenario === "restart" || scenario === "no-ramp") && falseOfflines.length > THRESHOLDS.falseOfflinesSteadyRestart)
    missed.push(`${falseOfflines.length} false offlines (agent view)`);
  if ((scenario === "steady" || scenario === "restart") && serverViewOffline.size > 0) missed.push(`${serverViewOffline.size} cabinets looked offline to the server while their link was up`);
  if (scenario === "restart") {
    const r = recon("restart-ready");
    if (!r || !(r["p99Seconds"]! * 1000 < THRESHOLDS.restartReconnect99Ms)) missed.push(`99% reconnected after restart in ${r?.["p99Seconds"] ?? "?"} s (limit ${THRESHOLDS.restartReconnect99Ms / 1000} s)`);
    if (siteOutage.raised > 0) missed.push(`${siteOutage.raised} site-outage alerts after a server restart`);
  }
  if (steadySeconds > 60 && summary.tls.steadyFullShareOfRequests !== null && summary.tls.steadyFullShareOfRequests > THRESHOLDS.steadyHandshakeShare)
    missed.push(`full TLS handshakes ${(summary.tls.steadyFullShareOfRequests * 100).toFixed(2)}% of requests in steady state (limit ${THRESHOLDS.steadyHandshakeShare * 100}%)`);
  for (const [cls, limit] of Object.entries(THRESHOLDS.deliveryP95Ms)) {
    const h = hist.select("delivery", cls, "normal");
    if (h.count > 0 && h.pct(95) > limit) missed.push(`command delivery p95 ${h.pct(95).toFixed(0)} ms on ${cls} (limit ${limit} ms)`);
  }
  if (heartbeatSteadyFiber.count > 0 && heartbeatSteadyFiber.pct(95) > THRESHOLDS.heartbeatP95Ms) missed.push(`heartbeat p95 ${heartbeatSteadyFiber.pct(95).toFixed(0)} ms (fiber, steady)`);
  if (heartbeatSteadyFiber.count > 0 && heartbeatSteadyFiber.pct(99) > THRESHOLDS.heartbeatP99Ms) missed.push(`heartbeat p99 ${heartbeatSteadyFiber.pct(99).toFixed(0)} ms (fiber, steady)`);
  if (scenario === "failover-during-command" && undeliveredBlackout.length > 0) missed.push(`${undeliveredBlackout.length} commands issued during a blackout were never delivered`);
  if (undeliveredReachable.length > 0) missed.push(`${undeliveredReachable.length} commands to reachable cabinets never delivered`);
  if (finals.length < nWorkers) missed.push(`${nWorkers - finals.length} worker(s) did not report`);
  const out = { ...summary, thresholds: THRESHOLDS, missed, passed: missed.length === 0 };

  console.log(JSON.stringify(out, (_k, v) => (v === Infinity ? "Infinity" : v), 2));
  if (o.report) writeFileSync(o.report, JSON.stringify(out, (_k, v) => (v === Infinity ? "Infinity" : v), 2));
  console.log(missed.length ? `MISSED: ${missed.join("; ")}` : "All thresholds met.");
  return missed.length ? 1 : 0;
}
