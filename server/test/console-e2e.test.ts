// Milestone 3 end to end, in a real browser: the console, this server, PostgreSQL and the real
// agent connection code (agent/tests/Cabinet.Agent.TestAgent, answering with contract examples).
// Runs when TEST_AGENT_DLL is set and the console is built (console/dist); CI does both.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { CommandNotifier } from "../src/agent-api/notifier.js";
import { buildAgentApi } from "../src/agent-api/server.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey, developmentServerCertificate } from "../src/pki/issuing.js";
import { verifyAuditChain } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir, setUpAuthenticatorInBrowser } from "./helpers.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const dll = process.env.TEST_AGENT_DLL;
const skip = !dll ? "set TEST_AGENT_DLL to run" : !existsSync(join(dist, "index.html")) ? "build the console first (console/dist)" : false;

const freePort = (): Promise<number> => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

test("the console end to end: install, approve, find a cabinet, browse logs, run diagnostics, and it is all audited", { skip, timeout: 240_000 }, async () => {
  const { chromium } = await import("playwright");
  const db: TestDatabase = await createTestDatabase();
  const dir = tempDir();
  const key = await developmentIssuingKey(dir);
  const notifier = new CommandNotifier(db.appUrl);
  await notifier.start();
  const agentApi: FastifyInstance = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, tls: await developmentServerCertificate(key, dir, ["localhost"]), longPollMs: 3000, logger: false });
  await agentApi.listen({ host: "127.0.0.1", port: 0 });
  const agentPort = (agentApi.server.address() as { port: number }).port;

  // Authenticator codes are checked against this clock, which the test moves 30 s per code so none is ever reused.
  let clock = Date.now();
  const consolePort = await freePort();
  const origin = `http://127.0.0.1:${consolePort}`;
  const secrets = new SecretBox(randomBytes(32).toString("base64"));
  const stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  const consoleApi = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin, stream, staticDir: dist, logger: false, now: () => clock });
  await consoleApi.listen({ host: "127.0.0.1", port: consolePort });

  const adminSecret = totp.newSecret();
  const password = "correct horse battery staple";
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc) VALUES
    ($1, 'ada.admin', 'Ada Admin', 'admin', $3, false, true, $4), ($2, 'sam.support', 'Sam Support', 'tier1', $3, false, false, NULL)`,
    [randomUUID(), randomUUID(), await hashPassword(password), secrets.seal(adminSecret)]);
  const code = (): string => { clock += 30_000; return totp.code(adminSecret, totp.stepAt(clock)); };

  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  let agent: ChildProcess | null = null;
  const agentLog: string[] = [];
  const problems: string[] = [];
  const page = await browser.newPage();
  try {
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    // The signed-out check (GET /api/auth/me answering 401) is expected; any other browser error is not.
    page.on("console", m => { if (m.type() === "error" && !m.text().includes("status of 401")) problems.push(`console error: ${m.text()}`); });

    /** Every page the test visits has one h1, and every button has an accessible name. */
    const a11y = async (where: string) => {
      assert.equal(await page.locator("h1").count(), 1, `${where}: one main heading`);
      const unnamed = await page.$$eval("button", bs => bs.filter(b => !(b.textContent ?? "").trim() && !b.getAttribute("aria-label")).length);
      assert.equal(unnamed, 0, `${where}: every button has a name`);
    };
    const shot = async (name: string) => { if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}.png`), fullPage: true }); };
    const nav = (name: string) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name, exact: true });
    const confirmCode = async () => {
      const dialog = page.getByRole("dialog", { name: "Confirm with your authenticator" });
      await dialog.getByLabel("Authenticator code").fill(code());
      await dialog.getByRole("button", { name: "Confirm" }).click();
      await dialog.waitFor({ state: "hidden" });
    };

    // ---- Admin signs in with password and authenticator code ------------------------
    await page.goto(origin);
    await page.getByRole("heading", { name: "Sign in" }).waitFor();
    await a11y("sign-in");
    await page.getByLabel("Username").fill("ada.admin");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByLabel(/6-digit code/).fill(code());
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("dialog", { name: "Mashura Support Console" }).getByRole("button", { name: "Skip tour" }).click();
    await page.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();

    // ---- Creates an install token in the console; the cabinet installs with it ---------
    await nav("Admin").click();
    await page.getByRole("link", { name: /Install a cabinet/ }).click();
    await page.getByRole("button", { name: "Create install token" }).click();
    await confirmCode();
    const token = (await page.locator("code.secret").textContent())!.trim();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const state = join(dir, "agent-state");
    mkdirSync(state);
    writeFileSync(join(state, "bootstrap-token"), token);
    writeFileSync(join(dir, "platform-ca.pem"), key.certificatePem);
    agent = spawn("dotnet", [dll!, `https://localhost:${agentPort}`, join(dir, "platform-ca.pem"), state, join(repo, "contracts")], { stdio: ["ignore", "pipe", "pipe"] });
    agent.stdout!.on("data", d => agentLog.push(String(d)));
    agent.stderr!.on("data", d => agentLog.push(String(d)));

    // ---- Approves it from Pending cabinets ---------------------------------------
    for (let i = 0; i < 60 && !(await page.getByRole("heading", { name: "TEST-AGENT" }).isVisible()); i++) {
      await page.goto(`${origin}/admin/pending`);
      await page.getByRole("heading", { name: "Pending cabinets", level: 1 }).waitFor();
      await page.waitForTimeout(500);
    }
    await a11y("pending cabinets");
    await shot("1-pending-cabinet");
    const card = page.getByRole("region", { name: "Request from TEST-AGENT" });
    await card.getByLabel("Client").fill("E2E Health");
    await card.getByLabel("Site").fill("North Wing");
    await card.getByLabel("Cabinet name").fill("Lab cabinet");
    await card.getByLabel("Role").selectOption("sync");
    await card.getByRole("button", { name: "Approve" }).click();
    await confirmCode();
    await card.getByText(/Approved\./).waitFor();

    // ---- Sets the fleet scanner IDs and the site's sync cabinet ----------------------
    await page.goto(`${origin}/admin/scanner`);
    const fleetScanner = page.getByRole("region", { name: "Fingerprint scanner" });
    await fleetScanner.getByLabel(/Fleet default scanner IDs/).fill("USB\\VID_1234&PID_5678");
    await fleetScanner.getByRole("button", { name: "Save" }).click();
    await confirmCode();
    await fleetScanner.getByText(/Saved\. Cabinets use it from their next heartbeat/).waitFor();

    await page.goto(origin);
    await page.getByRole("link", { name: "E2E Health" }).click();
    await page.getByRole("link", { name: "North Wing" }).click();
    await page.getByRole("heading", { name: "North Wing", level: 1 }).waitFor();
    await a11y("site");
    const sync = page.getByRole("region", { name: "Sync cabinet" });
    await sync.getByLabel("IPv4 address").fill("10.20.0.15");
    await sync.getByLabel(/TCP ports/).fill("1433");
    await sync.getByRole("button", { name: "Save" }).click();
    await confirmCode();
    await sync.getByRole("status").filter({ hasText: "Saved." }).waitFor();
    await page.getByRole("button", { name: "Sign out" }).click();

    // ---- A Tier 1 user finds the cabinet and works on it ------------------------------
    await page.getByLabel("Username").fill("sam.support");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    // Every account, Tier 1 included, sets up an authenticator at its first sign-in.
    await page.getByRole("heading", { name: "Set up your authenticator" }).waitFor();
    await setUpAuthenticatorInBrowser(page, s => { clock += 30_000; return totp.code(s, totp.stepAt(clock)); });
    // First sign-in shows the getting-started tour; walk through every step.
    const tour = page.locator("dialog.tour");
    await tour.waitFor();
    for (let i = 0; i < 10 && await tour.isVisible(); i++) {
      const finish = tour.getByRole("button", { name: "Finish" });
      if (await finish.isVisible()) await finish.click(); else await tour.getByRole("button", { name: "Next" }).click();
    }
    await tour.waitFor({ state: "hidden" });
    await page.getByRole("combobox", { name: /Jump to/ }).fill("Lab");
    await page.getByRole("option", { name: /Lab cabinet/ }).waitFor();
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Lab cabinet", level: 1 }).waitFor();
    await a11y("cabinet");
    for (let i = 0; i < 40 && !(await page.getByText("Online").first().isVisible()); i++) { await page.waitForTimeout(500); await page.reload(); }

    await page.getByRole("link", { name: "Event logs" }).click();
    await page.getByRole("button", { name: /^System/ }).first().click();
    const entries = page.getByRole("list", { name: /Entries in System/ });
    await entries.waitFor({ timeout: 30_000 });
    await shot("2-event-log");
    await entries.getByRole("button").first().click();
    await page.getByRole("heading", { name: /^Event \d+ in System/ }).waitFor();
    await page.getByText("Raw event XML").waitFor({ timeout: 30_000 });
    await shot("3-event-entry");

    await page.getByRole("link", { name: "Fingerprint scanner" }).click();
    await page.getByRole("list", { name: "Scanner checks" }).waitFor({ timeout: 30_000 });
    await page.getByText("Scanner plugged in").waitFor();
    await page.getByText(/from the fleet default/).waitFor();
    await shot("4-fingerprint-scanner");

    await page.getByRole("link", { name: "Drive health" }).click();
    await page.getByRole("article").first().waitFor({ timeout: 30_000 });
    await shot("5-drive-health");

    await page.getByRole("link", { name: "Network" }).click();
    await page.getByRole("button", { name: "Trace and ping" }).click();
    await page.getByRole("table", { name: /^gateway/ }).waitFor({ timeout: 60_000 });

    await page.getByRole("link", { name: "Files" }).click();
    await page.getByRole("table", { name: /Contents of/ }).waitFor({ timeout: 30_000 });

    await page.getByRole("link", { name: "Command history" }).click();
    await page.getByRole("table", { name: "Last 50 commands" }).waitFor();
    assert.ok((await page.getByRole("row").count()) > 6, "every diagnostic run is in the history");

    // ---- And every view is in the audit log -----------------------------------------
    const actions = (await db.app.query<{ action: string }>(
      "SELECT a.action FROM audit_log a JOIN users u ON u.id::text = a.actor_id WHERE u.username = 'sam.support'")).rows.map(r => r.action);
    for (const required of ["auth.login", "cabinet.view", "eventlog.browse", "eventlog.entry.open", "command.issue"])
      assert.ok(actions.includes(required), `audit has ${required}`);
    const params = (await db.app.query<{ params: unknown }>("SELECT params FROM commands WHERE operation = 'peripheral.status' ORDER BY issued_at DESC LIMIT 1")).rows[0]!.params;
    assert.deepEqual(params, { hardwareIds: ["USB\\VID_1234&PID_5678"] }, "the console's scanner setting reached the cabinet");
    assert.equal((await verifyAuditChain(db.app)).ok, true);
    assert.deepEqual(problems, [], "no errors in the browser");
  } catch (e) {
    console.error("Agent log:\n" + agentLog.join(""));
    if (process.env.E2E_SCREENSHOT) await page.screenshot({ path: process.env.E2E_SCREENSHOT, fullPage: true }).catch(() => undefined);
    console.error("Browser problems:\n" + problems.join("\n"));
    throw e;
  } finally {
    agent?.kill("SIGINT");
    await browser.close();
    await consoleApi.close();
    await stream.stop();
    await agentApi.close();
    await notifier.stop();
    await db.drop();
  }
});
