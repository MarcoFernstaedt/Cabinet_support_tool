// Starts the agent API, the console API when configured, and the offline alert job.
import { scheduleDailyJobs } from "./services/maintenance.js";
import { expireRules } from "./services/rules.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/db.js";
import { CommandNotifier } from "./agent-api/notifier.js";
import { buildAgentApi } from "./agent-api/server.js";
import { agentApiTls, issuingKey } from "./runtime.js";
import { buildConsoleApi } from "./console-api/server.js";
import { ResultStream } from "./console-api/stream.js";
import { SecretBox } from "./auth/secrets.js";
import { checkOffline } from "./services/alerts.js";
import { expireUnanswered } from "./services/commands.js";
import { TrustList } from "./packages/trust.js";
import { mkdirSync } from "node:fs";
import { ReleaseKeys } from "./services/releases.js";
import { checkRollouts } from "./services/rollouts.js";
import { DemoSimulator } from "./demo/demo.js";
import { checkQuietLoops } from "./services/crashes.js";
import { resumeJobs } from "./services/fleet-jobs.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl, 20);
const key = await issuingKey(config);
mkdirSync(config.packages.dir, { recursive: true, mode: 0o700 });
const packages = { dir: config.packages.dir, maxBytes: config.packages.maxBytes, trust: TrustList.fromFolder(config.packages.trustDir) };
mkdirSync(config.releases.dir, { recursive: true, mode: 0o700 });
const releases = { dir: config.releases.dir, maxBytes: config.releases.maxBytes, keys: ReleaseKeys.fromFolder(config.releases.keysDir) };
const notifier = new CommandNotifier(config.databaseUrl);
await notifier.start();
const app = await buildAgentApi({ pool, issuingKey: key, notifier, packages, releases, tls: await agentApiTls(config, key), longPollMs: config.agentApi.longPollSeconds * 1000 });
await app.listen({ host: config.agentApi.host, port: config.agentApi.port });

let consoleApp: Awaited<ReturnType<typeof buildConsoleApi>> | null = null;
let stream: ResultStream | null = null;
if (config.console) {
  stream = new ResultStream(config.databaseUrl, pool);
  await stream.start();
  consoleApp = await buildConsoleApi({ pool, secrets: new SecretBox(config.console.secretKey), issuingKey: key, origin: config.console.origin,
    stream, packages, releases, staticDir: config.console.staticDir, trustProxy: config.console.trustProxy, agentSetup: config.agentSetup });
  await consoleApp.listen({ host: config.console.host, port: config.console.port });
}

// Cabinets past the offline alert threshold get a real alert; ones that are back resolve theirs.
const offlineJob = setInterval(() => {
  checkOffline(pool).catch(e => app.log.error({ err: { type: (e as Error).name } }, "offline alert check failed"));
  expireUnanswered(pool).catch(e => app.log.error({ err: { type: (e as Error).name } }, "unanswered command check failed"));
  expireRules(pool).catch(e => app.log.error({ err: { type: (e as Error).name } }, "rule expiry failed"));
  checkRollouts(pool).catch(e => app.log.error({ err: { type: (e as Error).name } }, "rollout check failed"));
  checkQuietLoops(pool).catch(e => app.log.error({ err: { type: (e as Error).name } }, "reboot loop check failed"));
}, 60_000);

// Simulated cabinets answer only while an Admin has demo mode on (docs/platform/demo.md).
const demo = new DemoSimulator(pool, message => app.log.error(message));
demo.start();

// Fleet jobs that were running when the server stopped carry on where they left off.
resumeJobs(pool, undefined, message => app.log.error(message)).catch(e => app.log.error({ err: { type: (e as Error).name } }, "resuming fleet jobs failed"));

// The daily audit chain check (a break raises a security alert) and retention.
const stopDaily = scheduleDailyJobs(pool, message => app.log.error(message));

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => { void (async () => { clearInterval(offlineJob); demo.stop(); stopDaily(); await app.close(); await consoleApp?.close(); await stream?.stop(); await notifier.stop(); await pool.end(); process.exit(0); })(); });
