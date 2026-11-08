// Which Windows the fleet runs (F20, D55), in a real browser: the Fleet page lists each edition, build family and architecture with its
// cabinets, and says how many were never read and that the update source is not read yet.
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

test("the Fleet page shows the Windows the fleet runs, and what it has not read", { skip, timeout: 120_000 }, async () => {
  const browser = await launchChromium();
  const c = await startConsole(dist);
  const problems: string[] = [];
  try {
    const clientId = randomUUID(), siteId = randomUUID(), userId = randomUUID();
    await c.db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'reader.e2e', 'Reader', 'tier1')", [userId]);
    await c.db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour Health')", [clientId]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [siteId, clientId]);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [i, id] of ids.entries())
      await c.db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, architecture) VALUES ($1, $2, $3, 'standalone', 'active', 'windows-x64')", [id, siteId, `Pier ${i + 1}`]);
    for (const [id, build] of [[ids[0], "19044.999"], [ids[1], "19044.5011"]] as const)
      await c.db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result, result_at)
        VALUES ($1, $2, 'system.info', '{}', $3, SYSUTCDATETIME(), DATEADD(minute, 5, SYSUTCDATETIME()), 'succeeded', $4, SYSUTCDATETIME())`,
        [randomUUID(), id, userId, JSON.stringify({ status: "succeeded", output: { osVersion: "Windows 10 IoT Enterprise LTSC 2021", osBuild: build } })]);
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of 401/.test(m.text())) problems.push(m.text()); });
    await c.signIn(page);
    await page.goto(`${c.origin}/`);
    const panel = page.getByRole("region", { name: "Windows in the fleet" });
    await panel.waitFor();
    assert.match(await panel.innerText(), /2 of 3 cabinets; 1 not read yet\. Where each gets its updates from \(Windows Update, WSUS\) is not read yet\./);
    const row = panel.getByRole("row").filter({ hasText: "Windows 10 IoT Enterprise LTSC 2021" });
    assert.match(await row.innerText(), /19044\s+19044\.999 to 19044\.5011\s+.*\s+2\s/);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await c.close();
  }
});
