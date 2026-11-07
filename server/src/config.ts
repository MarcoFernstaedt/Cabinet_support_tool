// Configuration from environment variables only (docs/spec/05-server-spec.md "Operations").
// Secrets (database passwords) live in the environment or a secret store, never in the repository.
import { fileURLToPath } from "node:url";
import { parseDailyTime } from "./services/maintenance.js";

export interface Config {
  /** sqlserver://user:password@host:1433/database?encrypt=true&trustServerCertificate=false (Microsoft SQL Server). */
  databaseUrl: string;
  /** longPollSeconds: how long a poll is held; unset, it follows the platform's pacing setting (default 25). */
  agentApi: { host: string; port: number; hostnames: string[]; longPollSeconds?: number; http2: boolean; workers: number; admission: { newConnectionsPerSecond: number; requestsPerSecond: number; maxConnectionsPerSource: number } };
  /** Separate connection pools, so console work and background jobs can never take the connections agents need. */
  database: { agentPoolMax: number; consolePoolMax: number; jobsPoolMax: number };
  tls: { certFile?: string; keyFile?: string };
  devPkiDir?: string;
  /** The software library: where approved packages are stored (read-only files), and the size limit. */
  packages: { dir: string; maxBytes: number; trustDir?: string };
  /** The update store for signed agent releases, and the release keys the server checks uploads against (the agent checks again with its own). */
  releases: { dir: string; maxBytes: number; keysDir?: string };
  /** A folder laid out like contracts/trust/approved-list, for tests only; production uses that folder, which the agent compiles in. */
  approvedListKeysDir?: string;
  console?: { host: string; port: number; origin: string; secretKey: string; staticDir: string; trustProxy: number | string | false };
  /** What the setup page tells an Admin about installing the agent: the address cabinets use to reach the agent API, and the folder holding the agent package to download (optional). */
  agentSetup: { host: string; port: number; downloadDir?: string; allowUnsigned: boolean; production?: boolean };
  /** When the nightly audit check and retention run, server local time (MAINTENANCE_AT, HH:MM, default 02:30). */
  maintenanceAt: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} must be set.`);
  return v;
}

/** The database URL must be a SQL Server one. The error never repeats the URL: it holds the password. */
export function databaseUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!value.startsWith("sqlserver://")) throw new Error(`${name} must be a sqlserver:// URL (Microsoft SQL Server).`);
  return value;
}

/** The nightly maintenance time, checked here so a typo stops the server at start rather than at night. */
function maintenanceAt(value: string | undefined): string {
  parseDailyTime(value);
  return value?.trim() ?? "02:30";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.AGENT_API_PORT ?? "8443");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AGENT_API_PORT must be a port number.");
  const longPollSeconds = env.AGENT_LONG_POLL_SECONDS === undefined ? undefined : Number(env.AGENT_LONG_POLL_SECONDS);
  if (longPollSeconds !== undefined && !(Number.isInteger(longPollSeconds) && longPollSeconds >= 1 && longPollSeconds <= 110)) throw new Error("AGENT_LONG_POLL_SECONDS must be 1 to 110.");
  const whole = (name: string, fallback: number, min: number, max: number): number => {
    const v = Number(env[name] ?? fallback);
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
    return v;
  };
  // The names and addresses an agent may dial; the development TLS certificate covers exactly these, and the first is
  // what the setup page offers when AGENT_PUBLIC_HOST is unset. An empty value is treated as unset on purpose: compose
  // passes both switches through with an empty default, and "" would otherwise fail validation at start and, worse,
  // reach the installer as the address a cabinet is told to dial.
  const agentHostnames = (env.AGENT_API_HOSTNAMES ?? "localhost").split(",").map(s => s.trim()).filter(Boolean);
  if (agentHostnames.length === 0) agentHostnames.push("localhost");
  const publicHost = (env.AGENT_PUBLIC_HOST ?? "").trim() || agentHostnames[0]!;
  const publicPort = (env.AGENT_PUBLIC_PORT ?? "").trim();
  const config: Config = {
    databaseUrl: databaseUrl(env, "DATABASE_URL"),
    agentApi: { host: env.AGENT_API_HOST ?? "0.0.0.0", port, hostnames: agentHostnames,
      ...(longPollSeconds !== undefined ? { longPollSeconds } : {}),
      // HTTP/2 is offered (ALPN, with HTTP/1.1 on the same port); AGENT_API_HTTP2=false offers HTTP/1.1 only.
      http2: env.AGENT_API_HTTP2 !== "false",
      // Processes serving the agent port (Node's cluster module shares it). One is enough for a few thousand cabinets; at 10,000 a single
      // process's event loop is the limit (TLS, HTTP/2 and the database driver all run on it), so use 2 or more on a 4-core server.
      workers: whole("AGENT_API_WORKERS", 1, 1, 16),
      admission: { newConnectionsPerSecond: whole("AGENT_NEW_CONNECTIONS_PER_SECOND", 300, 1, 10_000), requestsPerSecond: whole("AGENT_REQUESTS_PER_SECOND", 2_000, 10, 100_000),
        // Open connections from one address (an IPv4 address or IPv6 /64). Raise it only where many cabinets share one address.
        maxConnectionsPerSource: whole("AGENT_MAX_CONNECTIONS_PER_SOURCE", 256, 1, 100_000) } },
    database: { agentPoolMax: whole("AGENT_DB_POOL_MAX", 20, 4, 200), consolePoolMax: whole("CONSOLE_DB_POOL_MAX", 10, 4, 100), jobsPoolMax: whole("JOBS_DB_POOL_MAX", 4, 1, 50) },
    tls: {},
    packages: { dir: env.PACKAGE_DIR ?? fileURLToPath(new URL("../../../data/packages", import.meta.url)), maxBytes: Number(env.PACKAGE_MAX_MB ?? "500") * 1024 * 1024 },
    releases: { dir: env.RELEASE_DIR ?? fileURLToPath(new URL("../../../data/releases", import.meta.url)), maxBytes: 500 * 1024 * 1024 },
    maintenanceAt: maintenanceAt(env.MAINTENANCE_AT),
    agentSetup: { host: publicHost, port: publicPort === "" ? port : Number(publicPort),
      // Decided per package folder (setup-routes.ts): unsigned only when the build says so, and never in production.
      allowUnsigned: false },
  };
  if (env.AGENT_DOWNLOAD_DIR) config.agentSetup.downloadDir = env.AGENT_DOWNLOAD_DIR;
  config.agentSetup.production = env.NODE_ENV === "production";
  if (!Number.isInteger(config.agentSetup.port) || config.agentSetup.port < 1 || config.agentSetup.port > 65535) throw new Error("AGENT_PUBLIC_PORT must be a port number.");
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(config.agentSetup.host)) throw new Error("AGENT_PUBLIC_HOST must be a host name or IPv4 address.");
  // Other release keys are for tests only (a throwaway key made for the run); production uses contracts/trust/upgrade, the file the agent compiles in.
  if (env.UPGRADE_KEYS_DIR) {
    if (env.NODE_ENV === "production") throw new Error("UPGRADE_KEYS_DIR is for tests and refuses to run in production.");
    config.releases.keysDir = env.UPGRADE_KEYS_DIR;
  }
  if (env.APPROVED_LIST_KEYS_DIR) {
    if (env.NODE_ENV === "production") throw new Error("APPROVED_LIST_KEYS_DIR is for tests and refuses to run in production.");
    config.approvedListKeysDir = env.APPROVED_LIST_KEYS_DIR;
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
      trustProxy: trustProxy(env.CONSOLE_TRUST_PROXY),
    };
  }
  return config;
}

/**
 * Which proxy to believe about the client's address. Never "any": the left of X-Forwarded-For is whatever the client
 * sent, which would let it dodge the sign-in limits and put a false address in the audit log. A number is how many
 * proxies stand in front (1 = take the address the nearest proxy saw); otherwise a comma-separated list of the proxies'
 * own addresses or ranges.
 */
export function trustProxy(value: string | undefined): number | string | false {
  if (!value) return false;
  if (/^[1-5]$/.test(value)) return Number(value);
  const parts = value.split(",").map(p => p.trim());
  if (parts.every(p => /^[0-9A-Fa-f.:]+(\/\d{1,3})?$/.test(p) && /[.:]/.test(p))) return value;
  throw new Error("CONSOLE_TRUST_PROXY must be the number of proxies in front (1 to 5) or their addresses.");
}
