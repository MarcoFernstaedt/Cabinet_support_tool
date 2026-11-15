// A screen that picks one of a site's cabinets offers every one of them, not only the first page the site route sends (decision-log D85).
// Before, the approved-programs cabinet picker was built from one answer of /api/fleet/sites/:id, which holds the first 200 cabinets, so
// on a larger site cabinet 201 and later could not be chosen.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startConsole } from "./browser-console.js";
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
