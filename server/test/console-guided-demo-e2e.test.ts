// The guided demo from a fresh install, in a real browser, using only what the guided demo itself offers: the first click sets the demo up,
// then Next and Show me take the person to each control and outline it, and every action is done on the outlined control. The test never
// types an address. It ends on enrolling a real cabinet, and a second run shows the demo resets itself to its starting state.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { DemoSimulator, storyReady } from "../src/demo/demo.js";
import { createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { createTestDatabase, startFeed } from "./database.js";
import { agentDownloads, csrFor, ecKey, tempDir } from "./helpers.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";
const freePort = (): Promise<number> => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

test("the guided demo from a fresh install: it sets itself up, every step goes to and outlines the right control, and it ends on enrolling a cabinet", { skip, timeout: 400_000 }, async () => {
  const { chromium } = await import("playwright");
  const db = await createTestDatabase();
  let clock = Date.now();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const secrets = new SecretBox(randomBytes(32).toString("base64"));
  const stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  const app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin, stream, staticDir: dist, agentSetup: agentDownloads(), ...(process.env.LOGS ? {} : { logger: false }), now: () => clock });
  await app.listen({ host: "127.0.0.1", port });
  const password = "correct horse battery staple";
  const secret = totp.newSecret();
  const adminId = randomUUID();
  // A fresh install: one Admin who has not seen the getting-started tour, no demo, nothing else.
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, 'ada.admin', 'Ada Admin', 'admin', $2, 0, 1, $3, 0)`, [adminId, await hashPassword(password), secrets.seal(secret)]);
  assert.equal(await storyReady(db.app), false, "the demo is off");
  const simulatorProblems: string[] = [];
  const simulator = new DemoSimulator(db.app, m => simulatorProblems.push(m));
  simulator.start();
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    // After a reset the pages that were open may still ask for cabinets that no longer exist: a 404 is expected then, and only then.
    let resetting = false;
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409|429)/.test(m.text()) && !(resetting && /status of 404/.test(m.text()))) problems.push(m.text()); });
    const code = async () => { clock += 30_000; return totp.code(secret, totp.stepAt(clock)); };
    const confirmWithCode = async () => {
      await page.getByRole("dialog").getByLabel("Authenticator code").fill(await code());
      await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    };
    await page.goto(origin);
    await page.getByLabel("Username").fill("ada.admin");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByLabel(/6-digit code/).fill(await code());
    await page.getByRole("button", { name: "Continue" }).click();
    if (process.env.SHOTS) { await page.waitForTimeout(500); await page.screenshot({ path: `${process.env.SHOTS}/wizard.png` }); }
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();

    // The only navigation the test does: from the Admin page, where a new Admin looks for it, to the button that starts the demo.
    await page.getByRole("link", { name: "Admin", exact: true }).click();
    await page.locator("ul.tiles").getByRole("link", { name: /Setup/ }).click();
    await page.getByRole("button", { name: "Start the guided demo" }).click();
    await page.getByRole("dialog").getByText(/The guided demo needs the simulated fleet\. This adds it/).waitFor();
    await confirmWithCode();

    // From here on the test only clicks what the tour outlines.
    let shots = 0;
    const panel = page.locator("aside.demo-tour");
    const outlined = (selector: string, text?: string) => page.locator(`${selector}.tour-target`, text ? { hasText: text } : {}).first();
    const arrive = async (title: string, selector?: string, text?: string) => {
      await panel.getByRole("heading", { name: title }).waitFor({ timeout: 60_000 });
      if (selector) await outlined(selector, text).waitFor({ timeout: 90_000 });
      if (process.env.SHOTS) { await page.waitForTimeout(1500); await page.screenshot({ path: `${process.env.SHOTS}/fresh-${String(++shots).padStart(2, "0")}.png` }); }
    };
    const next = () => panel.getByRole("button", { name: "Next" }).click();
    const clickOutlined = (selector: string, text?: string) => outlined(selector, text).click();

    await arrive("Site overview");
    assert.equal(await storyReady(db.app), true, "starting the demo set the whole environment up");
    // The panel shows the step at once; the tour moves to its first page once the scenarios are read, so wait for that page.
    await page.waitForURL(/\/sites\//);
    await next();
    await arrive("Single-cabinet network diagnosis", '[data-tour="diagnose"]');
    assert.match(page.url(), /\/cabinets\/.*\/network/);
    assert.equal(await panel.getByRole("button", { name: /Show me|Look again/ }).count(), 0, "no extra button while the control is found");
    await arrive("Single-cabinet network diagnosis", '[data-tour="diagnose"]');
    assert.equal(await panel.getByRole("button", { name: "Next" }).isDisabled(), true, "Next waits for the click the step asks for");
    await page.getByText(/To continue: Click Diagnose network/).waitFor();
    await clickOutlined('[data-tour="diagnose"]');
    await page.getByText(/The firewall on Midtown Sync is blocking port/).first().waitFor({ timeout: 60_000 });
    await panel.getByRole("button", { name: "Next" }).waitFor({ state: "visible" });
    await page.waitForFunction(() => !(document.querySelector(".demo-tour button.primary") as HTMLButtonElement | null)?.disabled, undefined, { timeout: 10_000 });

    // Step 3 asks for a click, and Next does nothing until it is done.
    await next();
    await arrive("Site-wide network diagnosis", '[data-tour="site-diagnose"]');
    assert.match(page.url(), /\/sites\//);
    assert.equal(await panel.getByRole("button", { name: "Next" }).isDisabled(), true, "Next waits for the site check");
    await clickOutlined('[data-tour="site-diagnose"]');
    await page.waitForURL(/\/network\/diagnosis\//, { timeout: 60_000 });
    await page.waitForFunction(() => !(document.querySelector(".demo-tour button.primary") as HTMLButtonElement | null)?.disabled, undefined, { timeout: 10_000 });
    await next();
    await arrive("Diagnosis results", '[data-tour="group-sync-firewall"]');
    assert.match(page.url(), /\/network\/diagnosis\//, "the tour opened the site's results itself");
    await next();
    await arrive("Remediation", '[data-tour="fix-apply_policy"]');
    // The demo can be run as often as wanted: writes to simulated cabinets never count toward the hourly limit or pause anyone.
    await db.app.query("UPDATE users SET write_limit = 1 WHERE id = $1", [adminId]);
    await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status)
                        SELECT NEWID(), k.id, 'firewall.setProfile', '{}', $1, SYSUTCDATETIME(), DATEADD(minute, 5, SYSUTCDATETIME()), 'succeeded' FROM cabinets k CROSS JOIN (VALUES (1), (2), (3)) g(n) WHERE k.name = 'Midtown Sync'`, [adminId]);
    assert.equal(await panel.getByRole("button", { name: "Next" }).isDisabled(), true, "Next waits for the fix to be applied");
    await clickOutlined('[data-tour="fix-apply_policy"]');
    await page.getByRole("dialog").getByRole("button", { name: "Make the change" }).click();
    await page.getByText(/Done: Apply the policy on Midtown Sync/).waitFor({ timeout: 60_000 });
    await page.getByText("8 of 9 cabinets are clean.").waitFor({ timeout: 90_000 });
    await page.waitForFunction(() => !(document.querySelector(".demo-tour button.primary") as HTMLButtonElement | null)?.disabled, undefined, { timeout: 10_000 });
    assert.deepEqual(Object.values((await db.app.query<{ firewall_profiles: Record<string, boolean> }>("SELECT firewall_profiles FROM cabinets WHERE name = 'Midtown Sync'")).rows[0]!.firewall_profiles), [false, false, false]);

    await next();
    await arrive("Full network reading", '[data-tour="full-read"]');
    assert.match(page.url(), /\/cabinets\/.*\/network/);
    assert.equal(await panel.getByRole("button", { name: "Next" }).isDisabled(), true, "Next waits for the full reading to be opened");
    await page.locator("summary", { hasText: "Everything that was read" }).click();
    await page.waitForFunction(() => !(document.querySelector(".demo-tour button.primary") as HTMLButtonElement | null)?.disabled, undefined, { timeout: 10_000 });
    // The drawer: the check finds the firewall on, the policy turns it off, and the next check reads off.
    await next();
    await arrive("Drawer check", '[data-tour="drawer-check"]');
    assert.equal(await panel.getByRole("button", { name: "Next" }).isDisabled(), true, "Next waits for the drawer to be fixed");
    await page.getByRole("button", { name: "Check drawer" }).click();
    await page.getByRole("row", { name: /^Firewall/ }).getByText(/^On for/).waitFor({ timeout: 60_000 });
    await page.getByRole("row", { name: /^IPv4/ }).getByText(/172\.20\.1\.0\/32, the drawer address/).waitFor();
    await page.getByRole("button", { name: "Apply the firewall policy" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Make the change" }).click();
    await page.getByRole("row", { name: /^Firewall/ }).getByText("Off on every profile").waitFor({ timeout: 90_000 }).catch(async e => {
      throw new Error(`${e.message}\nDrawer panel: ${await page.locator('[data-tour="drawer-check"]').innerText()}\nAlerts: ${JSON.stringify(await page.locator("[role=alert]").allTextContents())}`);
    });
    assert.deepEqual(Object.values((await db.app.query<{ firewall_profiles: Record<string, boolean> }>("SELECT firewall_profiles FROM cabinets WHERE name = 'Pharmacy Sync'")).rows[0]!.firewall_profiles), [false, false, false], "the drawer cabinet's firewall really is off");
    await page.waitForFunction(() => !(document.querySelector(".demo-tour button.primary") as HTMLButtonElement | null)?.disabled, undefined, { timeout: 10_000 });
    await next();
    await arrive("Fingerprint scanner history", '[data-tour="scanner-drops"]');
    await next();
    await arrive("Service start type", '[data-tour="start-type"]');
    assert.equal(await panel.getByRole("button", { name: "Next" }).isDisabled(), true, "Next waits for the start type change");
    await clickOutlined('[data-tour="start-type"]');
    await page.getByLabel("Start type", { exact: true }).selectOption("manual");
    await page.getByRole("button", { name: "Review" }).click();
    await confirmWithCode(); // a start type is control: an approved service only, with an authenticator code
    await page.getByText(/Service BioUpdateSvc: start type changed from Disabled to Manual\./).waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => !(document.querySelector(".demo-tour button.primary") as HTMLButtonElement | null)?.disabled, undefined, { timeout: 10_000 });
    await next();
    await arrive("Unrecognized alerts", '[data-cabinet="Reception"]');
    assert.match(page.url(), /\/alerts/);
    await next();
    await arrive("Event log inspection", '[data-tour="event-entry"]', "Biometrics");
    await clickOutlined('[data-tour="event-entry"]', "Biometrics");
    await page.locator("#entry-heading").waitFor({ timeout: 60_000 });
    await next();
    await arrive("Event-to-issue mapping", '[data-tour="map-to-issue"]');
    await clickOutlined('[data-tour="map-to-issue"]');
    await page.getByRole("dialog").locator("select[required]").selectOption({ label: "Fingerprint scanner problem (major)" });
    await page.getByRole("dialog").getByLabel("Authenticator code").fill(await code());
    await page.getByRole("dialog").getByRole("button", { name: "Save and go live" }).click();
    await page.getByText(/The rule is live\. From now on this error raises/).waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

    await next();
    await arrive("Fix approval", '[data-tour="fix-approve"]');
    assert.match(page.url(), /\/fixes/);
    await clickOutlined('[data-tour="fix-approve"]');
    await page.getByText(/Approved “Reader drops after a driver install”/).waitFor();
    await next();
    await arrive("Learned fixes on the alert", ".known-fixes");
    await page.getByText("Possible fix", { exact: true }).first().waitFor();

    // Onboarding is the last part: install, approve, check, read the network.
    await next();
    await arrive("Enrollment: install the agent", '[data-tour="create-token"]');
    assert.match(page.url(), /\/admin\/setup/);
    assert.equal(await panel.getByRole("button", { name: "Next" }).isDisabled(), true, "Next waits for the token");
    await clickOutlined('[data-tour="create-token"]');
    await confirmWithCode();
    await page.getByRole("link", { name: "Download Install-CabinetAgent.cmd" }).waitFor();
    const { token } = await createBootstrapToken(db.app, adminId);
    await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: {
      hostname: "SUPPORT-LAPTOP", serialNumber: "5CG0REAL001", macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: new Date().toISOString(),
      osVersion: "Windows 11 Pro", agentVersion: "0.2.0" } }, "127.0.0.1");
    await next();
    await arrive("Enrollment: approve the cabinet", '[data-tour="approve-cabinet"]');
    assert.match(page.url(), /\/admin\/pending/);
    await page.getByLabel("Client", { exact: true }).fill("Mashura Office");
    await page.getByLabel("Site", { exact: true }).fill("Support desk");
    // No approved baseline applies to a new client: the approval asks for the decision.
    await page.getByLabel("Capture this cabinet's configuration as the site baseline draft").check();
    await clickOutlined('[data-tour="approve-cabinet"]');
    await confirmWithCode();
    await page.getByText(/Approved\. SUPPORT-LAPTOP will come online within a minute/).waitFor();
    await next();
    await arrive("Live verification", '[data-tour="live-run"]');
    assert.match(page.url(), /\/admin\/setup/);
    await next();
    await arrive("Network reading from a live cabinet", '[data-tour="diagnose"]');
    assert.match(page.url(), /\/cabinets\/.*\/network/);
    assert.equal(await panel.getByRole("button", { name: "Next" }).count(), 0, "the enrollment is the last step");
    await panel.getByRole("button", { name: "Finish" }).click();
    assert.equal(await panel.count(), 0, "the tour is over");

    // The story is used up. Starting the guided demo again resets the demo to its starting state first.
    assert.equal(await storyReady(db.app), false);
    await page.getByRole("link", { name: "Admin", exact: true }).click();
    await page.locator("ul.tiles").getByRole("link", { name: /Setup/ }).click();
    await page.getByLabel("Demo mode").getByRole("button", { name: "Start the guided demo" }).click();
    resetting = true;
    await page.getByRole("dialog").getByText(/it has been used\. This deletes the simulated fleet and builds it again/).waitFor();
    await confirmWithCode();
    await panel.getByRole("heading", { name: "Site overview" }).waitFor({ timeout: 90_000 })
      .catch(async e => { throw new Error(`${e.message}\nalerts on the page: ${JSON.stringify(await page.locator("[role=alert]").allTextContents())}`); });
    assert.equal(await storyReady(db.app), true, "the reset put the story back at its start, with the mapped rule switched off");
    assert.deepEqual(simulatorProblems, []);
    assert.deepEqual(problems, []);
  } finally {
    simulator.stop();
    await browser.close();
    await app.close();
    await stream.stop();
    await db.drop();
  }
});
