// Load test of the agent API (docs/spec/08-build-plan.md "Testing to keep throughout"; method and thresholds in
// docs/platform/performance.md). Each simulated agent has its own cabinet and client certificate, behaves like the
// real agent (Protocol 1.1 by default, `--protocol 1.0` for the agent before it), and talks to the server over a
// simulated link (fiber, DSL, 4G, bad) applied in-process. A command source issues commands through the real issuing
// path; at the end every command and result is checked against the database.
//
//   setup:  node dist/test/load/agents.js setup --count 8000 --state load-state.json [--offline N]
//           (needs DATABASE_URL and DEV_PKI_DIR, the same as the server's)
//   run:    node dist/test/load/agents.js run --server https://localhost:8443 --state load-state.json --minutes 20
//           --scenario steady|restart|no-ramp|regional-outage|nat-drop|failover-during-command|event-storm
//           [--protocol 1.1|1.0] [--links fiber=60,dsl=25,4g=12,bad=3] [--time-compression 18] [--report out.json] …
//   whole run with database, certificates and server: server/test/load/run.sh <scenario> <agents> <minutes>
//
// Exit code 1 when a threshold is missed (run.ts THRESHOLDS).
import { parseArgs } from "node:util";
import { availableParallelism } from "node:os";
import { setup } from "./setup.js";
import { run, SCENARIOS, type Scenario, type RunOptions } from "./run.js";
import { parseLinkMix } from "./link.js";

const USAGE = `usage:
  agents.js setup --count N --state FILE [--offline N] [--seed S]
  agents.js run --server URL --state FILE --minutes M [options]
    --scenario ${SCENARIOS.join("|")} (default steady)
    --protocol 1.1|1.0                 1.0 = the agent before Protocol 1.1 (60 s heartbeat, no ack), for before/after
    --links fiber=60,dsl=25,4g=12,bad=3
    --time-compression C               multi-hour behaviours (4G failovers, daily drive report) C times faster
    --ramp-seconds S (120)  --commands-per-second C (2)  --events-per-hour E (6, events per agent)
    --first N  --workers W  --seed S  --report FILE
    --restart-at-minute M (5)  --restart-exec PATH     restart scenario: program run (no shell, no arguments) to restart the server
    --outage-at-minute M (4)  --outage-minutes M (20)  --outage-share F (0.3)  --preload-hours H (0; 72 = after a 3-day outage)
    --failover-every-minutes M         failover-during-command: mean minutes between failovers per 4G agent (default 4)
    --server-pid PID | --server-pid-file FILE           sample the server's CPU and memory from /proc
    --http auto|h1|h2  --gzip auto|on|off  --tcp-keepalive-seconds S
    --drain-seconds S (120)            no new commands in the last S seconds, so every lease can settle
    --install-minutes M (10)  --offline-command-share F (0.03)  --clock-skew-share F (0.02)`;

function num(v: string | undefined, def: number, name: string, lo = 0, hi = Number.MAX_SAFE_INTEGER): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`--${name} must be a number from ${lo} to ${hi}.`);
  return n;
}

function oneOf<T extends string>(v: string | undefined, allowed: readonly T[], def: T, name: string): T {
  if (v === undefined) return def;
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`--${name} must be one of ${allowed.join(", ")}.`);
  return v as T;
}

async function main(): Promise<void> {
  const { positionals, values: v } = parseArgs({ allowPositionals: true, options: {
    count: { type: "string" }, offline: { type: "string" }, state: { type: "string" }, server: { type: "string" }, minutes: { type: "string" },
    "ramp-seconds": { type: "string" }, "commands-per-second": { type: "string" }, "events-per-hour": { type: "string" }, first: { type: "string" },
    report: { type: "string" }, scenario: { type: "string" }, protocol: { type: "string" }, links: { type: "string" }, "time-compression": { type: "string" },
    workers: { type: "string" }, seed: { type: "string" }, "restart-at-minute": { type: "string" }, "restart-exec": { type: "string" },
    "outage-at-minute": { type: "string" }, "outage-minutes": { type: "string" }, "outage-share": { type: "string" }, "preload-hours": { type: "string" },
    "failover-every-minutes": { type: "string" }, "server-pid": { type: "string" }, "server-pid-file": { type: "string" }, http: { type: "string" },
    gzip: { type: "string" }, "tcp-keepalive-seconds": { type: "string" }, "drain-seconds": { type: "string" }, "install-minutes": { type: "string" },
    "offline-command-share": { type: "string" }, "clock-skew-share": { type: "string" }, "storm-share": { type: "string" },
    help: { type: "boolean" } } });
  const state = v.state ?? "load-state.json";
  if (positionals[0] === "setup") {
    const count = num(v.count, 100, "count", 1, 50_000);
    return setup(count, state, v.offline === undefined ? undefined : num(v.offline, 0, "offline", 0, 10_000), num(v.seed, 1, "seed"));
  }
  if (positionals[0] !== "run" || v.help) { console.log(USAGE); return; }
  const scenario = oneOf<Scenario>(v.scenario, SCENARIOS, "steady", "scenario");
  const defaultLinks = scenario === "nat-drop" || scenario === "failover-during-command" ? "4g=100" : "fiber=60,dsl=25,4g=12,bad=3";
  const links = v.links ?? defaultLinks;
  parseLinkMix(links); // fails early on a bad mix
  const first = v.first === undefined ? undefined : num(v.first, 0, "first", 1, 50_000);
  const agentsHint = first ?? 10_000;
  const o: RunOptions = {
    scenario, protocol: oneOf(v.protocol, ["1.0", "1.1"] as const, "1.1", "protocol"), server: v.server ?? "https://localhost:8443", state,
    minutes: num(v.minutes, 5, "minutes", 0.5, 24 * 60), rampSeconds: num(v["ramp-seconds"], 120, "ramp-seconds", 0, 3600),
    commandsPerSecond: num(v["commands-per-second"], 2, "commands-per-second", 0, 1000), eventsPerHour: num(v["events-per-hour"], 6, "events-per-hour", 0, 3600),
    ...(first !== undefined ? { first } : {}), ...(v.report ? { report: v.report } : {}),
    workers: num(v.workers, Math.max(1, Math.min(availableParallelism(), Math.ceil(agentsHint / 2500))), "workers", 1, 64), seed: num(v.seed, 1, "seed"),
    links, timeCompression: num(v["time-compression"], 1, "time-compression", 1, 10_000), clockSkewShare: num(v["clock-skew-share"], 0.02, "clock-skew-share", 0, 1),
    restartAtMinute: num(v["restart-at-minute"], 5, "restart-at-minute", 0), ...(v["restart-exec"] ? { restartExec: v["restart-exec"] } : {}),
    outageAtMinute: num(v["outage-at-minute"], 4, "outage-at-minute", 0), outageMinutes: num(v["outage-minutes"], 20, "outage-minutes", 0),
    outageShare: num(v["outage-share"], 0.3, "outage-share", 0, 1), preloadHours: num(v["preload-hours"], 0, "preload-hours", 0, 24 * 30),
    ...(v["failover-every-minutes"] !== undefined || scenario === "failover-during-command" ? { failoverEveryMinutes: num(v["failover-every-minutes"], 4, "failover-every-minutes", 0.5) } : {}),
    ...(v["server-pid"] ? { serverPid: num(v["server-pid"], 0, "server-pid", 1) } : {}), ...(v["server-pid-file"] ? { serverPidFile: v["server-pid-file"] } : {}),
    http: oneOf(v.http, ["auto", "h1", "h2"] as const, "auto", "http"), gzip: oneOf(v.gzip, ["auto", "on", "off"] as const, "auto", "gzip"),
    ...(v["tcp-keepalive-seconds"] !== undefined ? { keepaliveSeconds: num(v["tcp-keepalive-seconds"], 20, "tcp-keepalive-seconds", 0, 7200) } : {}),
    drainSeconds: num(v["drain-seconds"], 120, "drain-seconds", 0), installMinutes: num(v["install-minutes"], 10, "install-minutes", 0, 120),
    offlineCommandShare: num(v["offline-command-share"], 0.03, "offline-command-share", 0, 1),
    stormShare: num(v["storm-share"], 0.01, "storm-share", 0, 1),
  };
  process.exitCode = await run(o);
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
