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
import { createTestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

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
    await page.getByText("Monday morning at Midtown Manhattan", { exact: true }).waitFor();
    assert.equal(await page.locator("#main li.finding").count(), 2, "two demos: the network one and mapping errors");
    await page.getByText("Errors nobody has named yet", { exact: true }).waitFor();
    await page.locator("#main").getByRole("button", { name: "Start the guided demo" }).click();

    // Step 1 takes you to the site; step 2 is one cabinet, Exam Room 1, checked on its own.
    await page.getByRole("heading", { name: "Midtown Manhattan", level: 1 }).waitFor();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("heading", { name: "Exam Room 1", level: 1 }).waitFor();
    await page.getByRole("button", { name: "Diagnose network", exact: true }).click();
    await page.getByText(/The firewall on Midtown Sync is blocking port/).first().waitFor({ timeout: 60_000 });
    // Step 3 is the whole site at once.
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByText("Firewall blocks the sync cabinet's ports").first().waitFor({ timeout: 60_000 });
    // Step 4 says what was found; step 5 is the fix, and it works: confirm, and the site is checked again and is clean.
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("heading", { name: "What the check found" }).waitFor();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("heading", { name: "Fix it" }).waitFor();
    await page.getByRole("button", { name: /Apply the policy on Midtown Sync/ }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Make the change" }).click();
    await page.getByText(/Done: Apply the policy on Midtown Sync/).waitFor({ timeout: 60_000 });
    await page.getByText("6 of 7 cabinets are clean.").waitFor({ timeout: 60_000 });
    // The one left matches its baseline, and the full read still shows why it is slow: lost packets and card errors.
    await page.getByRole("row", { name: /Operating Room/ }).getByRole("button", { name: "Full read" }).click();
    await page.getByText(/Packet loss to the gateway/).first().waitFor();
    await page.getByText("Everything that was read").click();
    await page.getByRole("heading", { name: "Routes" }).waitFor();
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/batch-fullread.png`, fullPage: true });
    const policy = (await db.app.query<{ firewall_profiles: Record<string, boolean> }>("SELECT firewall_profiles FROM cabinets WHERE name = 'Midtown Sync'")).rows[0]!.firewall_profiles;
    assert.deepEqual(Object.values(policy), [false, false, false], "the cabinet really changed");

    // Step 6: Operating Room matches its baseline but loses packets. The fix is saved, with its setup, for next time.
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("heading", { name: "Operating Room", level: 1 }).waitFor();
    await page.getByText(/Packet loss to the gateway/).first().waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Save what fixed this…" }).first().click();
    await page.getByLabel("What fixed it").fill("Replaced the patch cable to the switch; the errors stopped.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText(/Saved\. This is shown the next time/).waitFor();
    const kf = (await db.app.query<{ solution: string; environment: { site: string; network: { gateway: string } | null } }>("SELECT solution, environment FROM known_fixes")).rows;
    assert.equal(kf.length, 1);
    assert.equal(kf[0]!.environment.site, "Midtown Manhattan");
    assert.ok(kf[0]!.environment.network?.gateway, "the cabinet's network was saved with the fix");
    // It is shown with the problem straight away, and wherever the same problem is seen again.
    await page.getByText("Seen before").first().waitFor();
    await page.getByText("Replaced the patch cable to the switch; the errors stopped.").first().waitFor();
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/known-fix.png`, fullPage: true });

    // Step 7: the scanner, three drops and the driver installed before the first.
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("heading", { name: /Drops/ }).waitFor({ timeout: 30_000 });
    await page.getByText("3 in the last 24 hours").waitFor();
    await page.getByText(/was installed about 2 hours before the first drop/).waitFor();
    assert.equal(await page.getByText(/caused by/i).count(), 0);

    // Steps 5 and 6: installing the real agent, then approving it.
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("heading", { name: "Install the agent on a computer" }).waitFor();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("heading", { name: "Pending cabinets" }).waitFor();
    await page.getByRole("button", { name: "Stop the guided demo" }).click();

    // A site with no baseline: the read is shown, and it says nothing is compared.
    await db.app.query("UPDATE sites SET network_baseline = NULL WHERE name = 'Phoenix Clinic'");
    const phoenix = (await db.app.query<{ id: string }>("SELECT id FROM sites WHERE name = 'Phoenix Clinic'")).rows[0]!.id;
    await page.goto(`${origin}/sites/${phoenix}?diagnose=network`);
    await page.getByText(/This site has no baseline set, so nothing is compared/).waitFor({ timeout: 60_000 });
    await page.getByText("No DHCP lease (address 169.254.x.x)").waitFor({ timeout: 60_000 });
    assert.equal(await page.getByText("No default gateway").count(), 0, "what follows from having no address is not listed as separate problems");

    // Onboarding: the same site can adopt a cabinet's network as its baseline, with the authenticator code, and then it is compared.
    await page.goto(`${origin}/sites/${phoenix}`);
    await page.getByRole("heading", { name: "Standards for Phoenix Clinic" }).waitFor();
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/standards.png`, fullPage: true });
    await page.getByRole("button", { name: /^Use .*'s network$/ }).click();
    clock += 30_000;
    await page.getByRole("dialog").getByLabel("Authenticator code").fill(totp.code(secret, totp.stepAt(clock)));
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByRole("heading", { name: "Standards for Phoenix Clinic" }).waitFor();
    await page.getByRole("button", { name: /^Use .*'s network$/ }).waitFor({ state: "detached", timeout: 15_000 });
    const saved = (await db.app.query<{ network_baseline: { gateway: string } | null }>("SELECT network_baseline FROM sites WHERE id = $1", [phoenix])).rows[0]!.network_baseline;
    assert.ok(saved?.gateway, "the baseline was saved from the cabinet's own network");

    // The second demo: errors nobody has named. Unrecognized alerts from the fingerprint reader's driver, on two cabinets, then the event log.
    await page.goto(`${origin}/demo`);
    await page.getByRole("button", { name: "Start this demo" }).nth(1).click();
    await page.getByRole("heading", { name: "Errors with no name" }).waitFor();
    await page.getByText("Check-in Desk").first().waitFor({ timeout: 30_000 });
    await page.getByText("Waiting Room").first().waitFor();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("heading", { name: "Look at the error itself" }).waitFor();
    await page.getByText(/Microsoft-Windows-Biometrics/).first().waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Stop the guided demo" }).click();
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
