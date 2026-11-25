// Where a cabinet's settings come from (F6.R5), in a real browser: the Standards tab lists approved programs and USB watch
// with the level each comes from, and a level whose stored value was refused says so in the line's dialog instead of reading as unset.
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

test("the Standards tab names where each inherited setting comes from, and a refused level is called out", { skip, timeout: 120_000 }, async () => {
  const browser = await launchChromium();
  const c = await startConsole(dist);
  const problems: string[] = [];
  try {
    const clientId = randomUUID(), siteId = randomUUID(), cabinetId = randomUUID();
    await c.db.app.query("INSERT INTO clients (id, name, watched_services) VALUES ($1, 'Harbour Health', '[\"Spooler\"]')", [clientId]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name, approved_apps) VALUES ($1, $2, 'Pier', $3)", [siteId, clientId,
      JSON.stringify({ version: 1, entries: [], hash: "0".repeat(64), setBy: randomUUID(), setAt: "2026-10-01T00:00:00.000Z" })]);
    await c.db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'Pier 1', 'standalone', 'active')", [cabinetId, siteId]);
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of 401/.test(m.text())) problems.push(m.text()); });
    await c.signIn(page);
    await page.goto(`${c.origin}/cabinets/${cabinetId}/standards`);
    await page.getByRole("heading", { name: "Standards for Pier 1" }).waitFor();
    const row = (label: string) => page.getByRole("row").filter({ has: page.getByRole("button", { name: label, exact: true }) });
    await row("Approved programs").waitFor();
    assert.match(await row("Approved programs").innerText(), /None \(the list in force was refused\)\s+The site/);
    assert.match(await row("Watched services").innerText(), /Spooler\s+The client/);
    assert.equal(await row("File-facts paths").count(), 0, "the file-facts read is removed (D150)");
    assert.match(await row("USB watch").innerText(), /Nothing watched\s+Not set/);
    await page.getByRole("button", { name: "Approved programs", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Approved programs" });
    await dialog.getByText("The value stored at the site was refused when read").waitFor();
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await c.close();
  }
});
