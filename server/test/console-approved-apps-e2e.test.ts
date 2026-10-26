// Approved programs in a real browser: an Admin adds an application and a service to a client's list, confirms with an authenticator
// code, and the server stores exactly those programs; the fleet default can approve nothing; a bad path is refused on the page before
// anything is sent. Runs when the console is built.
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
import { readLevel } from "../src/services/approved-apps.js";
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
  const code = () => { clock += 30_000; return totp.code(secret, totp.stepAt(clock)); };

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
    await page.getByText(/Version 1, saved/).waitFor();

    // The fleet default can be set to approve nothing.
    await page.getByLabel("Set the list for").selectOption("fleet");
    await page.getByRole("button", { name: "Approve nothing here" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("dialog").getByLabel("Authenticator code").fill(code());
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByText("Saved. Cabinets use it from their next heartbeat.").waitFor();
    assert.deepEqual((await readLevel(db.app, "fleet", null))?.entries, []);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await app.close();
    await stream.stop();
    await db.drop();
  }
});
