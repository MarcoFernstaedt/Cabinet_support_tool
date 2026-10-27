// A cabinet whose agent accepts unsigned upgrades (a development build) is marked in the console: "Test build" in its site's cabinet
// list, and a warning on its own page. A cabinet whose agent does not say so shows neither. Runs when the console is built.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startConsole } from "./browser-console.js";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";

test("a development-build cabinet is marked in the site list and on its own page; a production one is not", { skip, timeout: 120_000 }, async () => {
  const { chromium } = await import("playwright");
  const c = await startConsole(dist);
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  try {
    const [client, site, devBuild, prodBuild] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await c.db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Test Client')", [client]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Test Site')", [site, client]);
    await c.db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, agent_version, unsigned_upgrades) VALUES
      ($1, $3, 'Dev cabinet', 'standalone', 'active', '0.3.0-dev', 1), ($2, $3, 'Prod cabinet', 'standalone', 'active', '0.3.0', 0)`, [devBuild, prodBuild, site]);
    const page = await (await browser.newContext()).newPage();
    await c.signIn(page);

    await page.goto(`${c.origin}/sites/${site}`);
    const devRow = page.getByRole("row", { name: /Dev cabinet/ });
    await devRow.getByText("Test build").waitFor();
    assert.equal(await page.getByRole("row", { name: /Prod cabinet/ }).getByText("Test build").count(), 0);

    await page.goto(`${c.origin}/cabinets/${devBuild}`);
    await page.getByText("Test build: accepts unsigned upgrades").waitFor();
    await page.getByRole("note").getByText(/development build of the agent/).waitFor();

    await page.goto(`${c.origin}/cabinets/${prodBuild}`);
    await page.getByRole("heading", { name: "Prod cabinet", level: 1 }).waitFor();
    assert.equal(await page.getByText("Test build: accepts unsigned upgrades").count(), 0);
  } finally {
    await browser.close();
    await c.close();
  }
});
