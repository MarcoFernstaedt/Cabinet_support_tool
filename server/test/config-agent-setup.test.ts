// A cabinet is told exactly one address to dial, and the setup page bakes it into the installer the Admin runs (the
// launcher writes $serverHost). That address is AGENT_PUBLIC_HOST, or the first name in AGENT_API_HOSTNAMES when it is
// unset. Compose passes both switches through with an empty default, so "" reaches the server whenever a deployment
// leaves them out: treating an empty value as unset is the difference between an installer pointed at the address a
// cabinet can actually reach and one pointed at whatever name happens to be listed first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

const root = join(import.meta.dirname, "..", "..", "..");
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: "sqlserver://cabinet_app_login:pw@mssql:1433/cabinet?trustServerCertificate=true",
  AGENT_API_HOSTNAMES: "cabinets.example.com,10.0.0.5,localhost",
  ...extra,
});

test("the public address is used when it is set", () => {
  // TEST-NET-3 is reserved for documentation.
  const config = loadConfig(env({ AGENT_PUBLIC_HOST: "203.0.113.10" }));
  assert.equal(config.agentSetup.host, "203.0.113.10");
  assert.equal(config.agentSetup.port, 8443);
});

test("an empty public address falls back to the first hostname, so compose can pass it through unset", () => {
  assert.equal(loadConfig(env({ AGENT_PUBLIC_HOST: "" })).agentSetup.host, "cabinets.example.com");
  assert.equal(loadConfig(env({ AGENT_PUBLIC_HOST: "   " })).agentSetup.host, "cabinets.example.com");
  assert.equal(loadConfig(env()).agentSetup.host, "cabinets.example.com");
});

test("a public port is used when set, and the agent API port when it is empty", () => {
  assert.equal(loadConfig(env({ AGENT_PUBLIC_PORT: "9443" })).agentSetup.port, 9443);
  assert.equal(loadConfig(env({ AGENT_PUBLIC_PORT: "" })).agentSetup.port, 8443);
  assert.equal(loadConfig(env({ AGENT_PUBLIC_PORT: "", AGENT_API_PORT: "8444" })).agentSetup.port, 8444);
});

test("an address or port a cabinet could not dial is refused at start", () => {
  assert.throws(() => loadConfig(env({ AGENT_PUBLIC_HOST: "cabinets.example.com:8443" })), /AGENT_PUBLIC_HOST/);
  assert.throws(() => loadConfig(env({ AGENT_PUBLIC_PORT: "0" })), /AGENT_PUBLIC_PORT/);
  assert.throws(() => loadConfig(env({ AGENT_PUBLIC_PORT: "not a port" })), /AGENT_PUBLIC_PORT/);
});

test("the deployment passes both switches into the server, or setting them changes nothing", () => {
  const compose = readFileSync(join(root, "deploy", "compose.yaml"), "utf8");
  const server = compose.slice(compose.indexOf("\n  server:"));
  const environment = server.slice(server.indexOf("environment:"), server.indexOf("ports:"));
  assert.match(environment, /AGENT_PUBLIC_HOST: \$\{AGENT_PUBLIC_HOST/);
  assert.match(environment, /AGENT_PUBLIC_PORT: \$\{AGENT_PUBLIC_PORT/);
});
