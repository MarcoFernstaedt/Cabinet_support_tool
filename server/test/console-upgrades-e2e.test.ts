// Milestone 7 in a real browser: an Admin adds a signed release from the pipeline's three files, marks a cabinet as
// in the office, starts a staged rollout with step-up, sees it pause on its own when a cabinet's upgrade fails, reads
// the per-cabinet result with the exact failed check, and stops it. Runs when the console is built.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { ReleaseKeys } from "../src/services/releases.js";
import { offerFor, recordUpgradeStatus } from "../src/services/rollouts.js";
import { createTestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";
import { keysFolder, makeRelease, releaseKey } from "./release-kit.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";
const freePort = (): Promise<number> => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

test("upgrades in the console: add a signed release, start a staged rollout, see it pause on a failure with the exact check, stop it", { skip, timeout: 180_000 }, async () => {
  const { chromium } = await import("playwright");
  const db = await createTestDatabase();
  const dir = tempDir();
  const key = releaseKey();
  let clock = Date.now();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const secrets = new SecretBox(randomBytes(32).toString("base64"));
  const feed = new NotificationFeed(db.app, 50);
  await feed.start();
  const stream = new ResultStream(feed, db.app);
  await stream.start();
  const releases = { dir: tempDir(), maxBytes: 1024 * 1024, keys: ReleaseKeys.fromFolder(keysFolder([key])) };
  const app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(dir), origin, stream, releases, staticDir: dist, logger: false, now: () => clock });
  await app.listen({ host: "127.0.0.1", port });

  const password = "correct horse battery staple";
  const secret = totp.newSecret();
  const adaId = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, 'ada.admin', 'Ada Admin', 'admin', $2, 0, 1, $3, 1)`, [adaId, await hashPassword(password), secrets.seal(secret)]);
  const code = (): string => { clock += 30_000; return totp.code(secret, totp.stepAt(clock)); };
  const client = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Acme Health')", [client]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'North')", [site, client]);
  const cab: Record<string, string> = {};
  for (const name of ["Pilot cabinet", "Front desk", "Lab cabinet"]) {
    cab[name] = randomUUID();
    await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, agent_version, last_heartbeat_at) VALUES ($1, $2, $3, 'standalone', 'active', '0.1.0', SYSUTCDATETIME())`, [cab[name], site, name]);
  }
  // The pipeline's three files.
  const release = makeRelease(key, "0.2.0");
  writeFileSync(join(dir, "manifest.json"), release.manifestBytes);
  writeFileSync(join(dir, "signature.json"), JSON.stringify(release.signature));
  writeFileSync(join(dir, "agent-0.2.0.zip"), release.zip);

  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  try {
    const page = await (await browser.newContext()).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409)/.test(m.text())) problems.push(m.text()); });
    await page.goto(origin);
    await page.getByLabel("Username").fill("ada.admin");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByLabel(/6-digit code/).fill(code());
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();
    const confirm = async (expect: RegExp) => {
      const dialog = page.getByRole("dialog", { name: "Confirm with your authenticator" });
      await dialog.getByText(expect).first().waitFor();
      await dialog.getByLabel("Authenticator code").fill(code());
      await dialog.getByRole("button", { name: "Confirm" }).click();
    };
    const shot = async (name: string) => { if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}.png`), fullPage: true }); };

    await page.goto(origin + "/admin");
    await page.getByRole("link", { name: /Agent upgrades/ }).click();
    await page.getByRole("heading", { name: "Agent upgrades", level: 1 }).waitFor();

    // Add the release.
    await page.getByLabel("Manifest (manifest.json)").setInputFiles(join(dir, "manifest.json"));
    await page.getByLabel("Signature (signature.json)").setInputFiles(join(dir, "signature.json"));
    await page.getByLabel("Package (.zip)").setInputFiles(join(dir, "agent-0.2.0.zip"));
    await page.getByRole("button", { name: "Add release" }).click();
    await confirm(/Add agent release 0\.2\.0/);
    // A release is one version for one Windows, and the console says which one it took from the picker.
    await page.getByText("Release 0.2.0 for 64-bit Windows is ready").waitFor();

    // Front desk joins the in-office cabinets (batch 2).
    await page.getByLabel("Find a cabinet").fill("front");
    await page.getByRole("listitem").filter({ hasText: "Front desk" }).getByRole("button", { name: "Add to office" }).click();
    await confirm(/Add Front desk/);
    await page.getByText("Front desk is now an in-office cabinet.").waitFor();

    // Start the rollout with the pilot cabinet as batch 1.
    await page.getByLabel("First cabinet (batch 1)").selectOption({ label: "Pilot cabinet · Acme Health / North · 0.1.0" });
    await page.getByRole("button", { name: "Start rollout" }).click();
    await confirm(/Roll out agent 0\.2\.0 for 64-bit Windows, first to Pilot cabinet/);
    await page.getByText("Rollout of 0.2.0 for 64-bit Windows started with Pilot cabinet.").waitFor();
    await shot("m7-1-upgrades");

    // The pilot upgrades; Front desk's upgrade is refused at the hash check: the rollout pauses on its own.
    await offerFor(db.app, cab["Pilot cabinet"]!, "0.1.0");
    await recordUpgradeStatus(db.app, cab["Pilot cabinet"]!, { version: "0.2.0", fromVersion: "0.1.0", outcome: "succeeded", message: "0.2.0 is running and checked in." });
    await offerFor(db.app, cab["Front desk"]!, "0.1.0");
    await recordUpgradeStatus(db.app, cab["Front desk"]!, { version: "0.2.0", fromVersion: "0.1.0", outcome: "refused", check: "package_hash",
      message: "The package's SHA-256 hash does not match the signed manifest." });
    await page.reload();
    await page.getByText(/Paused automatically: 1 of 1 cabinet in batch 2/).waitFor();
    await page.getByRole("link", { name: "0.2.0" }).click();
    await page.getByRole("heading", { name: "Rollout of agent 0.2.0", level: 1 }).waitFor();
    const row = page.getByRole("row").filter({ hasText: "Front desk" });
    await row.getByText(/refused at the package hash check/).waitFor();
    assert.match(await page.getByRole("row").filter({ hasText: "Pilot cabinet" }).innerText(), /Upgraded/);
    await shot("m7-2-rollout");

    // Stop it.
    await page.getByRole("link", { name: "Upgrades" }).click();
    await page.getByRole("button", { name: "Stop" }).click();
    await confirm(/Stop the rollout of agent 0\.2\.0/);
    await page.getByText("Rollout of 0.2.0 stopped.").waitFor();
    assert.equal((await db.app.query<{ state: string }>("SELECT state FROM rollouts")).rows[0]!.state, "stopped");
    const actions = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'release.%' OR action LIKE 'rollout.%' OR action = 'cabinet.in_office' ORDER BY seq")).rows.map(r => r.action);
    assert.deepEqual(actions, ["release.add", "release.package", "cabinet.in_office", "rollout.start", "rollout.batch", "rollout.auto_pause", "rollout.stop"]);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await stream.stop();
    feed.stop();
    await app.close();
    await db.drop();
  }
});
