// The guided demo in a real browser: one story at Midtown Manhattan. The firewall fix is one click and it works (the site comes back clean),
// the scanner page shows three drops and the driver installed before them, and a site with no baseline still gets its network read.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { DemoSimulator, enableDemo } from "../src/demo/demo.js";
import { createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { createTestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";
const freePort = (): Promise<number> => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

test("the guided demo: check the site, fix the firewall with one click and see it clean, the scanner drops, and a network read with no baseline", { skip, timeout: 300_000 }, async () => {
  const { chromium } = await import("playwright");
  const db = await createTestDatabase();
  let clock = Date.now();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const secrets = new SecretBox(randomBytes(32).toString("base64"));
  const stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  const app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin, stream, staticDir: dist, logger: false, now: () => clock });
  await app.listen({ host: "127.0.0.1", port });
  const password = "correct horse battery staple";
  const secret = totp.newSecret();
  const adminId = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, 'ada.admin', 'Ada Admin', 'admin', $2, false, true, $3, true)`, [adminId, await hashPassword(password), secrets.seal(secret)]);
  await enableDemo(db.app, adminId);
  const simulatorProblems: string[] = [];
  const simulator = new DemoSimulator(db.app, m => simulatorProblems.push(m));
  simulator.start();
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409|429)/.test(m.text())) problems.push(m.text()); });
    await page.goto(origin);
    await page.getByLabel("Username").fill("ada.admin");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    clock += 30_000;
    await page.getByLabel(/6-digit code/).fill(totp.code(secret, totp.stepAt(clock)));
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();

    // One scenario in the guide.
    await page.goto(`${origin}/demo`);
    await page.getByText("Midtown Manhattan: site-wide sync failure", { exact: true }).waitFor();
    assert.equal(await page.locator("#main li.finding").count(), 1, "one scenario, not a library");
    await page.locator("#main").getByRole("button", { name: "Start the guided demo" }).click();

    // With SHOTS set, every step is photographed after it settles, for reviewing the screens.
    let shots = 0;
    const next = async () => {
      await page.getByRole("button", { name: "Next" }).click({ timeout: 20_000 }).catch(async e => { await page.screenshot({ path: "/tmp/fail.png" }); throw new Error(`${e.message}\nTour panel: ${await page.locator(".demo-tour").innerText()}`); });
      if (process.env.SHOTS) { await page.waitForTimeout(2500); await page.screenshot({ path: `${process.env.SHOTS}/tour-${String(++shots).padStart(2, "0")}.png` }); }
    };
    // Step 1 takes you to the site; step 2 is one cabinet, Exam Room 1, checked on its own.
    await page.getByRole("heading", { name: "Midtown Manhattan", level: 1 }).waitFor();
    await next();
    await page.getByRole("heading", { name: "Exam Room 1", level: 1 }).waitFor();
    // Each step outlines the control it is about on arrival, and never starts anything by itself; there is no Show me button while the control is found.
    const marked = (selector: string) => page.locator(`${selector}.tour-target`).first().waitFor({ timeout: 30_000 });
    await marked('[data-tour="diagnose"]');
    await marked('[data-tour="diagnose"]');
    await page.getByRole("button", { name: "Diagnose network", exact: true }).click();
    await page.getByText(/The firewall on Midtown Sync is blocking port/).first().waitFor({ timeout: 60_000 });
    // Step 3 is the whole site at once: the page waits for the click.
    await next();
    await marked('[data-tour="site-diagnose"]');
    assert.equal(await page.getByRole("button", { name: "Show me" }).count(), 0, "no Show me button while the control is outlined");
    assert.equal(await page.getByText("Firewall blocks the sync cabinet's ports").count(), 0, "arriving at a step does not start a check");
    await page.getByRole("button", { name: /Diagnose network \(9 cabinets\)/ }).click();
    await page.getByText("Firewall blocks the sync cabinet's ports").first().waitFor({ timeout: 60_000 });
    // Step 4 says what was found and points at it; step 5 is the fix, and it works: confirm, and the site is checked again and is clean.
    await next();
    await page.getByRole("heading", { name: "Diagnosis results" }).waitFor();
    await marked('[data-tour="group-sync-firewall"]');
    await next();
    await page.getByRole("heading", { name: "Remediation" }).waitFor();
    await marked('[data-tour="fix-apply_policy"]');
    await marked('[data-tour="fix-apply_policy"]');
    await page.getByRole("button", { name: /Apply the policy on Midtown Sync/ }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Make the change" }).click();
    await page.getByText(/Done: Apply the policy on Midtown Sync/).waitFor({ timeout: 60_000 });
    await page.getByText("8 of 9 cabinets are clean.").waitFor({ timeout: 90_000 });
    // The one left matches its baseline, and the full read still shows why it is slow: lost packets and card errors.
    await page.getByRole("row", { name: /Operating Room/ }).getByRole("button", { name: "Full read" }).click();
    await page.getByText(/Packet loss to the gateway/).first().waitFor();
    await page.getByText("Everything that was read").click();
    await page.getByRole("heading", { name: "Routes" }).waitFor();
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/batch-fullread.png`, fullPage: true });
    const policy = (await db.app.query<{ firewall_profiles: Record<string, boolean> }>("SELECT firewall_profiles FROM cabinets WHERE name = 'Midtown Sync'")).rows[0]!.firewall_profiles;
    assert.deepEqual(Object.values(policy), [false, false, false], "the cabinet really changed");

    // Step 6: Operating Room matches its baseline but loses packets. The fix is saved, with its setup, for next time.
    await next();
    await page.getByRole("heading", { name: "Operating Room", level: 1 }).waitFor();
    await marked('[data-tour="full-read"]');
    await page.getByText(/Packet loss to the gateway/).first().waitFor({ timeout: 60_000 });
    await page.locator("summary", { hasText: "Everything that was read" }).click();
    await page.locator(".demo-tour").getByText("Done.", { exact: true }).waitFor();
    // Nothing can be saved while the problem is still there. After the repair (the cable is swapped) the next check is clean, and only then is it offered.
    assert.equal(await page.getByRole("button", { name: "Save what fixed this…" }).count(), 0, "no save offer while the problem is present");
    await db.app.query("UPDATE cabinets SET demo_scenario = 'healthy' WHERE name = 'Operating Room'");
    await page.getByRole("button", { name: "Run again" }).first().click();
    await page.getByText("Fixed since the last check:").waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Save what fixed this…" }).first().click();
    await page.getByLabel("What fixed it").fill("Replaced the patch cable to the switch; the errors stopped.");
    await page.getByRole("button", { name: "Save…", exact: true }).click();
    // An Admin needs no approval: the fix is logged, and a confirmation asks first.
    await page.getByRole("dialog").getByText(/does not need approval because you can approve fixes/).waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Save the fix" }).click();
    await page.getByText(/Saved\. This is shown the next time/).waitFor();
    const kf = (await db.app.query<{ solution: string; environment: { site: string; network: { gateway: string } | null } }>("SELECT solution, environment FROM known_fixes WHERE solution LIKE 'Replaced the patch cable%'")).rows;
    assert.equal(kf.length, 1);
    assert.equal(kf[0]!.environment.site, "Midtown Manhattan");
    assert.ok(kf[0]!.environment.network?.gateway, "the cabinet's network was saved with the fix");
    // It is shown with the problem straight away, and wherever the same problem is seen again.
    await page.getByText("Possible fix", { exact: true }).first().waitFor();
    await page.getByText("Replaced the patch cable to the switch; the errors stopped.").first().waitFor();
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/known-fix.png`, fullPage: true });

    // The cash drawer, on a cabinet whose firewall is on: the check finds it, the client's policy turns it off.
    await next();
    await page.getByRole("heading", { name: "Cash drawer check" }).waitFor();
    await marked('[data-tour="drawer-check"]');
    await page.getByRole("button", { name: "Check drawer" }).click();
    await page.getByRole("row", { name: /^Firewall/ }).getByText(/^On for/).waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Apply the client's firewall policy" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Make the change" }).click();
    await page.getByRole("row", { name: /^Firewall/ }).getByText("Off on every profile").waitFor({ timeout: 90_000 });

    // Step 7: the scanner, three drops and the driver installed before the first.
    await next();
    await page.getByRole("heading", { name: /Drops/ }).waitFor({ timeout: 30_000 });
    await marked('[data-tour="scanner-drops"]');
    await page.getByText("3 in the last 24 hours").waitFor();
    await page.getByText(/was installed about 2 hours before the first drop/).waitFor();
    assert.equal(await page.getByText(/caused by/i).count(), 0);
    // USB ports: the scanner is not connected now, the port it was last on is named, and the port with a failed device is flagged.
    await page.getByRole("heading", { name: "USB ports" }).waitFor();
    await page.getByRole("table", { name: "USB ports" }).waitFor({ timeout: 30_000 });
    await page.getByText(/last on hub 3, port 2/).first().waitFor();
    await page.getByRole("row", { name: /Unknown USB Device.*Problem/ }).waitFor();
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/usb-ports.png`, fullPage: true });

    // Services: the disabled service is set to manual, and the page reads it back.
    await next();
    await page.getByRole("heading", { name: "Service start type" }).waitFor();
    await marked('[data-tour="start-type"]');
    await page.locator('[data-tour="start-type"]').first().click();
    await page.getByLabel("Start type", { exact: true }).selectOption("manual");
    await page.getByRole("button", { name: "Review" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Make the change" }).click();
    await page.getByText(/Service BioUpdateSvc: start type changed from Disabled to Manual\./).waitFor({ timeout: 60_000 });

    // Steps 8 to 10: errors with no name, on two cabinets; look at the log; map the error to the scanner issue.
    await next();
    await page.getByRole("heading", { name: "Unrecognized alerts" }).waitFor();
    await marked('[data-cabinet="Reception"]');
    await page.getByText("Reception").first().waitFor({ timeout: 30_000 });
    await page.getByText("Waiting Room").first().waitFor();
    await next();
    await page.getByRole("heading", { name: "Event log inspection" }).waitFor();
    await page.getByText(/Microsoft-Windows-Biometrics/).first().waitFor({ timeout: 30_000 });
    await page.locator('[data-tour="event-entry"]', { hasText: "Biometrics" }).first().click();
    await page.locator("#entry-heading").waitFor({ timeout: 60_000 });
    await next();
    await page.getByRole("heading", { name: "Event-to-issue mapping" }).waitFor();
    await marked('[data-tour="map-to-issue"]');
    await page.getByRole("button", { name: "Map to issue" }).first().click();
    await page.getByRole("dialog").locator("select[required]").selectOption({ label: "Fingerprint scanner problem (major)" });
    clock += 30_000;
    await page.getByRole("dialog").getByLabel("Authenticator code").fill(totp.code(secret, totp.stepAt(clock)));
    await page.getByRole("dialog").getByRole("button", { name: "Save and go live" }).click();
    await page.getByText(/The rule is live\. From now on this error raises/).waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    assert.equal((await db.app.query("SELECT 1 FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id WHERE k.name IN ('Reception', 'Waiting Room') AND a.issue_type_id = '00000000-0000-4000-8000-000000000101'")).rowCount, 2, "both cabinets' alerts are grouped under the scanner issue");

    // Step 11: a teammate's fix is waiting. Nobody else sees it until it is approved.
    const priya = "Reader drops after a driver install";
    assert.equal((await db.app.query("SELECT 1 FROM known_fixes WHERE title = $1 AND status = 'pending'", [priya])).rowCount, 1);
    await next();
    await page.getByRole("heading", { name: "Fix approval" }).waitFor();
    await marked('[data-tour="fix-approve"]');
    await page.getByRole("heading", { name: /Waiting for approval \(1\)/ }).waitFor();
    await page.getByText(priya).first().waitFor();
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/fix-queue.png`, fullPage: true });
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await page.getByText(/Approved “Reader drops after a driver install”/).waitFor();
    assert.equal((await db.app.query("SELECT 1 FROM known_fixes WHERE title = $1 AND status = 'approved'", [priya])).rowCount, 1);

    // Step 12: it now sits beside the scanner alert on Reception.
    await next();
    await page.getByRole("heading", { name: "Learned fixes on the alert" }).waitFor();
    await marked('.known-fixes');
    await page.getByText("Possible fix", { exact: true }).first().waitFor({ timeout: 30_000 });
    await page.getByText(/Rolled the reader's driver back/).first().waitFor();
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/alert-fix.png`, fullPage: true });

    // The last steps, onboarding: installing the real agent, approving it, then testing it.
    // The alert list carries a "possible fix" mark for the issue, whichever cabinet or site the alert is on.
    await page.goto(`${origin}/alerts`);
    await page.getByText(/\d possible fix/).first().waitFor({ timeout: 30_000 });
    await page.goBack();
    // The ending is onboarding a real agent. The computer asks to join while the presenter is on the install step.
    await next();
    await page.getByRole("heading", { name: "Install the agent on a computer" }).waitFor();
    await marked('[data-tour="create-token"]');
    await page.getByRole("button", { name: "Create install token" }).click();
    clock += 30_000;
    await page.getByRole("dialog").getByLabel("Authenticator code").fill(totp.code(secret, totp.stepAt(clock)));
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByRole("link", { name: "Download token.txt" }).waitFor();
    const { token } = await createBootstrapToken(db.app, adminId);
    await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: {
      hostname: "SUPPORT-LAPTOP", serialNumber: "5CG0REAL001", macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: new Date().toISOString(),
      osVersion: "Windows 11 Pro", agentVersion: "0.2.0" } }, "127.0.0.1");
    await next();
    await page.getByRole("heading", { name: "Pending cabinets" }).waitFor();
    await marked('[data-tour="approve-cabinet"]');
    await page.getByLabel("Client", { exact: true }).fill("Mashura Office");
    await page.getByLabel("Site", { exact: true }).fill("Support desk");
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    clock += 30_000;
    await page.getByRole("dialog").getByLabel("Authenticator code").fill(totp.code(secret, totp.stepAt(clock)));
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByText(/Approved\. SUPPORT-LAPTOP will come online within a minute/).waitFor();
    assert.equal((await db.app.query("SELECT 1 FROM cabinets WHERE hostname = 'SUPPORT-LAPTOP' AND status = 'active' AND demo_scenario IS NULL")).rowCount, 1, "a real cabinet, not a simulated one");
    // The tour notices the new cabinet and offers its steps: the live test, then its network, which is the end.
    await next();
    await page.getByRole("heading", { name: "Live verification" }).waitFor();
    await page.getByRole("heading", { name: "Test SUPPORT-LAPTOP" }).waitFor({ timeout: 30_000 });
    await marked('[data-tour="live-run"]');
    await next();
    await page.getByRole("heading", { name: "Network reading from a live cabinet" }).waitFor();
    await marked('[data-tour="diagnose"]');
    await page.getByRole("heading", { name: "SUPPORT-LAPTOP", level: 1 }).waitFor();
    await page.getByRole("button", { name: "Diagnose network", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Next" }).count(), 0, "the onboarding is the last step");
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/tour-end.png` });
    await page.getByRole("button", { name: "Finish" }).click();
    assert.equal(await page.locator("aside.demo-tour").count(), 0, "the tour is over");

    // A site with no baseline: the read is shown, and it says nothing is compared.
    await db.app.query("UPDATE sites SET network_baseline = NULL WHERE name = 'Phoenix Clinic'");
    const phoenix = (await db.app.query<{ id: string }>("SELECT id FROM sites WHERE name = 'Phoenix Clinic'")).rows[0]!.id;
    await page.goto(`${origin}/sites/${phoenix}?diagnose=network`);
    await page.getByText(/No site baseline set; nothing is compared/).waitFor({ timeout: 60_000 });
    await page.getByText("No DHCP lease (address 169.254.x.x)").waitFor({ timeout: 60_000 });
    assert.equal(await page.getByText("No default gateway").count(), 0, "what follows from having no address is not listed as separate problems");

    // Onboarding: the same site can adopt a cabinet's network as its baseline (one click: it changes no cabinet), and then it is compared.
    await page.goto(`${origin}/sites/${phoenix}`);
    await page.getByRole("heading", { name: "Standards for Phoenix Clinic" }).waitFor();
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/standards.png`, fullPage: true });
    await page.getByRole("button", { name: /^Use .*'s network$/ }).click();
    assert.equal(await page.getByRole("dialog").getByLabel("Authenticator code").count(), 0, "a baseline needs no authenticator code");
    await page.getByRole("dialog").getByRole("button", { name: "Make the change" }).click();
    await page.getByRole("heading", { name: "Standards for Phoenix Clinic" }).waitFor();
    await page.getByRole("button", { name: /^Use .*'s network$/ }).waitFor({ state: "detached", timeout: 15_000 });
    const saved = (await db.app.query<{ network_baseline: { gateway: string } | null }>("SELECT network_baseline FROM sites WHERE id = $1", [phoenix])).rows[0]!.network_baseline;
    assert.ok(saved?.gateway, "the baseline was saved from the cabinet's own network");

    // Test a cabinet: the read-only checks run one after another and every one passes against the simulated answers.
    const exam = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE name = 'Exam Room 2'")).rows[0]!.id;
    await page.goto(`${origin}/cabinets/${exam}`);
    await page.getByRole("button", { name: "Run the checks" }).click();
    await page.getByText("14 of 14 passed").waitFor({ timeout: 90_000 });
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/live-check.png`, fullPage: true });

    // The adapter read carries what ipconfig /all, the network profile, the driver and the proxy would show, and can be copied as text.
    await page.goto(`${origin}/cabinets/${exam}/network`);
    await page.locator("dt:visible", { hasText: "Network profile" }).first().waitFor({ timeout: 60_000 });
    await page.locator("dt:visible", { hasText: "Interface metric" }).first().waitFor();
    await page.getByText(/WinHTTP proxy:/).waitFor();
    await page.getByRole("button", { name: "Copy as ipconfig text" }).waitFor();
    await page.getByRole("button", { name: "Flush DNS cache" }).waitFor();

    // Case notes: what this person did on the cabinet becomes text for the ticket, with changes and checks and no raw logs.
    await page.goto(`${origin}/cabinets/${exam}`);
    await page.getByRole("button", { name: "Build notes" }).first().click();
    const notes = page.getByRole("textbox", { name: "Case notes" }).first();
    await notes.waitFor({ timeout: 30_000 });
    const noteText = await notes.inputValue();
    assert.match(noteText, /Case notes by Ada Admin/);
    assert.match(noteText, /Checked: .*Event logs/, "the checks run earlier are listed once each");
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/casenotes.png`, fullPage: true });

    // What changed: the timeline with the first problem and what changed before it.
    await page.goto(`${origin}/cabinets/${exam}/changes`);
    await page.getByRole("heading", { name: "What changed" }).waitFor();
    await page.locator("#changes-days").selectOption("30");
    await page.locator("table, p:has-text('Nothing recorded')").first().waitFor({ timeout: 30_000 });
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/changes.png`, fullPage: true });

    // Compare with a sibling: both are read and the differences are listed (or none).
    await page.goto(`${origin}/cabinets/${exam}/compare`);
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await page.getByText(/No differences|Differences between/).or(page.locator("table caption")).first().waitFor({ timeout: 90_000 });
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/compare.png`, fullPage: true });

    // Watch a link: samples arrive and a summary is given; stop ends it.
    await page.goto(`${origin}/cabinets/${exam}/network`);
    await page.getByRole("button", { name: /^Watch .* for 5 minutes$/ }).click();
    await page.getByText(/Every sample answered|Intermittent|Heavy loss|Nothing answered/).first().waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Stop watching" }).click();
    await page.getByRole("button", { name: "Copy summary" }).waitFor({ timeout: 60_000 });
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/watch.png`, fullPage: true });

    // An alert opens the workbench at the right symptom, and saved fixes can be searched.
    await page.goto(`${origin}/cabinets/${exam}/troubleshoot?symptom=disk`);
    assert.equal(await page.getByLabel("Symptom").inputValue(), "disk");
    await page.goto(`${origin}/fixes`);
    await page.getByLabel("Search").fill("zzz-no-such-fix");
    await page.getByText("No fix matches.").waitFor();

    // Firewall: "why can't anything reach port 1433" is answered from what is listening, the rules and the active profile.
    await page.goto(`${origin}/cabinets/${exam}/firewall`);
    await page.locator("#portcheck-port").waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await page.getByRole("table", { name: "Port 1433" }).waitFor({ timeout: 60_000 });
    await page.getByText(/Reachable|Partly blocked|Not reachable/).first().waitFor();
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/portcheck.png`, fullPage: true });

    // Packets and path: every target is traced and pinged 20 times; the table gives loss, round trips and the hop where the path degrades.
    // A different cabinet from the one the live check just used, so the per-cabinet limit on network tests is not in the way.
    const other = (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE id <> $1 AND demo_scenario = 'healthy' ORDER BY name LIMIT 1", [exam])).rows[0]!.id;
    await page.goto(`${origin}/cabinets/${other}/network`);
    await page.getByRole("button", { name: "Trace and ping" }).click();
    await page.getByRole("table", { name: /^gateway/ }).waitFor({ timeout: 60_000 }).catch(async e => {
      throw new Error(`${e.message}\n${await page.locator("#packets-heading").locator("xpath=ancestor::section").innerText()}`);
    });
    assert.ok(await page.getByRole("cell", { name: "Clean" }).count() >= 1, "at least one healthy path is marked clean");
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/packets.png`, fullPage: true });

    // Cash drawer: the drawer link is found among the adapters (unidentified network, fixed address), its settings and packet counters are
    // checked over two readings, and the firewall state is reported.
    const withDrawer = (await db.app.query<{ id: string }>(
      `SELECT k.id FROM cabinets k WHERE k.demo_scenario = 'healthy' AND (SELECT count(*) FROM cabinets o WHERE o.site_id = k.site_id AND o.name < k.name) % 3 = 0 ORDER BY k.name LIMIT 1`)).rows[0]!.id;
    await page.goto(`${origin}/cabinets/${withDrawer}/network`);
    await page.getByRole("button", { name: "Check drawer" }).click();
    await page.getByRole("table", { name: "Drawer check" }).waitFor({ timeout: 60_000 });
    await page.getByRole("row", { name: /^IPv4/ }).getByText(/inside 172\.20\.1\.0\/24/).waitFor();
    await page.getByRole("row", { name: /^Packets/ }).getByText(/bytes in/).waitFor();
    await page.getByRole("row", { name: /^Firewall/ }).waitFor();
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/drawer.png`, fullPage: true });

    // Troubleshoot: pick a symptom, the fixed checks for it run and explain themselves, and the case notes carry the findings.
    await page.goto(`${origin}/cabinets/${exam}/troubleshoot`);
    await page.getByLabel("Symptom").selectOption({ label: "The computer is slow, or the application freezes" });
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByRole("button", { name: "Run again" }).waitFor({ timeout: 60_000 });
    await page.getByText(/memory .* GB free of/).waitFor();
    await page.locator("summary", { hasText: "Case notes" }).click();
    await page.getByLabel("Actions taken").fill("Closed the extra programs");
    await page.getByRole("button", { name: "Copy case notes" }).click();
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/troubleshoot.png`, fullPage: true });

    if (process.env.SHOTS) for (const [name, path] of [["guide", "/demo"], ["users", "/admin/users"], ["admin", "/admin"], ["setup", "/admin/setup"]] as const) {
      await page.goto(`${origin}${path}`);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true });
    }
    simulator.stop();
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
