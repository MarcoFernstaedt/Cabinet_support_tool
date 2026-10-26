// Milestone 5 in a real browser: an Admin uploads a driver package (the server checks it, and refuses a
// tampered one), a second Admin approves it, Tier 2 installs it from the cabinet's Software section and
// makes firewall and DNS changes, each behind a confirmation and an authenticator code, through the real
// agent connection code; the firewall history shows who did it; Tier 1 sees no write controls; and a
// fleet-wide pause shows its banner and hides them.
// Runs when TEST_AGENT_DLL is set and the console is built (console/dist); CI does both.
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
import { NotificationFeed } from "../src/db/notifications.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { paramsHash } from "../src/auth/canonical.js";
import { developmentIssuingKey, developmentServerCertificate } from "../src/pki/issuing.js";
import { approveEnrollment, createBootstrapToken, pendingRequests } from "../src/services/enrollment.js";
import { APPS_SET_ACTION, normalizeEntries, setApprovedApps } from "../src/services/approved-apps.js";
import { setFleetPause } from "../src/services/writes.js";
import { TrustList } from "../src/packages/trust.js";
import { verifyAuditChain, NULL_BINARY } from "../src/db/db.js";
import { pe, TestPki, zip } from "./package-pki.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const dll = process.env.TEST_AGENT_DLL;
const skip = !dll ? "set TEST_AGENT_DLL to run" : !existsSync(join(dist, "index.html")) ? "build the console first (console/dist)" : false;
const freePort = (): Promise<number> => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

test("writes in the console: library upload and two-person approval, install, firewall and DNS changes, history, roles and the pause banner", { skip, timeout: 300_000 }, async () => {
  const { chromium } = await import("playwright");
  const db: TestDatabase = await createTestDatabase();
  const dir = tempDir();
  const key = await developmentIssuingKey(dir);
  writeFileSync(join(dir, "platform-ca.pem"), key.certificatePem);
  const pki = new TestPki();
  const vendor = pki.signer("Scanner Vendor Inc", "Scanner Vendor");
  const trustDir = pki.trustFolder([{ cn: "Scanner Vendor Inc", o: "Scanner Vendor", types: ["driver"] }]);
  const store = { dir: tempDir(), maxBytes: 1024 * 1024, trust: TrustList.fromFolder(trustDir) };
  const feed = new NotificationFeed(db.app, 50);
  await feed.start();
  const notifier = new CommandNotifier(feed);
  await notifier.start();
  const agentApi: FastifyInstance = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, packages: store, tls: await developmentServerCertificate(key, dir, ["localhost"]), longPollMs: 3000, logger: false });
  await agentApi.listen({ host: "127.0.0.1", port: 0 });
  const agentPort = (agentApi.server.address() as { port: number }).port;

  let clock = Date.now();
  const consolePort = await freePort();
  const origin = `http://127.0.0.1:${consolePort}`;
  const secrets = new SecretBox(randomBytes(32).toString("base64"));
  const stream = new ResultStream(feed, db.app);
  await stream.start();
  const consoleApi = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin, stream, staticDir: dist, packages: store, logger: false, now: () => clock });
  await consoleApi.listen({ host: "127.0.0.1", port: consolePort });

  const password = "correct horse battery staple";
  const people = {
    ada: { username: "ada.admin", name: "Ada Admin", role: "admin", secret: totp.newSecret(), id: randomUUID() },
    abe: { username: "abe.admin", name: "Abe Admin", role: "admin", secret: totp.newSecret(), id: randomUUID() },
    tess: { username: "tess.tier2", name: "Tess Tier2", role: "tier2", secret: totp.newSecret(), id: randomUUID() },
    sam: { username: "sam.support", name: "Sam Support", role: "tier1", secret: totp.newSecret(), id: randomUUID() },
  } as const;
  for (const p of Object.values(people))
    await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                        VALUES ($1, $2, $3, $4, $5, 0, $6, $7, 1)`, [p.id, p.username, p.name, p.role, await hashPassword(password), !!p.secret, p.secret ? secrets.seal(p.secret) : NULL_BINARY]);
  const code = (secret: Buffer): string => { clock += 30_000; return totp.code(secret, totp.stepAt(clock)); };

  // The package files: one signed by the trusted vendor, and a tampered copy of it.
  const INF = Buffer.from("[Version]\r\nSignature=\"$WINDOWS NT$\"\r\nClass=Biometric\r\nCatalogFile=scanner.cat\r\n");
  const SYS = pe("scanner driver");
  const cat = pki.catalog(vendor, [INF, SYS]);
  const goodFile = join(dir, "scanner-driver.zip");
  writeFileSync(goodFile, zip([["scanner.inf", INF], ["x64/scanner.sys", SYS], ["scanner.cat", cat]]));
  const tamperedFile = join(dir, "tampered-driver.zip");
  writeFileSync(tamperedFile, zip([["scanner.inf", INF], ["x64/scanner.sys", pe("not what was signed")], ["scanner.cat", cat]]));

  // The cabinet: the real agent connection code, answering reads from the contract examples and making writes through the real broker code.
  const state = join(dir, "agent-state");
  mkdirSync(state);
  writeFileSync(join(state, "bootstrap-token"), (await createBootstrapToken(db.app, people.ada.id)).token);
  const agentLog: string[] = [];
  const agent: ChildProcess = spawn("dotnet", [dll!, `https://localhost:${agentPort}`, join(dir, "platform-ca.pem"), state, join(repo, "contracts")],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TEST_TRUST_DIR: trustDir, TEST_SAFETY_NET_SECONDS: "30" } });
  agent.stdout!.on("data", d => agentLog.push(String(d)));
  agent.stderr!.on("data", d => agentLog.push(String(d)));
  const until = async (what: string, check: () => Promise<boolean>, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 250))) if (await check()) return;
    assert.fail(`timed out waiting for ${what}. Agent log:\n${agentLog.join("")}`);
  };

  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  try {
    await until("the enrollment request", async () => (await pendingRequests(db.app)).length > 0);
    const [pending] = await pendingRequests(db.app);
    const { cabinetId } = await approveEnrollment(db.app, key, pending!.id, { clientName: "Acme Health", siteName: "North", cabinetName: "ICU cabinet", role: "standalone" }, people.ada.id);
    await until("the first heartbeat", async () => (await db.app.query("SELECT read_only FROM cabinets WHERE id = $1 AND last_heartbeat_at IS NOT NULL", [cabinetId])).rows[0]?.read_only === false);

    const signIn = async (who: keyof typeof people) => {
      const p = await (await browser.newContext()).newPage();
      p.on("pageerror", e => problems.push(`${who} page error: ${e.message}`));
      // Refusals the test provokes on purpose answer 4xx; anything else in the browser console is a problem.
      p.on("console", m => { if (m.type() === "error" && !/status of (401|409|422)/.test(m.text())) problems.push(`${who}: ${m.text()}`); });
      await p.goto(origin);
      await p.getByLabel("Username").fill(people[who].username);
      await p.getByLabel("Password").fill(password);
      await p.getByRole("button", { name: "Sign in" }).click();
      const secret = people[who].secret;
      if (secret) { await p.getByLabel(/6-digit code/).fill(code(secret)); await p.getByRole("button", { name: "Continue" }).click(); }
      await p.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();
      return p;
    };
    type Page = Awaited<ReturnType<typeof signIn>>;
    const confirm = async (p: Page, secret: Buffer, expect?: RegExp) => {
      const dialog = p.getByRole("dialog", { name: "Confirm with your authenticator" });
      if (expect) await dialog.getByText(expect).first().waitFor();
      await dialog.getByLabel("Authenticator code").fill(code(secret));
      await dialog.getByRole("button", { name: "Confirm" }).click();
      await dialog.waitFor({ state: "hidden" });
    };
    /** A click-level change: the confirmation dialog names it, and one click sends it (no code). */
    const click = async (p: Page, expect?: RegExp) => {
      const dialog = p.getByRole("dialog", { name: "Confirm the change" });
      if (expect) await dialog.getByText(expect).first().waitFor();
      await dialog.getByRole("button", { name: "Make the change" }).click();
      await dialog.waitFor({ state: "hidden" });
    };
    const shot = async (p: Page, name: string) => { if (process.env.E2E_SCREENSHOTS) await p.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}.png`), fullPage: true }); };
    const a11y = async (p: Page, where: string) => {
      assert.equal(await p.locator("h1").count(), 1, `${where}: one main heading`);
      const unnamed = await p.$$eval("button", bs => bs.filter(b => !(b.textContent ?? "").trim() && !b.getAttribute("aria-label")).length);
      assert.equal(unnamed, 0, `${where}: every button has a name`);
    };
    const section = (p: Page, name: string) => p.goto(`${origin}/cabinets/${cabinetId}/${name}`);
    /**
     * A write whose outcome never arrives: say which side is silent. The panel shows whether the console is still waiting,
     * the command rows show what the server recorded, and the agent's own log shows what it was doing.
     */
    const why = async (p: Page, what: string) => {
      const panel = (await p.locator(".write-outcome").count()) > 0 ? (await p.locator(".write-outcome").first().innerText()).trim() : "(nothing was sent: no write panel)";
      const rows = (await db.app.query<{ id: string; operation: string; status: string; result_status: string | null; error_code: string | null; result_at: string | null }>(
        `SELECT TOP (6) id, operation, status, JSON_VALUE(result, '$.status') AS result_status, JSON_VALUE(result, '$.error.code') AS error_code, result_at
         FROM commands WHERE cabinet_id = $1 ORDER BY issued_at DESC`, [cabinetId])).rows;
      const alive = agent.exitCode === null ? "alive" : `exited with code ${agent.exitCode}`;
      // Anything the server handed to the agent and never got an answer for: does the agent's own log mention it at all?
      const stuck = rows.filter(r => r.status !== "succeeded" && r.status !== "failed").map(r => r.id);
      const log = agentLog.join("");
      const mentions = stuck.flatMap(id => log.split("\n").filter(l => l.includes(id)));
      const tail = log.split("\n").filter(l => l.trim()).slice(-14).join("\n");
      return `${what} never arrived.\nThe console showed: ${panel}\nThe agent process is ${alive}.\nThe last commands were: ${JSON.stringify(rows)}\n` +
        `The agent never answered ${stuck.length} of them; its log says about those: ${mentions.length ? mentions.slice(-6).join(" | ") : "(nothing)"}\nThe agent's last lines:\n${tail}`;
    };

    // ---- Ada uploads: the good package passes the server's checks, the tampered one is refused ----
    const ada = await signIn("ada");
    await ada.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Admin" }).click();
    await ada.getByRole("link", { name: /Software library/ }).click();
    await ada.getByRole("heading", { name: "Software library", level: 1 }).waitFor();
    const uploadPackage = async (name: string, file: string) => {
      await ada.getByLabel("Name", { exact: true }).fill(name);
      await ada.getByLabel("Version").fill("2.1");
      await ada.getByLabel("Vendor").fill("Scanner Vendor");
      await ada.getByLabel(/Hardware IDs it is for/).fill("USB\\VID_1234&PID_5678");
      await ada.getByLabel("File").setInputFiles(file);
      await ada.getByRole("button", { name: "Upload" }).click();
      await confirm(ada, people.ada.secret, /Upload/);
    };
    await uploadPackage("Scanner driver", goodFile);
    await ada.getByText(/passed the server's checks \(signed by Scanner Vendor Inc\)/).waitFor();
    await uploadPackage("Tampered driver", tamperedFile);
    await ada.getByText(/The server refused the package\. Package signature not valid\./).waitFor();
    const goodRow = ada.getByRole("row", { name: /Scanner driver 2\.1/ });
    await goodRow.getByText("Another Admin must approve", { exact: true }).waitFor();
    await ada.getByRole("row", { name: /Tampered driver 2\.1/ }).getByText("Refused", { exact: true }).waitFor();
    await a11y(ada, "software library");
    await shot(ada, "m5-1-library");

    // ---- Abe approves it (the second Admin) -------------------------------------------
    const abe = await signIn("abe");
    await abe.goto(`${origin}/admin/software`);
    await abe.getByRole("row", { name: /Scanner driver 2\.1/ }).getByRole("button", { name: "Approve" }).click();
    await confirm(abe, people.abe.secret, /so Tier 2 and Admins can install it/);
    await abe.getByRole("row", { name: /Scanner driver 2\.1/ }).getByText("Approved", { exact: true }).waitFor();

    // ---- Tess installs it from the cabinet's Software section ---------------------------
    const tess = await signIn("tess");
    await section(tess, "software");
    await tess.getByRole("heading", { name: "Software", level: 2 }).waitFor();
    const pkg = tess.locator(".packages > li").filter({ hasText: "Scanner driver" });
    await pkg.getByRole("button", { name: "Install" }).click({ timeout: 30_000 });
    await confirm(tess, people.tess.secret, /Install Scanner driver 2\.1/);
    await pkg.getByText(/Installed\. Hash, signature and publisher checks passed; signed by Scanner Vendor Inc/).waitFor({ timeout: 60_000 });
    await a11y(tess, "software");
    await shot(tess, "m5-2-installed");

    // ---- Firewall: turn a profile off for 15 minutes, add a rule, see both in the history ----
    await section(tess, "firewall");
    const pub = tess.getByRole("article", { name: "public profile" });
    await pub.getByRole("button", { name: "Turn off…" }).click();
    await pub.getByLabel("Turn off for").selectOption({ label: "15 minutes" });
    assert.equal(await pub.getByRole("option", { name: /No time limit/ }).count(), 1, "Tier 2 may choose no time limit");
    await pub.getByRole("button", { name: "Review" }).click();
    await click(tess, /It turns itself back on after 15 minutes, even if the cabinet restarts/);
    await tess.getByText(/Public profile is now off\. It turns back on at/).waitFor({ timeout: 60_000 });
    await tess.getByRole("article", { name: "public profile" }).getByText(/Turns itself back on at .* \(in 1[45] minutes\)/).waitFor({ timeout: 30_000 });

    await tess.getByRole("button", { name: "Add a rule…" }).click();
    const form = tess.getByRole("form", { name: /New firewall rule/ });
    await form.getByLabel(/^Name/).fill("MashuraDiag Sync 1433");
    await form.getByLabel("Local ports").fill("1433, 2000-2010");
    await form.getByLabel("Remote addresses").fill("10.20.0.0/24");
    await form.getByRole("button", { name: "Review" }).click();
    await click(tess, /Create firewall rule MashuraDiag Sync 1433/);
    await tess.getByText(/Rule MashuraDiag Sync 1433 created/).waitFor({ timeout: 60_000 });
    const listed = tess.getByRole("list", { name: "Firewall rules" }).getByRole("listitem").filter({ hasText: "MashuraDiag Sync 1433" });
    await listed.getByText("Platform", { exact: true }).waitFor({ timeout: 30_000 });
    const history = tess.getByRole("list", { name: "Firewall changes, newest first" });
    await until("both changes in the firewall history", async () => {
      await tess.getByRole("region", { name: "Firewall history" }).getByRole("button", { name: "Refresh" }).click();
      return (await history.getByRole("listitem").filter({ hasText: "by Tess Tier2" }).count()) >= 2;
    });
    await history.getByText(/Before: public: on.*After: public: off/).first().waitFor();
    await tess.getByRole("heading", { name: "Saved snapshots" }).waitFor();
    await a11y(tess, "firewall");
    await shot(tess, "m5-3-firewall");

    // ---- Network: Edit DNS, with current and new values side by side and the safety-net warning ----
    await section(tess, "network");
    try {
      await tess.getByRole("button", { name: "Edit DNS" }).click({ timeout: 30_000 });
    } catch {
      throw new Error(await why(tess, "the network section's Edit DNS button"));
    }
    await tess.getByLabel("Set by hand").check();
    await tess.getByLabel(/Up to 4 servers/).fill("10.20.0.53, 10.20.0.54");
    await tess.getByRole("button", { name: "Review the change" }).click();
    const dnsDialog = tess.getByRole("dialog", { name: "Confirm with your authenticator" });
    await dnsDialog.getByRole("cell", { name: "10.20.0.53, 10.20.0.54" }).waitFor();
    await dnsDialog.getByText(/puts the old settings back by itself/).waitFor();
    await shot(tess, "m5-4-dns-confirm");
    await confirm(tess, people.tess.secret);
    await tess.getByText(/DNS changed: 10\.20\.0\.53, 10\.20\.0\.54\. The safety net kept the change/).waitFor({ timeout: 60_000 });

    // ---- Tier 1 applies the client's firewall policy (all off by default) with one click; no other write controls ----
    const sam = await signIn("sam");
    await section(sam, "firewall");
    await sam.getByRole("article", { name: "public profile" }).waitFor({ timeout: 30_000 });
    assert.equal(await sam.getByRole("button", { name: /Add a rule/ }).count(), 0, "rules are Tier 2");
    assert.ok(await sam.getByRole("button", { name: /Turn off|Turn on/ }).count() > 0, "Tier 1 turns profiles on and off");
    const policy = sam.getByRole("region", { name: /Firewall policy/ });
    await policy.getByText("Differs").waitFor({ timeout: 60_000 });
    await policy.getByRole("button", { name: "Apply policy" }).click();
    await click(sam, /Set the firewall profiles as the policy says: Domain off, Private off, Public off/);
    await sam.getByText(/Changed: Domain, Private\.|Changed: Domain, Private, Public\./).waitFor({ timeout: 60_000 });
    await until("the cabinet to report it matches", async () => (await db.app.query(
      "SELECT TOP (1) state FROM alerts WHERE cabinet_id = $1 AND issue_type_id = '00000000-0000-4000-8000-000000000113' ORDER BY first_seen DESC", [cabinetId])).rows[0]?.state === "resolved");
    await shot(sam, "m9-1-policy-applied");
    await section(sam, "software");
    await sam.locator(".packages > li").filter({ hasText: "Scanner driver" }).waitFor({ timeout: 30_000 });
    assert.equal(await sam.getByRole("button", { name: "Install" }).count(), 0);

    await section(sam, "services");
    await sam.getByRole("row", { name: /Biometric Scanner Service/ }).waitFor({ timeout: 60_000 });
    assert.equal(await sam.getByRole("button", { name: /^(Start|Stop|Restart|Watch)$/ }).count(), 0, "Tier 1 only looks at services");
    // A Tier 1 can change a start type, of an approved service and with an authenticator code (a start type decides what runs at the
    // next boot, so it is control): the owner approves the disabled service, which is then set to manual and read back.
    const disabled = { key: "app:disabled", kind: "service", name: "A disabled service", path: "C:\\Program Files\\Simulated\\DisabledSvc.exe", serviceName: "DisabledSvc" };
    await setApprovedApps(db.app, { userId: people.ada.id, role: "admin" }, "cabinet", cabinetId, [disabled],
      await issueStepUpToken(db.app, people.ada.id, APPS_SET_ACTION.cabinet, cabinetId, paramsHash({ level: "cabinet", id: cabinetId, entries: [disabled] })));
    await until("the cabinet's approved list with the disabled service", async () => {
      try { return readFileSync(join(state, "monitor-settings.json"), "utf8").includes("app:disabled"); } catch { return false; }
    });
    const disabledRow = sam.getByRole("row", { name: /A disabled service/ });
    await disabledRow.getByRole("cell", { name: /^Disabled/ }).waitFor();
    await disabledRow.getByRole("button", { name: "Change…" }).click();
    await sam.getByLabel("Start type", { exact: true }).selectOption("manual");
    await sam.getByRole("button", { name: "Review" }).click();
    await confirm(sam, people.sam.secret);
    await sam.getByText(/Service DisabledSvc: start type changed from Disabled to Manual\./).waitFor({ timeout: 60_000 });
    await disabledRow.getByRole("cell", { name: /^Manual/ }).waitFor({ timeout: 60_000 });

    // ---- The approved list (milestone 10): the platform sends it in its heartbeat answer and the agent refuses
    // everything else, so nothing on the machine is controlled until an owner puts it on a list. Print Spooler goes on
    // this cabinet's list here: the restart below is then a change the cabinet will make.
    const spooler = { key: "app:spooler", kind: "service", name: "Print Spooler", path: "C:\\Program Files\\Simulated\\Spooler.exe", serviceName: "Spooler" };
    const asList = normalizeEntries([spooler]);
    assert.equal(asList.ok, true, `expected an approved list: ${JSON.stringify(asList)}`);
    await setApprovedApps(db.app, { userId: people.ada.id, role: "admin" }, "cabinet", cabinetId, [spooler],
      await issueStepUpToken(db.app, people.ada.id, APPS_SET_ACTION.cabinet, cabinetId,
        paramsHash({ level: "cabinet", id: cabinetId, entries: [spooler] })));
    // The agent works from its own copy of the list, refreshed on its next heartbeat (every two seconds here).
    await until("the cabinet's approved list", async () => {
      try { return readFileSync(join(state, "monitor-settings.json"), "utf8").includes("app:spooler"); } catch { return false; }
    });

    // ---- Services: Tess restarts the print spooler (with her code: the server asks for one) and watches the scanner service ----
    await section(tess, "services");
    const scannerRow = tess.getByRole("row", { name: /Biometric Scanner Service/ });
    await scannerRow.getByText("Running", { exact: true }).waitFor({ timeout: 60_000 });
    await tess.getByRole("row", { name: /Print Spooler/ }).getByRole("button", { name: "Restart" }).click();
    await confirm(tess, people.tess.secret, /Restart the service Print Spooler/);
    const restarted = tess.getByText(/Service Spooler: restart done; it is now running\./);
    try {
      await restarted.waitFor({ timeout: 60_000 });
    } catch {
      throw new Error(await why(tess, "the restart outcome"));
    }
    await scannerRow.getByRole("button", { name: "Watch" }).click();
    await tess.getByRole("dialog", { name: "Confirm the change" }).getByRole("button", { name: "Make the change" }).click();
    await tess.getByRole("region", { name: "Watched services" }).getByRole("rowheader", { name: "BioScanSvc" }).waitFor();
    assert.deepEqual((await db.app.query<{ watched_services: string[] }>("SELECT watched_services FROM cabinets WHERE id = $1", [cabinetId])).rows[0]!.watched_services, ["BioScanSvc"]);
    await section(tess, "processes");
    await tess.getByRole("table", { name: "Running processes" }).getByRole("row").nth(1).waitFor({ timeout: 60_000 });
    await a11y(tess, "processes");
    await shot(tess, "m10-1-services");

    // ---- A fleet-wide pause: the banner on every page, and no write controls --------------
    await setFleetPause(db.app, people.ada.id, true, "Change freeze for the audit", await issueStepUpToken(db.app, people.ada.id, "writes.pause", "fleet"));
    await section(tess, "firewall");
    await tess.getByText(/Changes to cabinets are paused fleet-wide\..*Change freeze for the audit/).waitFor();
    await tess.getByRole("article", { name: "public profile" }).waitFor({ timeout: 30_000 });
    assert.equal(await tess.getByRole("button", { name: /Turn off|Turn on|Add a rule/ }).count(), 0);
    await shot(tess, "m5-5-paused");

    // Every write is in the audit log, by the person who confirmed it, and the chain is intact.
    const writes = (await db.app.query<{ op: string; actor: string }>(
      "SELECT JSON_VALUE(details, '$.operation') AS op, actor_id AS actor FROM audit_log WHERE action = 'command.write' ORDER BY seq")).rows;
    assert.deepEqual(writes.map(w => w.op), ["package.install", "firewall.setProfile", "firewall.setRule", "network.setDns", "firewall.applyPolicy", "service.setStartType", "service.control"]);
    assert.ok(writes.slice(0, 4).every(w => w.actor === people.tess.id));
    assert.equal(writes[4]!.actor, people.sam.id);
    assert.equal(writes[5]!.actor, people.sam.id);
    assert.equal(writes[6]!.actor, people.tess.id);
    assert.equal((await verifyAuditChain(db.app)).ok, true);
    assert.deepEqual(problems, []);
  } finally {
    // Each step is named, and reported if it stalls, so a hung teardown says where it is.
    const step = async (name: string, fn: () => Promise<unknown>) => {
      const slow = setTimeout(() => console.error(`teardown: ${name} has taken over 15 s`), 15_000);
      try { await fn(); } catch (e) { console.error(`teardown: ${name} failed: ${(e as Error).message}`); } finally { clearTimeout(slow); }
    };
    agent.kill("SIGINT");
    await step("browser", () => browser.close());
    await step("result stream", () => stream.stop()); // ends the open event streams first, so the console API can close
    await step("console API", () => consoleApi.close());
    await step("agent API", () => agentApi.close());
    await step("notifier", () => notifier.stop());
    feed.stop();
    await step("database", () => db.drop());
  }
});
