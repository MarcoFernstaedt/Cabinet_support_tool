// Starts the agent API. The console API listener arrives in milestone 3.
import { loadConfig } from "./config.js";
import { createPool } from "./db/db.js";
import { CommandNotifier } from "./agent-api/notifier.js";
import { buildAgentApi } from "./agent-api/server.js";
import { agentApiTls, issuingKey } from "./runtime.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl, 20);
const key = await issuingKey(config);
const notifier = new CommandNotifier(config.databaseUrl);
await notifier.start();
const app = await buildAgentApi({ pool, issuingKey: key, notifier, tls: await agentApiTls(config, key), longPollMs: config.agentApi.longPollSeconds * 1000 });
await app.listen({ host: config.agentApi.host, port: config.agentApi.port });

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => { void (async () => { await app.close(); await notifier.stop(); await pool.end(); process.exit(0); })(); });
