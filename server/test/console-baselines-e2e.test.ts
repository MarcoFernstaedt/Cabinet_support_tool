// Baselines and drift in a real browser: a cabinet that differs from its baseline shows its configuration health, the difference, what changed and
// when, and the comparison with its baseline; a baseline is captured, edited and proposed from the page; the Baselines pages list and open versions;
// the fleet view groups the difference. Nothing here changes a cabinet. Runs when the console is built.
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
import { configHash, type Item } from "../src/services/config-canonical.js";
import { ingestAndEvaluate } from "../src/services/config-service.js";
import { createTestDatabase, startFeed } from "./database.js";
import { tempDir } from "./helpers.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";
const freePort = (): Promise<number> => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

test("a cabinet that differs from its baseline: health, the difference, the changes, the capture and review of a baseline, the baselines pages and the fleet view", { skip, timeout: 240_000 }, async () => {
  const { chromium } = await import("playwright");
  const db = await createTestDatabase();
  let clock = Date.now();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const secrets = new SecretBox(randomBytes(32).toString("base64"));
  const stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  const app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin, stream, staticDir: dist, logger: false, now: () => clock });
  await app.listen({ host: "127.0.0.1", port });

  const password = "correct horse battery staple";
  const adaSecret = totp.newSecret();
  const adaId = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, 'ada.admin', 'Ada Admin', 'admin', $2, 0, 1, $3, 1)`, [adaId, await hashPassword(password), secrets.seal(adaSecret)]);
  const clientId = randomUUID(), siteId = randomUUID(), cabinetId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Acme Health')", [clientId]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'North')", [siteId, clientId]);
  await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, read_only, last_heartbeat_at) VALUES ($1, $2, 'Front desk', 'standalone', 'active', 0, SYSUTCDATETIME())`, [cabinetId, siteId]);
  const baselineId = randomUUID(), versionId = randomUUID();
  await db.app.query("INSERT INTO baselines (id, scope_kind, scope_id, name, created_by) VALUES ($1, 'site', $2, 'North', $3)", [baselineId, siteId, adaId]);
  await db.app.query(`INSERT INTO baseline_versions (id, baseline_id, [version], status, content, description, created_by, decided_by, decided_at, decision_note)
                      VALUES ($1, $2, 1, 'approved', $3, 'DNS and the scanner service', $4, $4, SYSUTCDATETIME(), 'Reviewed')`,
    [versionId, baselineId, JSON.stringify({ items: [{ category: "network", key: "adapter:Ethernet", mode: "match", expect: { dnsServers: ["10.21.4.10", "10.21.4.11"] }, required: true, severity: "major" }] }), adaId]);
  const eth = (dns: string[]): Item => ({ key: "adapter:Ethernet", values: { dhcp: true, addresses: ["10.21.4.25/24"], gateways: ["10.21.4.1"], dnsServers: dns, dnsAutomatic: false, interfaceIndex: 12 } });
  const snap = (items: Item[], minutes: number) => ({ category: "network", hash: configHash(items), truncated: false, items, observedAt: new Date(Date.now() - 3_600_000 + minutes * 60_000).toISOString() });
  await ingestAndEvaluate(db.app, cabinetId, [snap([eth(["10.21.4.10", "10.21.4.11"])], 0)] as never, "agent");
  await ingestAndEvaluate(db.app, cabinetId, [snap([eth(["8.8.8.8"])], 10)] as never, "agent");

  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  try {
    const page = await (await browser.newContext()).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409|429)/.test(m.text())) problems.push(m.text()); });
    await page.goto(origin);
    await page.getByLabel("Username").fill("ada.admin");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    clock += 30_000;
    await page.getByLabel(/6-digit code/).fill(totp.code(adaSecret, totp.stepAt(clock)));
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();
    const oneHeading = async (where: string) => assert.equal(await page.locator("h1").count(), 1, `${where}: one main heading`);

    // The cabinet's Overview shows its configuration health: not as the baseline says, since when, and where to look next.
    await page.goto(`${origin}/cabinets/${cabinetId}`);
    await page.getByRole("heading", { name: /Configuration/ }).waitFor();
    await page.getByText("Not as the baseline says").first().waitFor();
    await page.getByText(/Last known healthy configuration/).waitFor();
    assert.equal(await page.getByText(/caused by/i).count(), 0);
    await oneHeading("cabinet");

    // The Baseline tab: the difference, what it should be and what it is, then the other views.
    await page.goto(`${origin}/cabinets/${cabinetId}/baseline`);
    await page.getByRole("heading", { name: "Baseline and drift" }).waitFor();
    await page.getByRole("row", { name: /dnsServers/ }).getByText("8.8.8.8").waitFor();
    await page.getByRole("row", { name: /dnsServers/ }).getByText("10.21.4.10, 10.21.4.11").waitFor();
    await page.getByRole("button", { name: "Since last healthy" }).click();
    await page.getByText(/last recorded healthy/).waitFor();
    await page.getByRole("button", { name: "History" }).click();
    await page.getByText(/dnsServers/).first().waitFor();
    await page.getByRole("button", { name: "Baseline in force" }).click();
    await page.getByRole("link", { name: "North" }).first().waitFor();
    await oneHeading("baseline tab");

    // The Compare tab can compare with the baseline, with nothing asked of the cabinet.
    await page.goto(`${origin}/cabinets/${cabinetId}/compare`);
    await page.getByLabel("Compare with").selectOption("baseline");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await page.getByRole("cell", { name: "8.8.8.8" }).waitFor();

    // What changed lists the configuration changes next to the other changes.
    await page.goto(`${origin}/cabinets/${cabinetId}/changes`);
    await page.getByText(/dnsServers/).first().waitFor();
    await oneHeading("changes");

    // Capture a baseline from this cabinet, trim it, and propose it. Nothing is approved by doing so.
    await page.goto(`${origin}/cabinets/${cabinetId}/baseline`);
    await page.getByLabel("What this version is for").fill("Captured in the test");
    await page.getByRole("button", { name: "Capture as a draft" }).click();
    await page.getByRole("heading", { name: /Version \d/ }).waitFor();
    await page.getByText("Draft", { exact: true }).first().waitFor();
    const remove = page.getByRole("button", { name: /^Remove / });
    const before = await remove.count();
    assert.ok(before > 0, "the captured draft has items");
    await remove.first().click();
    assert.equal(await remove.count(), before - 1);
    await page.getByRole("button", { name: "Save the draft" }).click();
    await page.getByText("Saved.").waitFor();
    await page.getByRole("button", { name: "Propose this version" }).click();
    await page.getByText(/Waiting for an Admin/).first().waitFor();
    await page.getByRole("button", { name: "Approve…" }).waitFor();
    await oneHeading("version review");

    // The Baselines pages.
    await page.goto(`${origin}/admin/baselines`);
    await page.getByRole("heading", { name: "Baselines", level: 1 }).waitFor();
    await page.getByRole("link", { name: "North" }).first().click();
    await page.getByRole("link", { name: "Version 1" }).click();
    await page.getByRole("heading", { name: /Version 1/ }).waitFor();
    await page.getByText("In force").first().waitFor();
    await oneHeading("version");

    // The fleet view groups the same difference and counts the cabinets that have it and those that do not.
    await page.goto(`${origin}/fleet-differences`);
    await page.getByRole("link", { name: /dnsServers/ }).click();
    await page.getByText(/not a finding about the cause|common cause/).first().waitFor();
    await page.getByRole("link", { name: "Front desk" }).waitFor();
    await oneHeading("group");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await app.close();
    await stream.stop();
    await db.drop();
  }
});
