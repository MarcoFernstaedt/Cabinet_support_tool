// Milestone 6 done-when, in a real browser: an Admin manages accounts, answers "who looked at this
// cabinet and when" from the console, pauses writes, and sees a security alert for each trigger in
// docs/spec/05-server-spec.md, each raised through its real code path. Runs when the console is built.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConsoleApi } from "../src/console-api/server.js";
import { buildAgentApi } from "../src/agent-api/server.js";
import { CommandNotifier } from "../src/agent-api/notifier.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { paramsHash } from "../src/auth/canonical.js";
import { developmentIssuingKey, developmentServerCertificate } from "../src/pki/issuing.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { storeEvents } from "../src/services/events.js";
import { issueCommand, storeResult } from "../src/services/commands.js";
import { asOwner, createTestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir, setUpAuthenticatorInBrowser } from "./helpers.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";
const freePort = (): Promise<number> => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

test("administration in the console: accounts, who opened a cabinet, pausing writes, and a security alert for every trigger", { skip, timeout: 240_000 }, async () => {
  const { chromium } = await import("playwright");
  const db = await createTestDatabase();
  const dir = tempDir();
  const key = await developmentIssuingKey(dir);
  let clock = Date.now();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const secrets = new SecretBox(randomBytes(32).toString("base64"));
  const stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  // Behind the reverse proxy in production; here the browser's X-Forwarded-For plays a sign-in from another network.
  const app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin, stream, staticDir: dist, logger: false, trustProxy: 1, now: () => clock });
  await app.listen({ host: "127.0.0.1", port });
  const notifier = new CommandNotifier(db.appUrl);
  await notifier.start();
  const agentApi = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, tls: await developmentServerCertificate(key, dir, ["localhost"]), longPollMs: 1000, logger: false });
  await agentApi.listen({ host: "127.0.0.1", port: 0 });
  const agentPort = (agentApi.server.address() as { port: number }).port;

  const password = "correct horse battery staple";
  const adaSecret = totp.newSecret();
  const adaId = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, 'ada.admin', 'Ada Admin', 'admin', $2, false, true, $3, true)`, [adaId, await hashPassword(password), secrets.seal(adaSecret)]);
  const code = (): string => { clock += 30_000; return totp.code(adaSecret, totp.stepAt(clock)); };
  const { token } = await createBootstrapToken(db.app, adaId);
  const requestId = await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: {
    hostname: "CAB-ICU", serialNumber: null, macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 10", agentVersion: "0.4.0" } }, "127.0.0.1");
  const { cabinetId } = await approveEnrollment(db.app, key, requestId, { clientName: "Acme Health", siteName: "North", cabinetName: "ICU cabinet", role: "standalone" }, adaId);
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = now(), read_only = false");

  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  try {
    const open = async (who: string, headers: Record<string, string> = {}) => {
      const p = await (await browser.newContext({ extraHTTPHeaders: headers })).newPage();
      p.on("pageerror", e => problems.push(`${who} page error: ${e.message}`));
      p.on("console", m => { if (m.type() === "error" && !/status of (401|403|409|429)/.test(m.text())) problems.push(`${who}: ${m.text()}`); });
      await p.goto(origin);
      return p;
    };
    const signIn = async (p: Awaited<ReturnType<typeof open>>, username: string, pw: string) => {
      await p.getByLabel("Username").fill(username);
      await p.getByLabel("Password").fill(pw);
      await p.getByRole("button", { name: "Sign in" }).click();
    };
    const confirm = async (p: Awaited<ReturnType<typeof open>>, expect?: RegExp) => {
      const dialog = p.getByRole("dialog", { name: "Confirm with your authenticator" });
      if (expect) await dialog.getByText(expect).first().waitFor();
      await dialog.getByLabel("Authenticator code").fill(code());
      await dialog.getByRole("button", { name: "Confirm" }).click();
    };
    const shot = async (p: Awaited<ReturnType<typeof open>>, name: string) => { if (process.env.E2E_SCREENSHOTS) await p.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}.png`), fullPage: true }); };
    const a11y = async (p: Awaited<ReturnType<typeof open>>, where: string) => {
      assert.equal(await p.locator("h1").count(), 1, `${where}: one main heading`);
      const unnamed = await p.$$eval("button", bs => bs.filter(b => !(b.textContent ?? "").trim() && !b.getAttribute("aria-label")).length);
      assert.equal(unnamed, 0, `${where}: every button has a name`);
    };

    const ada = await open("ada");
    await signIn(ada, "ada.admin", password);
    await ada.getByLabel(/6-digit code/).fill(code());
    await ada.getByRole("button", { name: "Continue" }).click();
    await ada.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();
    const goto = (path: string) => ada.goto(origin + path);

    // ---- Accounts: create, first sign-in, the rules, reset ----------------------------------
    await goto("/admin/users");
    await ada.getByLabel("Username").fill("sam.support");
    await ada.getByLabel("Full name").fill("Sam Support");
    await ada.getByRole("button", { name: "Create account" }).click();
    await confirm(ada, /Create a Tier 1 account/);
    const temporary = (await ada.locator("code.secret").textContent())!.trim();
    assert.match(temporary, /^[A-Za-z0-9_-]{16}$/);
    await a11y(ada, "users");
    await shot(ada, "m6-1-users");
    await ada.getByRole("button", { name: "I have passed it on" }).click();

    const sam = await open("sam");
    await signIn(sam, "sam.support", temporary);
    // Every account, Tier 1 included, sets up an authenticator first.
    await sam.getByRole("heading", { name: "Set up your authenticator" }).waitFor();
    // A QR code to scan, not a key to type; no phone link on a desktop-first console; the key only behind "Cannot scan it?".
    await sam.getByRole("img", { name: "QR code to scan with your authenticator app" }).locator("svg").waitFor();
    assert.equal(await sam.getByText("open this link").count(), 0);
    assert.equal(await sam.locator("details code.secret").isVisible(), false);
    await setUpAuthenticatorInBrowser(sam, s => { clock += 30_000; return totp.code(s, totp.stepAt(clock)); });
    await sam.getByLabel("Temporary password").fill(temporary);
    await sam.getByLabel("New password (at least 12 characters)").fill("sam's own long password");
    await sam.getByLabel("New password again").fill("sam's own long password");
    await sam.getByRole("button", { name: "Save password" }).click();
    await sam.getByRole("dialog", { name: "Mashura Support Console" }).getByRole("button", { name: "Skip tour" }).click();
    await sam.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();

    // ---- Who looked at this cabinet and when ----------------------------------------------------
    await sam.goto(`${origin}/cabinets/${cabinetId}`);
    await sam.getByRole("heading", { name: "ICU cabinet", level: 1 }).waitFor();
    await goto("/admin/online");
    const samOnline = ada.getByRole("row", { name: /Sam Support/ });
    await samOnline.getByRole("link", { name: "ICU cabinet" }).waitFor();
    await shot(ada, "m6-2-online");
    await goto(`/cabinets/${cabinetId}`);
    await ada.getByRole("link", { name: "Access history" }).click();
    await ada.getByRole("heading", { name: "Audit log", level: 1 }).waitFor();
    const viewRow = ada.getByRole("row").filter({ hasText: "Sam Support" }).filter({ hasText: "cabinet.view" }).first();
    await viewRow.waitFor();
    assert.match((await viewRow.textContent())!, /ICU cabinet/);
    await a11y(ada, "audit");
    await shot(ada, "m6-3-who-opened");

    // Resetting Sam's password ends Sam's session at once.
    await goto("/admin/users");
    await ada.getByRole("row", { name: /Sam Support/ }).getByRole("button", { name: "Reset password" }).click();
    await confirm(ada, /Reset the password/);
    await ada.locator("code.secret").waitFor();
    await sam.reload();
    await sam.getByRole("heading", { name: "Sign in" }).waitFor();

    // ---- Pause writes ---------------------------------------------------------------------------
    await goto("/admin/safety");
    await ada.getByLabel("Reason (shown in the banner)").fill("Investigating a security alert");
    await ada.getByRole("button", { name: "Pause changes fleet-wide" }).click();
    await confirm(ada, /Pause changes to every cabinet/);
    await ada.getByText(/Changes to cabinets are paused fleet-wide\..*Investigating a security alert/).waitFor();
    await a11y(ada, "fleet safety");
    await shot(ada, "m6-4-paused");
    assert.equal((await db.app.query("SELECT value->>'paused' AS p FROM settings WHERE key = 'writes.paused'")).rows[0].p, "true");

    // ---- A security alert for every trigger -------------------------------------------------------
    await goto("/admin/security");
    await ada.getByRole("heading", { name: "Security alerts", level: 1 }).waitFor();
    // 1. Repeated failed sign-ins (in a browser).
    const mallory = await open("mallory");
    for (let i = 0; i < 5; i++) {
      await signIn(mallory, "sam.support", `wrong password ${i}`);
      await mallory.getByRole("alert").waitFor();
    }
    // The alert arrives on Ada's console at once, without a refresh.
    await ada.getByRole("complementary", { name: "New security alerts" }).getByText(/Repeated failed sign-ins on sam.support/).waitFor({ timeout: 15_000 });
    // 2. Repeated failed step-ups (an Admin's account, through the API the console uses).
    const tessSecret = totp.newSecret();
    const tessId = randomUUID();
    await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                        VALUES ($1, 'tess.tier2', 'Tess Tier2', 'tier2', $2, false, true, $3, true)`, [tessId, await hashPassword(password), secrets.seal(tessSecret)]);
    const tess = await open("tess");
    await signIn(tess, "tess.tier2", password);
    await tess.getByLabel(/6-digit code/).fill(totp.code(tessSecret, totp.stepAt(clock += 30_000)));
    await tess.getByRole("button", { name: "Continue" }).click();
    await tess.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();
    // From inside Tess's console page, the way the console itself calls the API.
    const fromPage = (page: typeof tess, method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => {
      const r = await fetch(p as string, { method: m as string, headers: { "Content-Type": "application/json" }, ...(b ? { body: JSON.stringify(b) } : {}) });
      return r.status;
    }, [method, path, body ?? null] as const);
    for (let i = 0; i < 5; i++) assert.equal(await fromPage(tess, "POST", "/api/auth/step-up", { code: "000000", action: "user.create", target: "fleet" }), 401);
    // 3. A sign-in from a network Tess has not used before.
    const away = await open("tess-away", { "X-Forwarded-For": "203.0.113.77" });
    await db.app.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [tessId]);
    await signIn(away, "tess.tier2", password);
    await away.getByLabel(/6-digit code/).waitFor();
    // 4. Unusual write volume (Tess goes over a limit of 1; resumed afterwards so the pause above is the only one).
    await db.app.query("UPDATE users SET write_limit = 1 WHERE id = $1", [tessId]);
    await db.app.query("DELETE FROM settings WHERE key = 'writes.paused'");
    for (let i = 0; i < 2; i++)
      await issueCommand(db.app, tessId, cabinetId, "network.setDns", { interfaceIndex: 12, mode: "automatic" }, "command.issue",
        { stepUpToken: await issueStepUpToken(db.app, tessId, "network.setDns", cabinetId, paramsHash({ interfaceIndex: 12, mode: "automatic" })) }).catch(() => undefined);
    // 5. An audit chain break, found by Ada's check in the console.
    const seq = (await db.app.query<{ seq: string }>("SELECT seq FROM audit_log ORDER BY seq LIMIT 1 OFFSET 2")).rows[0]!.seq;
    await asOwner(db, async k => {
      await k.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable");
      await k.query("UPDATE audit_log SET outcome = 'refused' WHERE seq = $1", [seq]);
      await k.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable");
    });
    await goto("/admin/audit");
    await ada.getByRole("button", { name: "Verify the chain" }).click();
    await ada.getByText(`Chain broken at entry ${seq}`).waitFor();
    // 6-8. The cabinet reports a failed self-check; it refuses a package from an unlisted publisher and one whose signature fails.
    const at = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    await storeEvents(db.app, cabinetId, { events: [{ eventId: randomUUID(), kind: "security", occurredAt: at(), severityHint: "major",
      detail: { message: "Cabinet.Agent.Network.dll does not match its signed hash.", fields: { check: "self_check" } } }] });
    for (const errorCode of ["publisher_not_trusted", "signature_invalid"]) {
      const cmd = randomUUID();
      await asOwner(db, k => k.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, delivered_at)
        VALUES ($1, $2, 'package.install', '{}', $3, now(), now() + interval '10 minutes', 'delivered', now())`, [cmd, cabinetId, adaId]));
      await storeResult(db.app, cabinetId, { commandId: cmd, status: "rejected", startedAt: at(), finishedAt: at(), error: { code: errorCode as "signature_invalid", message: "refused by the cabinet" } });
    }
    // 9. A connection with a certificate this platform never issued.
    const otherDir = tempDir();
    const stranger = await developmentServerCertificate(await developmentIssuingKey(otherDir), otherDir, ["cab-stranger"]);
    const refused = await new Promise<number>((done, fail) => {
      const req = httpsRequest({ host: "127.0.0.1", port: agentPort, path: "/agent/v1/heartbeat", method: "POST", servername: "localhost", ca: key.certificatePem,
        key: stranger.keyPem, cert: stranger.certPem, headers: { "content-type": "application/json" } }, res => { res.resume(); done(res.statusCode!); });
      req.on("error", fail);
      req.end(JSON.stringify({ agentVersion: "0.4.0", uptimeSeconds: 1, readOnlyMode: false }));
    });
    assert.equal(refused, 401);

    await goto("/admin/security");
    const list = ada.getByRole("list", { name: /Security alerts/ });
    for (const kind of ["Repeated failed sign-ins", "Repeated failed confirmations", "Sign-in from a new network", "Sign-in from a new device", "Unusual write volume", "Audit chain break",
      "Agent self-check failed", "Package refused", "Signature failure", "Revoked or unknown certificate"])
      await list.getByRole("listitem").filter({ hasText: kind }).first().waitFor({ timeout: 10_000 });
    assert.equal(await list.getByRole("listitem").count(), 10);
    await ada.getByRole("link", { name: /Admin/ }).filter({ hasText: "10" }).first().waitFor();
    await a11y(ada, "security alerts");
    await shot(ada, "m6-5-security-alerts");
    // Close one, with what was found and a code.
    const failed = list.getByRole("listitem").filter({ hasText: "Repeated failed sign-ins" });
    await failed.getByLabel("What you found").fill("Sam mistyped after the reset; confirmed by phone.");
    await failed.getByRole("button", { name: "Close alert" }).click();
    await confirm(ada, /Close the security alert/);
    await ada.getByRole("dialog").waitFor({ state: "hidden" });
    await ada.getByRole("button", { name: "Resolved" }).click();
    await ada.getByText(/Closed by Ada Admin .*Sam mistyped after the reset/).waitFor();

    // Tier 2 cannot see any of it, whatever they type into the address bar.
    await db.app.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [tessId]);
    assert.equal(await fromPage(tess, "GET", "/api/admin/security-alerts"), 403);
    assert.equal(await fromPage(tess, "GET", "/api/admin/audit"), 403);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await stream.stop();
    await app.close();
    await agentApi.close();
    await notifier.stop();
    await db.drop();
  }
});
