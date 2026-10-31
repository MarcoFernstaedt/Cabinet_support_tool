// Approved programs in a real browser: an Admin adds an application and a service to a client's list, confirms with an authenticator
// code, and the server stores exactly those programs; the fleet default can approve nothing; a cabinet's damaged own list can be
// removed; a bad path is refused on the page before anything is sent. With a list-signing key set up, a saved list waits until the
// Admin downloads it, signs it on their own computer and uploads the signature. Runs when the console is built.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { appLevels, readLevel, readLevelState } from "../src/services/approved-apps.js";
import { ListSigningKeys } from "../src/services/approved-list-signing.js";
import { createTestDatabase, startFeed } from "./database.js";
import { tempDir } from "./helpers.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";
const freePort = (): Promise<number> => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

test("an Admin sets a client's approved programs from the console, confirmed with a code", { skip, timeout: 180_000 }, async () => {
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
  const secret = totp.newSecret();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, 'ada.admin', 'Ada Admin', 'admin', $2, 0, 1, $3, 1)`, [randomUUID(), await hashPassword(password), secrets.seal(secret)]);
  const clientId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Acme Health')", [clientId]);
  // A replacement cabinet whose own list (taken over from the cabinet it replaced) was later edited by hand and no longer describes
  // its own entries: it approves nothing, and the site, client and fleet lists do not apply to it while it is there.
  const [siteId, cabinetId] = [randomUUID(), randomUUID()];
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'North')", [siteId, clientId]);
  await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, read_only, approved_apps) VALUES ($1, $2, 'FRONT DESK', 'standalone', 'active', 0, $3)`,
    [cabinetId, siteId, JSON.stringify({ entries: [], version: 1, hash: "0".repeat(64), setBy: "hand", setAt: new Date().toISOString() })]);
  const code = () => { clock += 30_000; return totp.code(secret, totp.stepAt(clock)); };

  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  try {
    const page = await (await browser.newContext()).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409|429|500)/.test(m.text())) problems.push(m.text()); });
    await page.goto(origin);
    await page.getByLabel("Username").fill("ada.admin");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByLabel(/6-digit code/).fill(code());
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();

    await page.goto(`${origin}/admin`);
    await page.getByRole("link", { name: /Approved programs/ }).click();
    await page.getByRole("heading", { name: "Approved programs", level: 1 }).waitFor();
    await page.getByLabel("Set the list for").selectOption("client");
    await page.getByLabel("Client", { exact: true }).selectOption({ label: "Acme Health" });
    await page.getByText(/Nothing set here, so the level above applies/).waitFor();

    // A path that is not a full path to a program is refused before anything is sent.
    await page.getByLabel("Name", { exact: true }).fill("Kiosk");
    await page.getByLabel(/Full path to the program/).fill("kiosk.exe");
    await page.getByText(/must be the full path/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Add to the list" }).isDisabled(), true);

    await page.getByLabel(/Full path to the program/).fill("C:\\Program Files\\Vendor\\kiosk.exe");
    await page.getByRole("button", { name: "Add to the list" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Scanner service");
    await page.getByLabel("Kind", { exact: true }).selectOption("service");
    await page.getByLabel("Service key name").fill("BioScanSvc");
    await page.getByLabel(/Full path to the program/).fill("C:\\Program Files\\Vendor\\scansvc.exe");
    await page.getByRole("button", { name: "Add to the list" }).click();
    await page.getByRole("row", { name: /Kiosk/ }).waitFor();
    await page.getByRole("row", { name: /Scanner service/ }).getByText("BioScanSvc").waitFor();

    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("dialog").getByLabel("Authenticator code").fill(code());
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByText("Saved. Cabinets use it from their next heartbeat.").waitFor();
    const stored = await readLevel(db.app, "client", clientId);
    assert.deepEqual(stored?.entries.map(e => [e.key, e.kind, e.serviceName, `${e.root.replace(/\\$/, "")}\\${e.file}`]), [
      ["app:Kiosk", "application", null, "C:\\Program Files\\Vendor\\kiosk.exe"],
      ["app:Scanner service", "service", "BioScanSvc", "C:\\Program Files\\Vendor\\scansvc.exe"],
    ]);
    await page.getByText(/In force: version 1, saved/).waitFor();

    // The fleet default can be set to approve nothing.
    await page.getByLabel("Set the list for").selectOption("fleet");
    await page.getByRole("button", { name: "Approve nothing here" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("dialog").getByLabel("Authenticator code").fill(code());
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByText("Saved. Cabinets use it from their next heartbeat.").waitFor();
    assert.deepEqual((await readLevel(db.app, "fleet", null))?.entries, []);

    // A cabinet's own list has an editor too: the damaged one is shown as damaged and removed, so the client's list applies again.
    assert.deepEqual((await appLevels(db.app, cabinetId)).rejected, ["cabinet"]);
    await page.getByLabel("Set the list for").selectOption("cabinet");
    await page.getByLabel("Client", { exact: true }).selectOption({ label: "Acme Health" });
    // The cabinet choice depends on loading the site: when that fails, the page says so beside it and can try again.
    let failed = 0;
    await page.route(`**/api/fleet/sites/${siteId}`, route => failed++ === 0
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal" }) }) : route.continue());
    await page.getByLabel("Site", { exact: true }).selectOption({ label: "North" });
    await page.getByRole("alert").first().waitFor();
    assert.equal(await page.getByText(/Choose a client, a site and a cabinet/).count(), 0, "a failed load is not blamed on the Admin's choice");
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByLabel("Cabinet", { exact: true }).selectOption({ label: "FRONT DESK" });
    await page.unroute(`**/api/fleet/sites/${siteId}`);
    await page.getByRole("heading", { name: /This cabinet's own list/ }).waitFor();
    await page.getByRole("alert").getByText(/stored list is damaged and approves nothing/).waitFor();
    await page.getByRole("button", { name: "Use the level above" }).click();
    await page.getByRole("dialog").getByLabel("Authenticator code").fill(code());
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByText("Saved. Cabinets use it from their next heartbeat.").waitFor();
    const levels = await appLevels(db.app, cabinetId);
    assert.deepEqual([levels.source, levels.rejected, levels.effective?.entries.length], ["client", [], 2]);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await app.close();
    await stream.stop();
    await db.drop();
  }
});

test("with a list-signing key, an Admin downloads the saved list, signs it and uploads the signature to put it in force", { skip, timeout: 180_000 }, async () => {
  const { chromium } = await import("playwright");
  const db = await createTestDatabase();
  let clock = Date.now();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const secrets = new SecretBox(randomBytes(32).toString("base64"));
  const stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  // The Admin's key: its public half is what the agents (and so the server) hold; the private half stays in this test, as it would
  // stay on the Admin's own computer.
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  const keyId = createHash("sha256").update(der).digest("hex");
  const trust = mkdtempSync(join(tmpdir(), "list-trust-"));
  writeFileSync(join(trust, "approved-list-keys.json"), JSON.stringify({ version: 1, keys: [{ keyId, name: "Test", publicKey: der.toString("base64") }] }));
  const app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin, stream, staticDir: dist, logger: false,
    now: () => clock, listKeys: ListSigningKeys.fromFolder(trust) });
  await app.listen({ host: "127.0.0.1", port });
  const password = "correct horse battery staple";
  const secret = totp.newSecret();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, 'ada.admin', 'Ada Admin', 'admin', $2, 0, 1, $3, 1)`, [randomUUID(), await hashPassword(password), secrets.seal(secret)]);
  const code = () => { clock += 30_000; return totp.code(secret, totp.stepAt(clock)); };
  const work = mkdtempSync(join(tmpdir(), "list-sign-"));

  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  try {
    const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409|422|429)/.test(m.text())) problems.push(m.text()); });
    await page.goto(origin);
    await page.getByLabel("Username").fill("ada.admin");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByLabel(/6-digit code/).fill(code());
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();
    await page.goto(`${origin}/admin/approved-apps`);
    await page.getByRole("heading", { name: "Approved programs", level: 1 }).waitFor();

    await page.getByLabel("Name", { exact: true }).fill("Kiosk");
    await page.getByLabel(/Full path to the program/).fill("C:\\Program Files\\Vendor\\kiosk.exe");
    await page.getByRole("button", { name: "Add to the list" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("dialog").getByLabel("Authenticator code").fill(code());
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByText("Saved. Sign it below to put it in force.").waitFor();
    const panel = page.getByRole("region", { name: "Waiting for a signature" });
    await panel.getByText("Version 1 is waiting for your signature.").waitFor();
    assert.equal(await readLevel(db.app, "fleet", null), null, "nothing is in force before it is signed");

    // The download is the exact document the server will check the signature against.
    const [download] = await Promise.all([page.waitForEvent("download"), panel.getByRole("button", { name: "Download the list to sign" }).click()]);
    assert.equal(download.suggestedFilename(), "approved-list-fleet-v1.json");
    const listFile = join(work, download.suggestedFilename());
    await download.saveAs(listFile);
    const bytes = readFileSync(listFile);
    assert.equal(JSON.parse(bytes.toString("utf8")).product, "mashura-approved-list");

    // The list itself uploaded by mistake is caught on the page.
    await panel.getByLabel("Upload the signature file").setInputFiles(listFile);
    await panel.getByText(/That is the list itself/).waitFor();

    // A signature from another key is refused by the server, and nothing goes into force.
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const wrong = join(work, "wrong.signature.json");
    writeFileSync(wrong, JSON.stringify({ keyId, algorithm: "ecdsa-p256-sha256", signature: sign("sha256", bytes, { key: other.privateKey, dsaEncoding: "der" }).toString("base64") }));
    await panel.getByLabel("Upload the signature file").setInputFiles(wrong);
    await panel.getByRole("alert").getByText(/does not verify for this list/).waitFor();
    assert.equal(await readLevel(db.app, "fleet", null), null);

    // The Admin's signature, as Sign-ApprovedList.ps1 writes it.
    const good = join(work, "approved-list-fleet-v1.signature.json");
    writeFileSync(good, JSON.stringify({ keyId, algorithm: "ecdsa-p256-sha256", signature: sign("sha256", bytes, { key: pair.privateKey, dsaEncoding: "der" }).toString("base64") }));
    await panel.getByLabel("Upload the signature file").setInputFiles(good);
    await page.getByText("This list is signed. Cabinets that check signatures use it.").waitFor();
    const state = await readLevelState(db.app, "fleet", null);
    assert.deepEqual(state.list?.entries.map(e => e.key), ["app:Kiosk"]);
    assert.equal(state.list?.signed?.signature.keyId, keyId);
    assert.equal(state.pending, null);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await app.close();
    await stream.stop();
    await db.drop();
  }
});
