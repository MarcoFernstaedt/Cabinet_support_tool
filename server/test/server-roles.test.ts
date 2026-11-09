// Running the parts of the platform apart (F21.R3, decision-log D60). SERVER_ROLES chooses what a process runs: the agent API, the
// console API, the background jobs. The real server is started twice from the same build against one database, one process for the
// cabinets' ingest and one for the console and jobs; each is stopped and started again while the other keeps answering. Plus the role
// parsing, the per-process plan, and the start-up refusals, with hostile values.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { parseRoles, processPlan, SERVER_ROLES } from "../src/roles.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

const DB = "sqlserver://cabinet_app_login:pw@mssql:1433/cabinet?trustServerCertificate=true";

test("SERVER_ROLES: unset is all three; a list is taken as written; an empty or unknown role stops the server", () => {
  assert.deepEqual([...parseRoles(undefined)].sort(), [...SERVER_ROLES].sort());
  assert.deepEqual([...parseRoles("  ")].sort(), [...SERVER_ROLES].sort());
  assert.deepEqual([...parseRoles("agent")], ["agent"]);
  assert.deepEqual([...parseRoles(" Console , JOBS ")].sort(), ["console", "jobs"]);
  for (const bad of [",", " , ", "agent,shell", "all", "agent;console", "console\u0000", "x".repeat(10_000)])
    assert.throws(() => parseRoles(bad), (e: Error) => /SERVER_ROLES/.test(e.message) && e.message.length < 200, JSON.stringify(bad.slice(0, 20)));
});

test("the plan: one process runs what its roles name; agent workers only ever serve agents", () => {
  const all = parseRoles(undefined), agent = parseRoles("agent"), rest = parseRoles("console,jobs");
  assert.deepEqual(processPlan(all, 1, true), { servesAgents: true, forksAgentWorkers: false, runsConsole: true, runsJobs: true }, "as before: one process, everything");
  assert.deepEqual(processPlan(all, 4, true), { servesAgents: false, forksAgentWorkers: true, runsConsole: true, runsJobs: true }, "as before: the primary forks workers");
  assert.deepEqual(processPlan(all, 4, false), { servesAgents: true, forksAgentWorkers: false, runsConsole: false, runsJobs: false }, "a worker serves agents only");
  assert.deepEqual(processPlan(agent, 1, true), { servesAgents: true, forksAgentWorkers: false, runsConsole: false, runsJobs: false });
  assert.deepEqual(processPlan(agent, 3, true), { servesAgents: false, forksAgentWorkers: true, runsConsole: false, runsJobs: false });
  assert.deepEqual(processPlan(rest, 1, true), { servesAgents: false, forksAgentWorkers: false, runsConsole: true, runsJobs: true });
  assert.deepEqual(processPlan(rest, 4, true), { servesAgents: false, forksAgentWorkers: false, runsConsole: true, runsJobs: true }, "no agent role: nothing to fork");
});

test("a process asked by name for the console without its settings refuses to start; unset roles keep the old behaviour", () => {
  assert.throws(() => loadConfig({ DATABASE_URL: DB, SERVER_ROLES: "console" }), /SERVER_ROLES includes console, but CONSOLE_ORIGIN is not set/);
  assert.equal(loadConfig({ DATABASE_URL: DB }).console, undefined, "no console settings and no roles: agent and jobs, as before");
  assert.deepEqual([...loadConfig({ DATABASE_URL: DB, SERVER_ROLES: "agent" }).roles], ["agent"]);
  assert.throws(() => loadConfig({ DATABASE_URL: DB, SERVER_ROLES: "agent,everything" }), /not a role/);
});

// ---- The real server, twice -------------------------------------------------------------------------------------------------------

const main = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.js");
const freePort = (): Promise<number> => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });
/** Whether something accepts a TCP connection on the port now. */
const listening = (port: number): Promise<boolean> => new Promise(r => {
  const c = connect({ host: "127.0.0.1", port }); c.once("connect", () => { c.destroy(); r(true); }); c.once("error", () => r(false));
});
async function waitFor(what: string, check: () => Promise<boolean>, out: () => string, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await check()) return; await new Promise(r => setTimeout(r, 250)); }
  assert.fail(`${what} within ${ms / 1000} s. Output:\n${out().slice(-3000)}`);
}

let db: TestDatabase, workersDb: TestDatabase;
const running: ChildProcess[] = [];
test.after(async () => { for (const p of running) p.kill("SIGKILL"); await db?.drop(); await workersDb?.drop(); });

test("the cabinets' ingest and the console run as two processes from one build, and each restarts while the other keeps answering", { timeout: 240_000 }, async () => {
  db = await createTestDatabase();
  const [agentPort, consolePort] = [await freePort(), await freePort()];
  const shared = { PATH: process.env.PATH, DATABASE_URL: db.appUrl, DEV_PKI_DIR: tempDir(), AGENT_API_HOST: "127.0.0.1", AGENT_API_PORT: String(agentPort),
    CONSOLE_HOST: "127.0.0.1", CONSOLE_PORT: String(consolePort), CONSOLE_ORIGIN: `http://127.0.0.1:${consolePort}`, CONSOLE_SECRET_KEY: randomBytes(32).toString("base64"),
    PACKAGE_DIR: tempDir(), RELEASE_DIR: tempDir() };
  const start = (roles: string) => {
    let out = "";
    const p = spawn(process.execPath, [main], { env: { ...shared, SERVER_ROLES: roles }, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout!.on("data", d => { out += String(d); }); p.stderr!.on("data", d => { out += String(d); });
    running.push(p);
    return { p, out: () => out };
  };
  const stop = (p: ChildProcess) => new Promise<void>(r => { p.once("exit", () => r()); p.kill("SIGTERM"); });
  const consoleAnswers = async () => {
    try { return (await fetch(`http://127.0.0.1:${consolePort}/api/fleet/clients`)).status === 401; } catch { return false; }
  };

  // The development keys are made by the first process to start; start the ingest first so the two never race to make them.
  let agent = start("agent");
  await waitFor("the ingest process listens on the agent port", () => listening(agentPort), agent.out);
  let rest = start("console,jobs");
  await waitFor("the console process answers", consoleAnswers, rest.out);
  assert.equal(await listening(agentPort), true);
  // Each serves only its own part.
  await stop(rest.p);
  assert.equal(await listening(consolePort), false, "the console port closed with the console process");
  assert.equal(await listening(agentPort), true, "the ingest kept serving while the console was down");
  rest = start("console,jobs");
  await waitFor("the console process answers again", consoleAnswers, rest.out);
  await stop(agent.p);
  assert.equal(await listening(agentPort), false, "the agent port closed with the ingest process");
  assert.equal(await consoleAnswers(), true, "the console kept answering while the ingest was down");
  agent = start("agent");
  await waitFor("the ingest process listens again", () => listening(agentPort), agent.out);
  assert.equal(await consoleAnswers(), true);
  await stop(agent.p); await stop(rest.p);
});

test("the ingest alone, in several workers: the primary only forks them and opens nothing itself, and the workers answer", { timeout: 120_000 }, async () => {
  workersDb = await createTestDatabase();
  const agentPort = await freePort();
  let out = "";
  const p = spawn(process.execPath, [main], { env: { PATH: process.env.PATH, DATABASE_URL: workersDb.appUrl, DEV_PKI_DIR: tempDir(), AGENT_API_HOST: "127.0.0.1",
    AGENT_API_PORT: String(agentPort), PACKAGE_DIR: tempDir(), RELEASE_DIR: tempDir(), SERVER_ROLES: "agent", AGENT_API_WORKERS: "2" }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout!.on("data", d => { out += String(d); }); p.stderr!.on("data", d => { out += String(d); });
  running.push(p);
  let exited: number | null | undefined;
  p.once("exit", code => { exited = code; });
  await waitFor("the agent workers listen on the agent port", () => listening(agentPort), () => out);
  // Still up a moment later: a primary that crashed after forking would take its workers down with it.
  await new Promise(r => setTimeout(r, 3_000));
  assert.equal(exited, undefined, `the primary is still running. Output:\n${out.slice(-3000)}`);
  assert.equal(await listening(agentPort), true);
  assert.ok(!/TypeError|Cannot read properties/.test(out), out.slice(-3000));
  await new Promise<void>(r => { if (exited !== undefined) r(); else { p.once("exit", () => r()); p.kill("SIGTERM"); } });
  await waitFor("the agent port closes with the server", async () => !(await listening(agentPort)), () => out, 30_000);
});
