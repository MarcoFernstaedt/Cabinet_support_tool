// Starts the agent API, the console API when configured, and the offline alert job.
import { scheduleDailyJobs } from "./services/maintenance.js";
import { expireRules } from "./services/rules.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/db.js";
import { NotificationFeed } from "./db/notifications.js";
import { CommandNotifier } from "./agent-api/notifier.js";
import { buildAgentApi } from "./agent-api/server.js";
import { Presence } from "./agent-api/presence.js";
import { agentApiTls, issuingKey } from "./runtime.js";
import { buildConsoleApi } from "./console-api/server.js";
import { ResultStream } from "./console-api/stream.js";
import { SecretBox } from "./auth/secrets.js";
import { checkOffline } from "./services/alerts.js";
import { checkSiteOutages } from "./services/site-outage.js";
import { expireUnanswered } from "./services/commands.js";
import { checkExpiringCertificates } from "./services/cabinets.js";
import { TrustList } from "./packages/trust.js";
import { mkdirSync } from "node:fs";
import { ReleaseKeys } from "./services/releases.js";
import { checkRollouts } from "./services/rollouts.js";
import { DemoSimulator } from "./demo/demo.js";
import { checkQuietLoops } from "./services/crashes.js";
import { resumeJobs } from "./services/fleet-jobs.js";

const config = loadConfig();
// Three pools, so neither console work nor a background job can take the connections the agents need: the agent API's (and the
// notification feed that wakes its long polls), the console's, and the background jobs' (whose statements may run longer).
const agentPool = await createPool(config.databaseUrl, { max: config.database.agentPoolMax });
const consolePool = await createPool(config.databaseUrl, { max: config.database.consolePoolMax });
const jobsPool = await createPool(config.databaseUrl, { max: config.database.jobsPoolMax, min: 1, requestTimeoutMs: 120_000 });
// One poller of the notifications table per process; the command long poll and the consoles' live stream listen to it.
const feed = new NotificationFeed(agentPool);
await feed.start();
const key = await issuingKey(config);
mkdirSync(config.packages.dir, { recursive: true, mode: 0o700 });
const packages = { dir: config.packages.dir, maxBytes: config.packages.maxBytes, trust: TrustList.fromFolder(config.packages.trustDir) };
mkdirSync(config.releases.dir, { recursive: true, mode: 0o700 });
const releases = { dir: config.releases.dir, maxBytes: config.releases.maxBytes, keys: ReleaseKeys.fromFolder(config.releases.keysDir) };
const notifier = new CommandNotifier(feed);
// Without this the long polls would fall back to re-checking the database every 5 s.
await notifier.start();
const log = (message: string): void => { app.log.error(message); };
// Contact from long polls, written in one batched statement a minute.
const presence = new Presence(agentPool, message => log(message));
presence.start();
const { newConnectionsPerSecond, requestsPerSecond } = config.agentApi.admission;
const app = await buildAgentApi({ pool: agentPool, issuingKey: key, notifier, packages, releases, presence, tls: await agentApiTls(config, key), http2: config.agentApi.http2,
  ...(config.agentApi.longPollSeconds !== undefined ? { longPollMs: config.agentApi.longPollSeconds * 1000 } : {}),
  admission: { newConnectionsPerSecond, newConnectionsBurst: newConnectionsPerSecond * 3, requestsPerSecond, requestsBurst: requestsPerSecond * 2,
    maxPendingAcquires: config.database.agentPoolMax } });
await app.listen({ host: config.agentApi.host, port: config.agentApi.port });

let consoleApp: Awaited<ReturnType<typeof buildConsoleApi>> | null = null;
let stream: ResultStream | null = null;
if (config.console) {
  stream = new ResultStream(feed, consolePool);
  await stream.start();
  consoleApp = await buildConsoleApi({ pool: consolePool, secrets: new SecretBox(config.console.secretKey), issuingKey: key, origin: config.console.origin,
    stream, packages, releases, staticDir: config.console.staticDir, trustProxy: config.console.trustProxy, agentSetup: config.agentSetup });
  await consoleApp.listen({ host: config.console.host, port: config.console.port });
}

// Cabinets past the offline alert threshold get a real alert; ones that are back resolve theirs.
let minutes = 0;
const offlineJob = setInterval(() => {
  checkOffline(jobsPool).catch(e => app.log.error({ err: { type: (e as Error).name } }, "offline alert check failed"));
  checkSiteOutages(jobsPool).catch(e => app.log.error({ err: { type: (e as Error).name } }, "site outage check failed"));
  expireUnanswered(jobsPool).catch(e => app.log.error({ err: { type: (e as Error).name } }, "unanswered command check failed"));
  expireRules(jobsPool).catch(e => app.log.error({ err: { type: (e as Error).name } }, "rule expiry failed"));
  checkRollouts(jobsPool).catch(e => app.log.error({ err: { type: (e as Error).name } }, "rollout check failed"));
  checkQuietLoops(jobsPool).catch(e => app.log.error({ err: { type: (e as Error).name } }, "reboot loop check failed"));
  // Hourly: a security alert a week before an active cabinet's unrenewed certificate expires.
  if (minutes++ % 60 === 0)
    checkExpiringCertificates(jobsPool).catch(e => app.log.error({ err: { type: (e as Error).name } }, "certificate expiry check failed"));
}, 60_000);

// Simulated cabinets answer only while an Admin has demo mode on (docs/platform/demo.md).
const demo = new DemoSimulator(jobsPool, message => app.log.error(message));
demo.start();

// Fleet jobs that were running when the server stopped carry on where they left off.
resumeJobs(jobsPool, undefined, message => app.log.error(message)).catch(e => app.log.error({ err: { type: (e as Error).name } }, "resuming fleet jobs failed"));

// The daily audit chain check (a break raises a security alert) and retention.
const stopDaily = scheduleDailyJobs(jobsPool, message => app.log.error(message));

// On shutdown every held poll is answered with a reconnectAfterMs spread over a minute, so the restart does not bring every
// cabinet back in the same second; the contact noted since the last minute is written before the pools close.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => { void (async () => {
    clearInterval(offlineJob); demo.stop(); stopDaily();
    await app.close(); await presence.stop(); await consoleApp?.close(); await stream?.stop(); await notifier.stop(); feed.stop();
    await Promise.all([agentPool.end(), consolePool.end(), jobsPool.end()]);
    process.exit(0);
  })(); });
