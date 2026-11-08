// Starts the agent API, the console API when configured, and the background jobs. With AGENT_API_WORKERS > 1 the agent API runs in
// that many worker processes sharing its port (node:cluster), and this primary process runs the console and the background jobs only,
// so a 10,000-cabinet fleet is not limited to one event loop. Each process has its own pools, notification feed and presence flush.
import { scheduleDailyJobs } from "./services/maintenance.js";
import { OpsReporter } from "./services/ops-meter.js";
import { scheduleOpsChecks } from "./services/ops-health.js";
import { clusterNewCrashKinds } from "./services/crash-clusters.js";
import { scheduleTroubleshootingJobs } from "./services/error-trends.js";
import { expireRules, flushRuleHits } from "./services/rules.js";
import { loadConfig } from "./config.js";
import { createPool, errorInfo } from "./db/db.js";
import { NotificationFeed } from "./db/notifications.js";
import { CommandNotifier } from "./agent-api/notifier.js";
import { buildAgentApi } from "./agent-api/server.js";
import { Presence } from "./agent-api/presence.js";
import { agentApiTls, issuingKey } from "./runtime.js";
import { buildConsoleApi } from "./console-api/server.js";
import { ResultStream } from "./console-api/stream.js";
import { SecretBox } from "./auth/secrets.js";
import { checkOffline, fleetContact } from "./services/alerts.js";
import { checkSiteOutages } from "./services/site-outage.js";
import { sweepFleetPatterns } from "./services/fleet-patterns.js";
import { expireCommands } from "./services/commands.js";
import { checkExpiringCertificates } from "./services/cabinets.js";
import { TrustList } from "./packages/trust.js";
import { mkdirSync } from "node:fs";
import { ListSigningKeys } from "./services/approved-list-signing.js";
import { ReleaseKeys } from "./services/releases.js";
import { checkRollouts } from "./services/rollouts.js";
import { DemoSimulator } from "./demo/demo.js";
import { checkQuietLoops } from "./services/crashes.js";
import { sweepCrashIncidents } from "./services/crash-incidents.js";
import { sweepHealth } from "./services/cabinet-health.js";
import { leased, takeLease } from "./services/job-lease.js";
import { resumeJobs } from "./services/fleet-jobs.js";
import { startDueReapplies } from "./services/replacement-reapply.js";

import cluster from "node:cluster";
import { createHmac, randomBytes } from "node:crypto";
const config = loadConfig();
const workers = config.agentApi.workers;
const servesAgents = workers === 1 || cluster.isWorker;
const runsServices = workers === 1 || cluster.isPrimary;

// Pools: the agent API's (and the notification feed that wakes its long polls), the console's, and the background jobs' (whose
// statements may run longer), so neither console work nor a job can take the connections the agents need.
const agentPool = servesAgents ? await createPool(config.databaseUrl, { max: config.database.agentPoolMax }) : null;
const consolePool = runsServices ? await createPool(config.databaseUrl, { max: config.database.consolePoolMax }) : null;
const jobsPool = runsServices ? await createPool(config.databaseUrl, { max: config.database.jobsPoolMax, min: 1, requestTimeoutMs: 120_000 }) : null;
// One poller of the notifications table per process; the command long poll and the consoles' live stream listen to it.
const feed = new NotificationFeed((agentPool ?? consolePool)!);
await feed.start();
const key = await issuingKey(config);
mkdirSync(config.packages.dir, { recursive: true, mode: 0o700 });
const packages = { dir: config.packages.dir, maxBytes: config.packages.maxBytes, trust: TrustList.fromFolder(config.packages.trustDir) };
mkdirSync(config.releases.dir, { recursive: true, mode: 0o700 });
const releases = { dir: config.releases.dir, maxBytes: config.releases.maxBytes, keys: ReleaseKeys.fromFolder(config.releases.keysDir) };
let logError: (message: string) => void = message => console.error(message);

// ---- The agent API (in every worker, or in the only process) ---------------------------------------------------------------------
let app: Awaited<ReturnType<typeof buildAgentApi>> | null = null;
let notifier: CommandNotifier | null = null;
let presence: Presence | null = null;
if (servesAgents) {
  notifier = new CommandNotifier(feed);
  // Without this the long polls would fall back to re-checking the database every 5 s.
  await notifier.start();
  // Contact from long polls, written in one batched statement a minute.
  presence = new Presence(agentPool!, message => logError(message));
  presence.start();
  // Workers share one secret (from the primary), so a TLS session resumes in whichever worker the reconnect reaches.
  const secret = process.env.AGENT_TICKET_SECRET;
  const ticketKey = workers > 1 && secret ? (day: number) => createHmac("sha384", Buffer.from(secret, "hex")).update(`ticket:${day}`).digest() : undefined;
  const { newConnectionsPerSecond, requestsPerSecond, maxConnectionsPerSource } = config.agentApi.admission;
  app = await buildAgentApi({ pool: agentPool!, issuingKey: key, notifier, packages, releases, presence, tls: await agentApiTls(config, key), http2: config.agentApi.http2,
    ...(config.agentApi.longPollSeconds !== undefined ? { longPollMs: config.agentApi.longPollSeconds * 1000 } : {}),
    ...(ticketKey ? { ticketKey } : {}),
    admission: { newConnectionsPerSecond, newConnectionsBurst: newConnectionsPerSecond * 3, requestsPerSecond, requestsBurst: requestsPerSecond * 2, maxConnectionsPerSource,
      maxPendingAcquires: config.database.agentPoolMax } });
  const agentLog = app.log;
  logError = message => agentLog.error(message);
  await app.listen({ host: config.agentApi.host, port: config.agentApi.port });
}

// ---- Operations counters: written from memory once a minute, with the pools' connection waits and the event loop's delay ----------------
// Every process (each worker, or the only process) reports its own; counts add up in the database.
const opsReporter = new OpsReporter({ pool: (jobsPool ?? agentPool)!, log: message => logError(message),
  sampled: { ...(agentPool ? { agent: agentPool } : {}), ...(consolePool ? { console: consolePool } : {}) } });
opsReporter.start();

// ---- The agent API workers (primary of a multi-process server) ------------------------------------------------------------------
let stopping = false;
if (workers > 1 && cluster.isPrimary) {
  const env = { AGENT_TICKET_SECRET: randomBytes(32).toString("hex") };
  const fork = (): void => { cluster.fork(env); };
  for (let i = 0; i < workers; i++) fork();
  // A worker that stops on its own is replaced (after a pause, so a crash loop does not spin).
  cluster.on("exit", (w, code, signal) => {
    if (stopping) return;
    logError(`agent API worker ${w.process.pid} stopped (${signal ?? code}); starting another`);
    setTimeout(fork, 2_000);
  });
}

// ---- The console and the background jobs (in the primary, or in the only process) -----------------------------------------------
let consoleApp: Awaited<ReturnType<typeof buildConsoleApi>> | null = null;
let stream: ResultStream | null = null;
let stopServices = (): void => undefined;
if (runsServices) {
  if (config.console) {
    stream = new ResultStream(feed, consolePool!);
    await stream.start();
    consoleApp = await buildConsoleApi({ pool: consolePool!, secrets: new SecretBox(config.console.secretKey), issuingKey: key, origin: config.console.origin,
      stream, packages, releases, listKeys: ListSigningKeys.fromFolder(config.approvedListKeysDir), staticDir: config.console.staticDir, trustProxy: config.console.trustProxy, agentSetup: config.agentSetup });
    await consoleApp.listen({ host: config.console.host, port: config.console.port });
  }
  const jobs = jobsPool!;
  const failed = (what: string) => (e: unknown): void => logError(`${what} failed: ${JSON.stringify(errorInfo(e))}`);

  // Cabinets past the offline alert threshold get a real alert; ones that are back resolve theirs. Not right after the server (or its
  // database) was away, though: every cabinet would look silent then (FleetContact holds those judgements until the fleet has reported again).
  // Contact includes long polls (Presence writes them each minute), so 1.1 agents heartbeating every 5 minutes stay online.
  fleetContact.start();
  let minutes = 0;
  // One writer per job across server instances (F21.R1, decision-log D49): each job runs only while this instance holds its lease. A
  // lease outlasts the job's interval, so its holder keeps it; another instance takes it over once a holder stops renewing.
  const lease = (name: string, ms: number) => () => takeLease(jobs, name, ms);
  const everyMinute = leased(jobs, "jobs.minute", 150_000, () => {
    checkOffline(jobs).catch(failed("offline alert check"));
    checkSiteOutages(jobs).catch(failed("site outage check"));
    // The same problem at many sites at once is one fleet alert with a report (D22).
    sweepFleetPatterns(jobs).catch(failed("fleet pattern check"));
    expireCommands(jobs).catch(failed("command expiry"));
    expireRules(jobs).catch(failed("rule expiry"));
    checkRollouts(jobs).catch(failed("rollout check"));
    checkQuietLoops(jobs).then(() => sweepCrashIncidents(jobs)).catch(failed("reboot loop and crash incident check"));
    // Health against the baselines: contact can lapse, and come back, with no event to trigger a judgement.
    sweepHealth(jobs).catch(failed("health sweep"));
    // Hourly: a new kind of blue screen on 2 or more cabinets is its own fleet pattern (F17, D52).
    if (minutes % 60 === 0) clusterNewCrashKinds(jobs).catch(failed("new crash kind check"));
    // Hourly: a security alert a week before an active cabinet's unrenewed certificate expires.
    if (minutes++ % 60 === 0) checkExpiringCertificates(jobs).catch(failed("certificate expiry check"));
  });
  const offlineJob = setInterval(() => { void everyMinute().catch(failed("minute jobs lease")); }, 60_000);

  // Simulated cabinets answer only while an Admin has demo mode on (docs/platform/demo.md).
  const demo = new DemoSimulator(jobs, message => logError(message)).onlyWhile(() => takeLease(jobs, "jobs.demo", 15_000));
  demo.start();

  // Fleet jobs that were running when the server stopped carry on where they left off.
  void leased(jobs, "jobs.resume-fleet-jobs", 600_000, () => resumeJobs(jobs, undefined, message => logError(message)))().catch(failed("resuming fleet jobs"));
  // A replacement's settings are put back once its new agent reports; one that was running when the server stopped carries on.
  const reapply = leased(jobs, "jobs.reapply", 45_000, () => startDueReapplies(jobs, undefined, message => logError(message)));
  const reapplyJob = setInterval(() => { void reapply().catch(failed("replacement re-apply")); }, 15_000);

  // The daily audit chain check (a break raises a security alert) and retention.
  const stopDaily = scheduleDailyJobs(jobs, message => logError(message), { at: config.maintenanceAt,
    runIf: job => takeLease(jobs, `jobs.${job}`, job === "daily" ? 6 * 3_600_000 : 2 * 3_600_000) });
  // Database size, free disk, backup age and CA expiry: one open operations alert per kind, shown in the console (no outbound notification).
  const stopOpsChecks = scheduleOpsChecks(jobs, message => logError(message), { caCertificatePem: key.certificatePem }, 600_000, lease("jobs.ops-checks", 1_500_000));
  const stopTrends = scheduleTroubleshootingJobs(jobs, message => logError(message), { at: config.maintenanceAt, runIf: lease("jobs.error-trends", 6 * 3_600_000) });
  stopServices = () => { clearInterval(offlineJob); clearInterval(reapplyJob); demo.stop(); stopDaily(); stopOpsChecks(); stopTrends(); };
}

// On shutdown every held poll is answered with a reconnectAfterMs spread over a minute, so the restart does not bring every
// cabinet back in the same second; the contact noted since the last minute is written before the pools close. The primary of a
// multi-process server stops its workers first and waits for them.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => { void (async () => {
    stopping = true;
    stopServices();
    if (workers > 1 && cluster.isPrimary) {
      const alive = Object.values(cluster.workers ?? {}).filter((w): w is NonNullable<typeof w> => !!w);
      await Promise.all(alive.map(w => new Promise<void>(resolve => { w.once("exit", () => resolve()); w.process.kill(signal); })));
    }
    await flushRuleHits().catch(() => undefined);
    await opsReporter.stop().catch(() => undefined);
    await app?.close(); await presence?.stop(); await consoleApp?.close(); await stream?.stop(); await notifier?.stop(); feed.stop();
    await Promise.all([agentPool?.end(), consolePool?.end(), jobsPool?.end()]);
    process.exit(0);
  })(); });
