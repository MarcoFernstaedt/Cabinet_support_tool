// The demo journey in a real browser (docs/platform/demo.md): an Admin opens Setup, adds a support member,
// creates an installer there, a real agent (the agent's own connection code) enrols with it, the Admin approves it on
// the same page, opens its event logs, then turns demo mode on: the simulated clients appear next to the real one, marked
// Demo, and a simulated cabinet answers. Runs when TEST_AGENT_DLL is set and the console is built.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { DemoSimulator } from "../src/demo/demo.js";
import { createTestDatabase, type TestDatabase, startFeed } from "./database.js";
import { tempDir } from "./helpers.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const dll = process.env.TEST_AGENT_DLL;
const skip = !dll ? "set TEST_AGENT_DLL to run" : !existsSync(join(dist, "index.html")) ? "build the console first (console/dist)" : false;
const freePort = (): Promise<number> => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

test("set up and demo: add a support member, enrol a real agent from the setup page, see its event logs, turn demo mode on", { skip, timeout: 240_000 }, async () => {
  const { chromium } = await import("playwright");
  const db: TestDatabase = await createTestDatabase();
  const dir = tempDir();
  const key = await developmentIssuingKey(dir);
  const notifier = new CommandNotifier(await startFeed(db));
  await notifier.start();
  const agentApi: FastifyInstance = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, tls: await developmentServerCertificate(key, dir, ["localhost"]), longPollMs: 3000, logger: false });
  await agentApi.listen({ host: "127.0.0.1", port: 0 });
  const agentPort = (agentApi.server.address() as { port: number }).port;
  let clock = Date.now();
  const consolePort = await freePort();
  const origin = `http://127.0.0.1:${consolePort}`;
  const secrets = new SecretBox(randomBytes(32).toString("base64"));
  const stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  const downloads = tempDir();
  writeFileSync(join(downloads, "CabinetAgent-win-x64.zip"), Buffer.from("PK\u0003\u0004 test package"));
  const consoleApi = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin, stream, staticDir: dist, logger: false, now: () => clock,
    agentSetup: { host: "localhost", port: agentPort, downloadDir: downloads } });
  await consoleApi.listen({ host: "127.0.0.1", port: consolePort });
  const sim = new DemoSimulator(db.app, m => problems.push(m), 200, [100, 300]);
  sim.start();

  const password = "correct horse battery staple";
  const secret = totp.newSecret();
  const adminId = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, 'marco', 'Marco F', 'admin', $2, 0, 1, $3, 1)`, [adminId, await hashPassword(password), secrets.seal(secret)]);
  const code = (): string => { clock += 30_000; return totp.code(secret, totp.stepAt(clock)); };

  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  let agent: ChildProcess | null = null;
  const agentLog: string[] = [];
  const until = async (what: string, check: () => Promise<boolean>, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 250))) if (await check()) return;
    assert.fail(`timed out waiting for ${what}. Agent log:\n${agentLog.join("")}`);
  };
  try {
    const p = await (await browser.newContext({ acceptDownloads: true })).newPage();
    p.on("pageerror", e => problems.push(`page error: ${e.message}`));
    // The console asks who is signed in before sign-in (401); anything else in the browser console is a problem.
    p.on("console", m => { if (m.type() === "error" && !/status of 401/.test(m.text())) problems.push(m.text()); });
    // The dialog closes once the confirmed request has succeeded, shows the console's own reason when it is refused, and says
    // "Confirming…" while the request is still out. The wait is for the outcome, and a failure says which of the three it was.
    const confirmCode = async () => {
      const dialog = p.getByRole("dialog", { name: "Confirm with your authenticator" });
      await dialog.getByLabel("Authenticator code").fill(code());
      await dialog.getByRole("button", { name: "Confirm" }).click();
      const refusal = dialog.getByRole("alert");
      const outcome = await Promise.race([
        dialog.waitFor({ state: "hidden", timeout: 30_000 }).then(() => "closed" as const, () => "timeout" as const),
        refusal.waitFor({ state: "visible", timeout: 30_000 }).then(() => "refused" as const, () => "timeout" as const),
      ]);
      if (outcome === "refused") assert.fail(`the confirmation was refused: ${await refusal.textContent()}`);
      if (outcome === "timeout" && await dialog.isVisible())
        assert.fail(await dialog.getByRole("button", { name: "Confirming…" }).isVisible()
          ? "the confirmed request was still running after 30 s (the dialog says Confirming…)"
          : "the dialog stayed open for 30 s with no request running and no reason shown");
    };
    await p.goto(origin);
    await p.getByLabel("Username").fill("marco");
    await p.getByLabel("Password").fill(password);
    await p.getByRole("button", { name: "Sign in" }).click();
    await p.getByLabel(/6-digit code/).fill(code());
    await p.getByRole("button", { name: "Continue" }).click();
    await p.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();
    // An empty platform points the Admin to the setup page.
    await p.getByRole("link", { name: "Admin → Setup" }).click();
    await p.getByRole("heading", { name: "Setup", level: 1 }).waitFor();

    // 1. A support member, with a temporary password shown once.
    await p.getByLabel("Username").fill("sam.support");
    await p.getByLabel("Full name").fill("Sam Support");
    await p.getByRole("button", { name: "Create account" }).click();
    await confirmCode();
    await p.getByText(/Temporary password for sam\.support/).waitFor();
    assert.equal((await db.app.query("SELECT must_change_password FROM users WHERE username = 'sam.support'")).rows[0].must_change_password, true,
      "the new member must choose their own password at first sign-in");
    await p.getByRole("button", { name: "I have passed it on" }).click();

    // 2. The agent package, then an installer for this cabinet, both downloaded from the page.
    const pkg = p.waitForEvent("download");
    await p.getByRole("link", { name: /64-bit Windows/ }).click();
    assert.equal((await pkg).suggestedFilename(), "CabinetAgent-win-x64.zip");
    assert.equal(await p.getByText("32-bit Windows: not published on this server.").count(), 1, "a missing package is named, never swapped");
    await p.getByRole("button", { name: "Create installer" }).click();
    await confirmCode();
    const installerDownload = p.waitForEvent("download");
    await p.getByRole("link", { name: "Download Install-CabinetAgent.cmd" }).click();
    const installer = readFileSync(await (await installerDownload).path()!, "utf8");
    // The installer carries what the cabinet needs: this server's address, the CA and a token, nothing to type.
    assert.match(installer, new RegExp(`\\$serverHost = 'localhost'\r\n\\$serverPort = ${agentPort}\r\n`));
    const token = /\$token = '([A-Za-z0-9_-]+)'/.exec(installer)![1]!;
    const caPem = /\$caPem = @'\r\n([\s\S]+?)\r\n'@/.exec(installer)![1]!.replace(/\r\n/g, "\n") + "\n";
    assert.equal(caPem, key.certificatePem.replace(/\r\n/g, "\n").trim() + "\n", "the CA in the installer is this server's");
    const caFile = join(dir, "from-console-ca.pem");
    writeFileSync(caFile, caPem);

    // The computer: the real agent connection code, with the token and CA the page gave.
    const state = join(dir, "agent-state");
    mkdirSync(state);
    writeFileSync(join(state, "bootstrap-token"), token);
    agent = spawn("dotnet", [dll!, `https://localhost:${agentPort}`, caFile, state, join(repo, "contracts")], { stdio: ["ignore", "pipe", "pipe"] });
    agent.stdout!.on("data", d => agentLog.push(String(d)));
    agent.stderr!.on("data", d => agentLog.push(String(d)));

    // 3. It appears on the same page (which refreshes by itself); the Admin files it and approves it.
    const request = p.getByRole("region", { name: /Request from / });
    await request.waitFor({ timeout: 60_000 });
    await request.getByLabel("Client").fill("Mashura Office");
    await request.getByLabel("Site").fill("Support desk");
    await request.getByLabel("Cabinet name").fill("Marco's HP");
    await request.getByLabel("Role").selectOption("standalone");
    // No approved baseline applies to a new client: the approval asks for the decision.
    await request.getByLabel("Capture this cabinet's configuration as the site baseline draft").check();
    await request.getByRole("button", { name: "Approve" }).click();
    await confirmCode();
    await until("the first heartbeat", async () => (await db.app.query("SELECT 1 FROM cabinets WHERE name = $1 AND last_heartbeat_at IS NOT NULL", ["Marco's HP"])).rows.length > 0);

    // 4. Its event logs, one click from the setup page.
    await p.getByRole("link", { name: "Event logs" }).click({ timeout: 30_000 });
    await p.getByRole("heading", { name: "Marco's HP", level: 1 }).waitFor();
    await p.getByRole("heading", { name: "Event logs" }).waitFor();
    await p.getByRole("button", { name: /System/ }).first().waitFor({ timeout: 30_000 });

    // Diagnose network on the real agent: findings worst first, then the checks that passed.
    await p.getByRole("link", { name: "Network", exact: true }).click();
    await p.getByRole("button", { name: "Diagnose network" }).click();
    await p.getByText(/checks passed/).waitFor({ timeout: 60_000 });
    assert.ok(await p.getByRole("region", { name: "Diagnose network" }).getByText(/Checks that passed/).count() > 0);

    // Demo mode: on, the banner and the simulated clients next to the real one.
    await p.goto(`${origin}/admin/setup`);
    await p.getByRole("button", { name: "Turn demo mode on" }).click();
    await confirmCode();
    await p.getByText(/Demo mode is on\. 121 simulated cabinets/).waitFor({ timeout: 30_000 });
    await p.goto(origin);
    const fleet = p.getByRole("table", { name: "Clients" });
    await fleet.getByRole("row", { name: /Mashura Office/ }).waitFor();
    for (const name of ["Demo · Riverside Veterinary Group", "Demo · Lakeside Health", "Demo · Summit Animal Hospitals"])
      await fleet.getByRole("row", { name: new RegExp(name) }).getByText("Demo", { exact: true }).waitFor();
    assert.equal(await fleet.getByRole("row", { name: /Mashura Office/ }).getByText("Demo", { exact: true }).count(), 0, "the real client is not marked demo");

    // The overnight crash incident on the Incidents page: the driver stands out, the update does not.
    await p.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Incidents" }).click();
    const common = p.getByRole("table", { name: /Changes and errors before the crashes/ });
    await common.getByRole("row", { name: /Driver installed: Driver iastorac\.inf/ }).getByText("Stands out").waitFor({ timeout: 30_000 });
    assert.equal(await common.getByRole("row", { name: /Update installed: .*KB5050011/ }).getByText("Stands out").count(), 0);
    await p.getByRole("heading", { name: /Cabinets affected \(6\d\)/ }).waitFor();
    await p.getByRole("table", { name: "Cabinets affected" }).getByText("Restarting repeatedly").first().waitFor();

    // Scenario C: every cabinet in the wrong time zone, corrected in one fleet operation with the password, each verified.
    await p.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Fleet operations" }).click();
    // A bulk change covers one site: choose New York, see all eight with their addresses, tick three of them.
    await p.getByText("Choose a site to see its cabinets.").waitFor();
    await p.locator("select").filter({ hasText: "Choose a site" }).selectOption({ label: "New York – Upper East Side (8)" });
    await p.getByRole("row", { name: /Exam 1 .*10\.21\.4\.\d+/ }).waitFor();
    await p.getByText(/0\s*of 8 selected/).waitFor();
    for (const name of ["Exam 1", "Exam 2", "Exam 3"]) await p.getByLabel(`Select ${name}`).check();
    await p.getByText(/3\s*of 8 selected/).waitFor();
    await p.getByRole("button", { name: "Preview on 3 cabinets" }).click();
    await p.getByText(/3\s*will be changed/).waitFor();
    await p.getByRole("button", { name: "Set each cabinet to its site's time zone on 3 cabinets" }).click();
    const pw = p.getByRole("dialog", { name: "Confirm with your password" });
    await pw.getByLabel("Your password").fill(password);
    await pw.getByRole("button", { name: "Confirm" }).click();
    await p.getByRole("heading", { name: "Set each cabinet to its site's time zone" }).waitFor();
    await p.getByText("3 verified").waitFor({ timeout: 60_000 });

    // A simulated cabinet answers like a real one, and says it is simulated.
    await p.goto(origin);
    await p.getByRole("link", { name: "Demo · Riverside Veterinary Group" }).click();
    await p.getByRole("link", { name: "New York – Upper East Side" }).click();
    await p.getByRole("link", { name: "Treatment Room" }).click();
    await p.getByText("Demo: simulated cabinet").waitFor();
    await p.getByRole("link", { name: "Fingerprint scanner" }).click();
    await p.getByText(/The fingerprint scanner is not connected/).waitFor({ timeout: 30_000 });

    // Off again: the simulated fleet is gone, the real cabinet stays.
    await p.goto(`${origin}/admin/setup`);
    await p.getByRole("button", { name: "Turn demo mode off" }).click();
    await confirmCode();
    await p.getByText("No simulated cabinets.").waitFor();
    assert.equal((await db.app.query("SELECT COUNT(*) AS n FROM cabinets WHERE demo_scenario IS NOT NULL")).rows[0].n, 0);
    assert.equal((await db.app.query("SELECT COUNT(*) AS n FROM cabinets WHERE name = $1 AND status = 'active'", ["Marco's HP"])).rows[0].n, 1);
    assert.deepEqual(problems, []);
  } finally {
    agent?.kill("SIGINT");
    sim.stop();
    await browser.close();
    await stream.stop();
    await consoleApi.close();
    await agentApi.close();
    await notifier.stop();
    await db.drop();
  }
});
