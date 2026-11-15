// A screen that picks one of a site's cabinets offers every one of them, not only the first page the site route sends (decision-log D85).
// Before, the approved-programs cabinet picker was built from one answer of /api/fleet/sites/:id, which holds the first 200 cabinets, so
// on a larger site cabinet 201 and later could not be chosen.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { startConsole } from "./browser-console.js";
import { csrFor, ecKey } from "./helpers.js";
import { launchChromium } from "./browser-launch.js";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";
const COUNT = 230;

test("the approved-programs cabinet picker offers every cabinet of a site of more than 200", { skip, timeout: 180_000 }, async () => {
  const browser = await launchChromium();
  const c = await startConsole(dist);
  try {
    const clientId = randomUUID(), siteId = randomUUID();
    await c.db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Large Client')", [clientId]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Big Site')", [siteId, clientId]);
    const names = Array.from({ length: COUNT }, (_, i) => `Cab ${String(i + 1).padStart(3, "0")}`);
    await c.db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status) SELECT NEWID(), $1, value, 'standalone', 'active' FROM OPENJSON($2)`, [siteId, JSON.stringify(names)]);
    const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
    const sitePages: string[] = [];
    page.on("request", r => { const u = new URL(r.url()); if (u.pathname === `/api/fleet/sites/${siteId}`) sitePages.push(u.search); });
    await c.signIn(page);
    await page.goto(`${c.origin}/admin/approved-apps`);
    await page.getByLabel("Set the list for").selectOption("cabinet");
    await page.getByLabel("Client", { exact: true }).selectOption({ label: "Large Client" });
    await page.getByLabel("Site", { exact: true }).selectOption({ label: "Big Site" });
    const picker = page.getByLabel("Cabinet", { exact: true });
    await picker.locator("option", { hasText: "Cab 230" }).waitFor({ state: "attached" });
    const offered = (await picker.locator("option").allTextContents()).filter(t => t.startsWith("Cab "));
    assert.deepEqual(offered, names, "every cabinet, once, in name order");
    await picker.selectOption({ label: "Cab 230" });
    assert.deepEqual(sitePages, ["", "?limit=500&offset=200"], "the first page as before, then the rest");
  } finally {
    await browser.close();
    await c.close();
  }
});

test("approving an enrollment offers every cabinet it may replace, and a failed read of the site says so with a way to try again", { skip, timeout: 240_000 }, async () => {
  // Review of #275: the read behind "Replaces" and the sync cabinets threw its failure away. On a large site it is two requests, and one
  // that failed left both lists empty with nothing on screen, which reads as "this site has nothing to replace".
  const browser = await launchChromium();
  const c = await startConsole(dist);
  try {
    const clientId = randomUUID(), siteId = randomUUID();
    await c.db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Large Client')", [clientId]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Big Site')", [siteId, clientId]);
    const names = Array.from({ length: COUNT }, (_, i) => `Cab ${String(i + 1).padStart(3, "0")}`);
    await c.db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status) SELECT NEWID(), $1, value, 'standalone', 'active' FROM OPENJSON($2)`, [siteId, JSON.stringify(names)]);
    const { token } = await createBootstrapToken(c.db.app, c.adminId);
    await submitEnrollment(c.db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: { hostname: "BIG-NEWDRIVE", serialNumber: "SN-" + randomBytes(3).toString("hex"),
      macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: new Date().toISOString(), osVersion: "Windows 11 Pro", agentVersion: "0.3.1" } }, "127.0.0.1");
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    // The second page of the site fails once.
    let failed = 0;
    await page.route(u => u.pathname === `/api/fleet/sites/${siteId}` && u.searchParams.get("offset") === "200", route => failed++ === 0
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal" }) }) : route.continue());
    await c.signIn(page);
    await page.goto(`${c.origin}/admin/pending`);
    const card = page.getByRole("region", { name: "Request from BIG-NEWDRIVE" });
    await card.getByLabel("Client").fill("Large Client");
    await card.getByLabel("Site").fill("Big Site");
    const alert = card.getByRole("alert").filter({ hasText: "This site's cabinets could not be read" });
    await alert.waitFor();
    assert.equal(await card.getByLabel("Replaces").count(), 0, "no partial list is offered");
    await card.getByRole("button", { name: "Try again" }).click();
    const replaces = card.getByLabel("Replaces");
    await replaces.locator("option", { hasText: "Cab 230" }).waitFor({ state: "attached" });
    assert.equal((await replaces.locator("option").allTextContents()).filter(t => t.startsWith("Cab ")).length, COUNT, "every cabinet of the site is offered");
    assert.equal(await alert.count(), 0, "the alert is gone once the read succeeds");
    assert.equal(failed, 2, "the failed page, then the retry");
  } finally {
    await browser.close();
    await c.close();
  }
});
