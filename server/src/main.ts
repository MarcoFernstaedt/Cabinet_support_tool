// Starts the agent API. The console API listener arrives in milestone 3.
import { loadConfig } from "./config.js";
import { createPool } from "./db/db.js";
import { CommandNotifier } from "./agent-api/notifier.js";
import { buildAgentApi } from "./agent-api/server.js";
import { agentApiTls, issuingKey } from "./runtime.js";
import { buildConsoleApi } from "./console-api/server.js";
import { ResultStream } from "./console-api/stream.js";
import { SecretBox } from "./auth/secrets.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl, 20);
const key = await issuingKey(config);
const notifier = new CommandNotifier(config.databaseUrl);
await notifier.start();
const app = await buildAgentApi({ pool, issuingKey: key, notifier, tls: await agentApiTls(config, key), longPollMs: config.agentApi.longPollSeconds * 1000 });
await app.listen({ host: config.agentApi.host, port: config.agentApi.port });

let consoleApp: Awaited<ReturnType<typeof buildConsoleApi>> | null = null;
let stream: ResultStream | null = null;
if (config.console) {
  stream = new ResultStream(config.databaseUrl, pool);
  await stream.start();
  consoleApp = await buildConsoleApi({ pool, secrets: new SecretBox(config.console.secretKey), issuingKey: key, origin: config.console.origin,
    stream, staticDir: config.console.staticDir, trustProxy: config.console.trustProxy });
  await consoleApp.listen({ host: config.console.host, port: config.console.port });
}

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => { void (async () => { await app.close(); await consoleApp?.close(); await stream?.stop(); await notifier.stop(); await pool.end(); process.exit(0); })(); });
