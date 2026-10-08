// Configuration from environment variables only (docs/spec/05-server-spec.md "Operations").
// Secrets (database passwords) live in the environment or a secret store, never in the repository.
import { fileURLToPath } from "node:url";

export interface Config {
  databaseUrl: string;
  agentApi: { host: string; port: number; hostnames: string[]; longPollSeconds: number };
  tls: { certFile?: string; keyFile?: string };
  devPkiDir?: string;
  /** The software library: where approved packages are stored (read-only files), and the size limit. */
  packages: { dir: string; maxBytes: number; trustDir?: string };
  /** The update store for signed agent releases, and the release keys the server checks uploads against (the agent checks again with its own). */
  releases: { dir: string; maxBytes: number; keysDir?: string };
  console?: { host: string; port: number; origin: string; secretKey: string; staticDir: string; trustProxy: boolean };
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
    packages: { dir: env.PACKAGE_DIR ?? fileURLToPath(new URL("../../../data/packages", import.meta.url)), maxBytes: Number(env.PACKAGE_MAX_MB ?? "500") * 1024 * 1024 },
    releases: { dir: env.RELEASE_DIR ?? fileURLToPath(new URL("../../../data/releases", import.meta.url)), maxBytes: 500 * 1024 * 1024 },
  };
  // Other release keys are for tests only (a throwaway key made for the run); production uses contracts/trust/upgrade, the file the agent compiles in.
  if (env.UPGRADE_KEYS_DIR) {
    if (env.NODE_ENV === "production") throw new Error("UPGRADE_KEYS_DIR is for tests and refuses to run in production.");
    config.releases.keysDir = env.UPGRADE_KEYS_DIR;
  }
  if (!(config.packages.maxBytes > 0 && config.packages.maxBytes <= 2 * 1024 * 1024 * 1024)) throw new Error("PACKAGE_MAX_MB must be 1 to 2048.");
  // A different trusted publisher list is for tests only; production always uses contracts/trust, the list the agent compiles in.
  if (env.PACKAGE_TRUST_DIR) {
    if (env.NODE_ENV === "production") throw new Error("PACKAGE_TRUST_DIR is for tests and refuses to run in production.");
    config.packages.trustDir = env.PACKAGE_TRUST_DIR;
  }
  if (env.AGENT_TLS_CERT_FILE) config.tls.certFile = env.AGENT_TLS_CERT_FILE;
  if (env.AGENT_TLS_KEY_FILE) config.tls.keyFile = env.AGENT_TLS_KEY_FILE;
  if (env.DEV_PKI_DIR) config.devPkiDir = env.DEV_PKI_DIR;
  // The console listener runs when its origin is configured.
  if (env.CONSOLE_ORIGIN) {
    const consolePort = Number(env.CONSOLE_PORT ?? "8080");
    if (!Number.isInteger(consolePort) || consolePort < 1 || consolePort > 65535) throw new Error("CONSOLE_PORT must be a port number.");
    config.console = {
      host: env.CONSOLE_HOST ?? "127.0.0.1", port: consolePort, origin: env.CONSOLE_ORIGIN,
      secretKey: required(env, "CONSOLE_SECRET_KEY"), staticDir: env.CONSOLE_STATIC_DIR ?? fileURLToPath(new URL("../../../console/dist", import.meta.url)),
      trustProxy: env.CONSOLE_TRUST_PROXY === "1",
    };
  }
  return config;
}
