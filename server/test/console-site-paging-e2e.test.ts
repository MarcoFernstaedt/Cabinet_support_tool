// A site's cabinets are paged by the server, from the route to the site page (fleet audit finding 7, decision-log D81). Before, the route
// never passed a page, so the server sent the first 200 and the page paged those in the browser: a site with more than 200 cabinets showed
// "of 200" and the rest could not be reached. The route's query is checked against its contract (site-page-query) before anything else.
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

test("a site with more than 200 cabinets is paged by the server, through the route and on the site page", { skip, timeout: 180_000 }, async () => {
  const browser = await launchChromium();
  const c = await startConsole(dist);
  try {
    const clientId = randomUUID(), siteId = randomUUID();
    await c.db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Large Client')", [clientId]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Big Site')", [siteId, clientId]);
    const names = Array.from({ length: COUNT }, (_, i) => `Cab ${String(i + 1).padStart(3, "0")}`);
    await c.db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status)
                          SELECT NEWID(), $1, value, 'standalone', 'active' FROM OPENJSON($2)`, [siteId, JSON.stringify(names)]);
    const userId = await c.addUser("site.viewer", "tier1");
    await c.db.app.query("UPDATE users SET tour_completed = 1 WHERE id = $1", [userId]);
    const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
    await c.signInAs(page, "site.viewer");
    const get = (query: string) => page.request.get(`${c.origin}/api/fleet/sites/${siteId}${query}`);

    // The route: the default page, the last page, and every cabinet once across the pages.
    const first = await (await get("")).json();
    assert.equal(first.cabinets.length, 200);
    assert.equal(first.cabinetCount, COUNT);
    assert.deepEqual(first.cabinetsPage, { limit: 200, offset: 0, hasMore: true });
    const last = await (await get("?limit=25&offset=225")).json();
    assert.deepEqual(last.cabinets.map((k: { name: string }) => k.name), names.slice(225));
    assert.deepEqual(last.cabinetsPage, { limit: 25, offset: 225, hasMore: false });
    const seen: string[] = [];
    for (let offset = 0; offset < COUNT; offset += 60) seen.push(...(await (await get(`?limit=60&offset=${offset}`)).json()).cabinets.map((k: { name: string }) => k.name));
    assert.deepEqual(seen, names, "every cabinet once, in name order");

    // Anything outside the contract is refused before the database is asked.
    for (const bad of ["?limit=0", "?limit=501", "?limit=-1", "?offset=-1", "?offset=1000000", "?offset=007", "?limit=25%3B%20DROP%20TABLE%20cabinets",
      "?limit=1e3", "?limit=25&limit=50", "?page=2", "?limit="])
      assert.equal((await get(bad)).status(), 400, bad);

    // The site page: the whole count, and the last cabinets reachable.
    await page.goto(`${c.origin}/sites/${siteId}`);
    const pager = page.getByRole("navigation", { name: "Pages of cabinets" });
    await pager.getByText(`1–10 of ${COUNT} · page 1 of 23`).waitFor();
    for (let i = 1; i < 23; i++) await pager.getByRole("button", { name: "Next" }).click();
    await pager.getByText(`221–${COUNT} of ${COUNT} · page 23 of 23`).waitFor();
    const rows = page.getByRole("table").filter({ has: page.getByText("Cabinets at Big Site") }).getByRole("row");
    await page.getByRole("link", { name: "Cab 230" }).waitFor();
    assert.equal(await rows.count(), 1 + 10, "the header and a full last page of ten cabinets");
    assert.equal(await page.getByRole("heading", { name: "Big Site", level: 1 }).count(), 1, "the site stays on screen while a page loads");
  } finally {
    await browser.close();
    await c.close();
  }
});
