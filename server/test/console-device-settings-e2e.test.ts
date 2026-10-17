// Device settings that follow the client, in a real browser: an Admin sets a client's scanner (a vendor ID, so any model
// from that vendor matches) and its sync ports once; the site and the cabinet show where the values in use come from;
// a site overrides the ports. Runs when the console is built.
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
import { createTestDatabase, startFeed } from "./database.js";
import { tempDir } from "./helpers.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";
const freePort = (): Promise<number> => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

test("device settings in the console: a client's scanner and sync ports set once, inherited by its sites and cabinets, overridden by one site", { skip, timeout: 120_000 }, async () => {
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
                      VALUES ($1, 'ada.admin', 'Ada Admin', 'admin', $2, false, true, $3, true)`, [randomUUID(), await hashPassword(password), secrets.seal(secret)]);
  const code = (): string => { clock += 30_000; return totp.code(secret, totp.stepAt(clock)); };
  const client = randomUUID(), site = randomUUID(), cabinet = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Acme Health')", [client]);
  await db.app.query("INSERT INTO sites (id, client_id, name, sync_address) VALUES ($1, $2, 'North', '10.20.0.15')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, 'ICU cabinet', 'standalone', 'active', now())", [cabinet, site]);
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

    // The client: its scanner (any model from the vendor) and its sync ports, once.
    await page.goto(`${origin}/clients/${client}`);
    const scanner = page.getByRole("region", { name: "Fingerprint scanner for Acme Health" });
    await scanner.getByText(/cabinets find the scanner automatically/).waitFor();
    await scanner.getByLabel(/This client's scanner IDs/).fill("USB\\VID_1234");
    await scanner.getByRole("button", { name: "Save" }).click();
    // Scanner IDs only change which device the checks look at: one click to confirm, no authenticator code.
    assert.equal(await page.getByRole("dialog", { name: "Confirm with your authenticator" }).count(), 0);
    await page.getByRole("dialog", { name: "Confirm the change" }).getByText(/every cabinet of Acme Health/).waitFor();
    await page.getByRole("dialog", { name: "Confirm the change" }).getByRole("button", { name: "Make the change" }).click();
    await scanner.getByText("Set here:").waitFor();
    const ports = page.getByRole("region", { name: "Sync cabinet ports for Acme Health" });
    await ports.getByLabel(/TCP ports/).fill("1433, 5000");
    await ports.getByRole("button", { name: "Save" }).click();
    await confirm(/every site of Acme Health/);
    await ports.getByText("1433, 5000").first().waitFor();

    // The site inherits both and says so; then it overrides the ports.
    await page.goto(`${origin}/sites/${site}`);
    const sync = page.getByRole("region", { name: "Sync cabinet" });
    await sync.getByText(/Ports in use: 1433, 5000/).waitFor();
    await sync.getByText(/from the client's default/).waitFor();
    await page.getByRole("region", { name: "Fingerprint scanner at North" }).getByText(/the client's setting applies/).waitFor();
    await sync.getByLabel(/This site's TCP ports/).fill("8080");
    await sync.getByRole("button", { name: "Save" }).click();
    await confirm(/ports 8080/);
    await sync.getByText(/Ports in use: 8080/).waitFor();
    await sync.getByText(/from this site's own setting/).waitFor();

    // The cabinet uses the client's scanner, and says where it comes from.
    await page.goto(`${origin}/cabinets/${cabinet}/scanner`);
    const ids = page.getByRole("region", { name: "Scanner hardware IDs" });
    await ids.getByText(/from the client's setting/).waitFor();
    assert.match(await ids.innerText(), /USB\\VID_1234/);

    // ---- The cabinet's Standards: every setting it is held to, one line each; a line opens every level and the editors ----
    await page.goto(`${origin}/cabinets/${cabinet}/standards`);
    const table = page.getByRole("table", { name: /Each setting this cabinet is held to/ });
    for (const line of ["Firewall policy", "Network baseline", "Time zone", "Sync cabinet", "Fingerprint scanner IDs", "Watched services"])
      await table.getByRole("button", { name: line }).waitFor();
    await table.getByRole("row", { name: /Fingerprint scanner IDs/ }).getByText("The client").waitFor();
    await table.getByRole("button", { name: "Fingerprint scanner IDs" }).click();
    const dialog = page.getByRole("dialog", { name: "Fingerprint scanner IDs" });
    await dialog.getByLabel("This cabinet's own scanner IDs", { exact: false }).fill("USB\\VID_5555&PID_0002");
    await dialog.getByRole("button", { name: "Save" }).first().click();
    await page.getByRole("dialog", { name: "Confirm the change" }).getByRole("button", { name: "Make the change" }).click();
    await dialog.getByText("Set here:").first().waitFor().catch(async e => { await page.screenshot({ path: "/tmp/std.png" }); throw new Error(`${e.message}\nPage: ${(await page.locator("body").innerText()).slice(0, 900)}`); });
    await dialog.getByRole("button", { name: "Close" }).click();
    assert.deepEqual((await db.app.query("SELECT scanner_hardware_ids AS ids FROM cabinets WHERE id = $1", [cabinet])).rows[0].ids, ["USB\\VID_5555&PID_0002"]);
    // The firewall policy line opens the policy at the cabinet's client; changing it asks for the code.
    await table.getByRole("button", { name: "Firewall policy" }).click();
    await page.getByRole("dialog", { name: "Firewall policy" }).getByRole("heading", { name: "Firewall policy for Acme Health" }).waitFor();
    await page.getByRole("dialog", { name: "Firewall policy" }).getByRole("button", { name: "Close" }).click();

    // ---- The client firewall policy: the cabinet reports all profiles on, unlike the default (all off) ----
    await db.app.query(`UPDATE cabinets SET firewall_profiles = '{"domain":true,"private":true,"public":true}', read_only = false, last_heartbeat_at = now() WHERE id = $1`, [cabinet]);
    await page.goto(`${origin}/sites/${site}`);
    const bulk = page.getByRole("region", { name: "Firewall policy across North" });
    await bulk.getByText(/1 online cabinet differs from the firewall policy: ICU cabinet/).waitFor();
    await bulk.getByRole("button", { name: "Apply the policy to 1 cabinet…" }).click();
    const pw = page.getByRole("dialog", { name: "Confirm with your password" });
    await pw.getByText(/Apply the firewall policy to 1 cabinet at North/).waitFor();
    await pw.getByLabel("Your password").fill("not my password");
    await pw.getByRole("button", { name: "Confirm" }).click();
    await pw.getByRole("alert").waitFor();
    await pw.getByLabel("Your password").fill(password);
    await pw.getByRole("button", { name: "Confirm" }).click();
    await bulk.getByRole("list", { name: "Bulk apply results" }).getByText(/ICU cabinet: Sent/).waitFor();
    const queued = (await db.app.query("SELECT operation, params, bulk_id FROM commands WHERE cabinet_id = $1 AND operation = 'firewall.applyPolicy'", [cabinet])).rows;
    assert.deepEqual(queued.map(q => [q.operation, q.params, !!q.bulk_id]), [["firewall.applyPolicy", { profiles: { domain: false, private: false, public: false } }, true]]);

    const audited = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE action IN ('client.scanner','client.sync','site.sync') ORDER BY seq")).rows.map(r => r.action);
    assert.deepEqual(audited, ["client.scanner", "client.sync", "site.sync"]);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await stream.stop();
    await app.close();
    await db.drop();
  }
});
