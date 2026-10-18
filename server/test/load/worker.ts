// A worker thread running a share of the simulated agents: their links (with 4G failovers), their measurements, and
// what the main thread asks for (black-holes, phases, markers). It reports per-second series every few seconds and
// everything else when told to stop.
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import { SimAgent, type AgentConfig, type AgentHooks, type AgentIdentity, type Kind } from "./agent-sim.js";
import { AgentLink, LINK_CLASSES, wireBytes, type LinkClassName } from "./link.js";
import { Counters, HistogramSet, Series, seeded } from "./metrics.js";

export interface WorkerAgent extends AgentIdentity { linkClass: LinkClassName; storm: boolean; clockOffsetMs: number; startDelayMs: number; site: number; region: number }

export interface WorkerInit {
  workerId: number;
  t0: number;
  agents: WorkerAgent[];
  config: Omit<AgentConfig, "storm" | "clockOffsetMs">;
  /** 4G failovers on (every failoverEveryHours ± spread, divided by timeCompression). */
  failovers: boolean;
  /** Per-agent failover interval override in minutes (failover-during-command scenario), else the class's. */
  failoverEveryMinutes?: number;
  seed: number;
}

export type ToWorker =
  | { t: "phase"; phase: string }
  | { t: "blackhole"; indices: number[]; on: boolean; reason: string }
  | { t: "issued"; commandId: string; index: number; at: number; tag: string }
  | { t: "marker"; name: string; at: number }
  | { t: "drainWatch"; indices: number[] }
  | { t: "preload"; indices: number[]; hours: number }
  | { t: "stop" };

export interface WorkerFinal {
  t: "final";
  workerId: number;
  hist: ReturnType<HistogramSet["data"]>;
  counters: Record<string, number>;
  series: Record<string, [number, number][]>;
  received: [string, number, number][]; // commandId, agent index, first received at
  results: [string, string][];          // commandId, outcome
  pendingResults: string[];             // still in an outbox when the run ended
  queuedEvents: number;
  reconnect: Record<string, { delays: number[]; notBack: number }>;
  drained: number[];
  falseOfflines: { index: number; linkClass: string; gapMs: number; upMs: number; at: number }[];
  linkDownSeconds: Record<string, number>;
}

const init = workerData as WorkerInit;
const port = parentPort!;
const rand = seeded(init.seed);
const series = new Series(init.t0);
const hist = new HistogramSet();
const counters = new Counters();
let phase = "ramp";
const stopping = { v: false };

const outputs: Record<string, unknown> = {};
const examples = join(SCHEMA_DIR, "..", "examples", "operations");
const readExample = (op: string, file: string): unknown => JSON.parse(readFileSync(join(examples, op, "output", "valid", file), "utf8"));
outputs["system.info"] = readExample("system.info", "typical.json");
outputs["system.checkHealth"] = readExample("system.checkHealth", "typical.json");
{
  // A realistic page of 50 entries (the example has one).
  const page = readExample("eventlog.query", "page.json") as { entries: Record<string, unknown>[] };
  const one = page.entries[0]!;
  page.entries = Array.from({ length: 50 }, (_, i) => ({ ...one, recordId: (one["recordId"] as number) - i }));
  outputs["eventlog.query"] = page;
}

const issued = new Map<string, { at: number; tag: string }>();
const earlyReceived = new Map<string, { index: number; at: number }>();
const received = new Map<string, [number, number]>();
const results = new Map<string, string>();
const markers: { name: string; at: number }[] = [];
const reconnectAt = new Map<string, Map<number, number>>();
const drained: number[] = [];
let drainSince = 0;
const falseOfflines: WorkerFinal["falseOfflines"] = [];
const outageMember = new Set<number>();

function recordDelivery(agent: SimAgent, commandId: string, at: number, iss: { at: number; tag: string }): void {
  // "recovering": the link was up when the command was issued but had been down in the 10 minutes before, so delivery waits for the
  // agent's reconnect backoff (reported under reconnect times), not for the server; kept out of the per-link delivery thresholds.
  const tag = iss.tag !== "normal" ? iss.tag : agent.link.downWithin(iss.at, at) > 0 ? "blackout"
    : agent.link.downWithin(iss.at - 600_000, iss.at) > 0 ? "recovering" : "normal";
  hist.add(`delivery|${agent.linkClass}|${tag}`, at - iss.at);
  if (tag === "blackout") {
    // After a blackout: how long after the link came back did it arrive?
    const back = agent.link.downIntervals.filter(([a, b]) => b >= iss.at && a <= at).map(([, b]) => b).pop();
    if (back !== undefined) hist.add(`delivery-after-link-up|${agent.linkClass}`, Math.max(0, at - back));
  }
}

/** A false offline: more than 5 minutes without contact while the link was up (down time inside the gap does not count). */
function gapCheck(agent: SimAgent, at: number): void {
  if (agent.lastContact <= 0) return;
  const gap = at - agent.lastContact;
  const up = gap - agent.link.downWithin(agent.lastContact, at);
  if (up > 300_000) falseOfflines.push({ index: agent.id.index, linkClass: agent.linkClass, gapMs: gap, upMs: up, at });
}

const hooks: AgentHooks = {
  phase: () => phase,
  outputs,
  request(agent, kind: Kind, ms, outcome, extra) {
    const now = Date.now();
    series.inc(`req|${kind}`, 1, now);
    series.inc(`st|${outcome}`, 1, now);
    if (outcome.startsWith("2")) {
      const k = kind === "poll" ? (extra?.held ? "poll-held" : "poll-commands") : kind;
      hist.add(`${k}|${agent.linkClass}|${phase}|${outageMember.has(agent.id.index) ? "a" : "u"}`, ms);
    } else counters.inc(`outcome.${kind}.${outcome}`);
  },
  contact(agent, at) {
    gapCheck(agent, at);
    for (const m of markers) {
      if (m.at > at) continue;
      const map = reconnectAt.get(m.name)!;
      if (!map.has(agent.id.index)) map.set(agent.id.index, at);
    }
    series.inc("contact", 1, at);
  },
  received(agent, commandId, _op, at, repeat) {
    if (repeat) { counters.inc("commands.redelivered"); return; }
    received.set(commandId, [agent.id.index, at]);
    const iss = issued.get(commandId);
    if (iss) { recordDelivery(agent, commandId, at, iss); issued.delete(commandId); }
    else earlyReceived.set(commandId, { index: agent.id.index, at });
  },
  resultDone(_agent, commandId, outcome) { results.set(commandId, outcome); counters.inc(`results.${outcome}`); },
  count(key, n = 1) { counters.inc(key, n); },
  handshake(agent, reused, ms, protocol) {
    series.inc(reused ? "hs|resumed" : "hs|full");
    counters.inc(`connections.${protocol}`);
    hist.add(`handshake|${agent.linkClass}|${reused ? "resumed" : "full"}`, ms);
  },
  bytes(agent, direction, n) { series.inc(`bytes|${direction}|${agent.linkClass}`, wireBytes(n)); series.inc(`payload|${direction}|${agent.linkClass}`, n); },
  drained(_agent, at) { if (drainSince > 0) drained.push(at - drainSince); },
};

const agents: SimAgent[] = [];
const byIndex = new Map<number, SimAgent>();
for (const a of init.agents) {
  const link = new AgentLink(LINK_CLASSES[a.linkClass], rand);
  link.on("down", () => port.postMessage({ t: "link", index: a.index, down: true, at: Date.now() }));
  link.on("up", () => port.postMessage({ t: "link", index: a.index, down: false, at: Date.now() }));
  const agent = new SimAgent(a, link, { ...init.config, storm: a.storm, clockOffsetMs: a.clockOffsetMs }, hooks);
  agents.push(agent);
  byIndex.set(a.index, agent);
}

// 4G failovers: every (6 h ± 3 h) / compression, each black-holing every socket for 30 to 90 s (real time).
const timers: NodeJS.Timeout[] = [];
function scheduleFailover(agent: SimAgent, first: boolean): void {
  const cls = agent.link.cls;
  if (stopping.v) return;
  const meanMs = init.failoverEveryMinutes !== undefined ? init.failoverEveryMinutes * 60_000 : (cls.failoverEveryHours * 3_600_000) / init.config.timeCompression;
  const spreadMs = init.failoverEveryMinutes !== undefined ? meanMs / 2 : (cls.failoverSpreadHours * 3_600_000) / init.config.timeCompression;
  const wait = first ? rand() * (meanMs + spreadMs) : meanMs + (rand() * 2 - 1) * spreadMs;
  timers.push(setTimeout(() => {
    if (stopping.v) return;
    const [lo, hi] = cls.failoverBlackoutSec;
    agent.link.blackhole("failover");
    counters.inc("failovers");
    timers.push(setTimeout(() => { agent.link.restore("failover"); scheduleFailover(agent, false); }, (lo + rand() * (hi - lo)) * 1000));
  }, Math.max(1_000, wait)));
}
if (init.failovers) for (const a of agents) if (a.link.cls.failoverEveryHours > 0) scheduleFailover(a, true);

const running = agents.map((a, i) => a.run(init.agents[i]!.startDelayMs));

const tick = setInterval(() => {
  let open = 0, online = 0, queued = 0, outbox = 0, linkDown = 0;
  for (const a of agents) { open += a.transport.openConnections; queued += a.queued; outbox += a.pendingResults; if (a.lastContact > Date.now() - 330_000) online++; if (a.link.down) linkDown++; }
  port.postMessage({ t: "tick", workerId: init.workerId, series: series.drain(), gauges: { open, online, queued, outbox, linkDown } });
}, 5_000);

port.on("message", (m: ToWorker) => {
  switch (m.t) {
    case "phase": phase = m.phase; break;
    case "blackhole":
      for (const i of m.indices) {
        const a = byIndex.get(i);
        if (!a) continue;
        if (m.on) { a.link.blackhole(m.reason); if (m.reason === "outage") outageMember.add(i); }
        else a.link.restore(m.reason);
      }
      break;
    case "issued": {
      const early = earlyReceived.get(m.commandId);
      if (early) { const a = byIndex.get(early.index); if (a) recordDelivery(a, m.commandId, early.at, { at: m.at, tag: m.tag }); earlyReceived.delete(m.commandId); }
      else issued.set(m.commandId, { at: m.at, tag: m.tag });
      break;
    }
    case "marker": markers.push({ name: m.name, at: m.at }); reconnectAt.set(m.name, new Map()); break;
    case "drainWatch": drainSince = Date.now(); for (const i of m.indices) { const a = byIndex.get(i); if (a) a.drainWatch = true; } break;
    case "preload": for (const i of m.indices) byIndex.get(i)?.preload(m.hours); break;
    case "stop": void stop(); break;
  }
});

async function stop(): Promise<void> {
  stopping.v = true;
  for (const t of timers) clearTimeout(t);
  const now = Date.now();
  // A gap still open at the end counts too.
  for (const a of agents) gapCheck(a, now);
  for (const a of agents) a.stop();
  clearInterval(tick);
  await Promise.race([Promise.all(running), new Promise(r => setTimeout(r, 5_000))]);
  const reconnect: WorkerFinal["reconnect"] = {};
  for (const m of markers) {
    const map = reconnectAt.get(m.name)!;
    const delays: number[] = [];
    let notBack = 0;
    for (const a of agents) {
      const at = map.get(a.id.index);
      // Only agents whose link stayed up from the marker to their return say anything about the server.
      if (at === undefined) { if (!a.link.down && a.link.downWithin(m.at, now) === 0) notBack++; continue; }
      if (a.link.downWithin(m.at, at) > 0) continue;
      delays.push(at - m.at);
    }
    reconnect[m.name] = { delays, notBack };
  }
  const linkDownSeconds: Record<string, number> = {};
  for (const a of agents) linkDownSeconds[a.linkClass] = (linkDownSeconds[a.linkClass] ?? 0) + a.link.downWithin(init.t0, now) / 1000;
  const final: WorkerFinal = {
    t: "final", workerId: init.workerId, hist: hist.data(), counters: counters.data(), series: series.drain(),
    received: [...received].map(([id, [i, at]]) => [id, i, at]), results: [...results], pendingResults: agents.flatMap(a => a.pendingResultIds),
    queuedEvents: agents.reduce((s, a) => s + a.queued, 0), reconnect, drained, falseOfflines: falseOfflines.filter(f => f.at <= now), linkDownSeconds,
  };
  port.postMessage(final);
  setTimeout(() => process.exit(0), 200);
}
