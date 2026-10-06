// Configuration from environment variables only (docs/spec/05-server-spec.md "Operations").
// Secrets (database passwords) live in the environment or a secret store, never in the repository.

export interface Config {
  databaseUrl: string;
  agentApi: { host: string; port: number; hostnames: string[]; longPollSeconds: number };
  tls: { certFile?: string; keyFile?: string };
  devPkiDir?: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} must be set.`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.AGENT_API_PORT ?? "8443");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AGENT_API_PORT must be a port number.");
  const longPollSeconds = Number(env.AGENT_LONG_POLL_SECONDS ?? "25");
  if (!(longPollSeconds >= 1 && longPollSeconds <= 25)) throw new Error("AGENT_LONG_POLL_SECONDS must be 1 to 25.");
  const config: Config = {
    databaseUrl: required(env, "DATABASE_URL"),
    agentApi: { host: env.AGENT_API_HOST ?? "0.0.0.0", port, hostnames: (env.AGENT_API_HOSTNAMES ?? "localhost").split(",").map(s => s.trim()).filter(Boolean), longPollSeconds },
    tls: {},
  };
  if (env.AGENT_TLS_CERT_FILE) config.tls.certFile = env.AGENT_TLS_CERT_FILE;
  if (env.AGENT_TLS_KEY_FILE) config.tls.keyFile = env.AGENT_TLS_KEY_FILE;
  if (env.DEV_PKI_DIR) config.devPkiDir = env.DEV_PKI_DIR;
  return config;
}
