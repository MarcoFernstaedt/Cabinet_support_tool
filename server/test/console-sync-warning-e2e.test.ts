// The sync-cabinet warning in a real browser (docs/spec/13-roadmap.md module 37, the owner's decision): every change confirmed on a sync
// cabinet's page names the satellites that depend on it; the same change on a satellite carries no such warning. Runs when the console is built.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startConsole } from "./browser-console.js";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";

test("a change on a sync cabinet is confirmed with a warning naming its satellites", { skip, timeout: 240_000 }, async () => {
  const { chromium } = await import("playwright");
  const c = await startConsole(dist);
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  try {
    const [client, site, sync, satA, satB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await c.db.app.query("INSERT INTO clients (id, name, firewall_policy) VALUES ($1, 'Harbor Health', $2)", [client, JSON.stringify({ domain: "off", private: "off", public: "off" })]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'North')", [site, client]);
    const allOn = JSON.stringify({ domain: true, private: true, public: true });
    await c.db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, read_only, last_heartbeat_at, firewall_profiles, sync_cabinet_id) VALUES
      ($1, $4, 'SYNC', 'sync', 'active', 0, SYSUTCDATETIME(), $5, NULL),
      ($2, $4, 'EXAM 1', 'satellite', 'active', 0, SYSUTCDATETIME(), $5, $1),
      ($3, $4, 'EXAM 2', 'satellite', 'active', 0, SYSUTCDATETIME(), $5, $1)`, [sync, satA, satB, site, allOn]);

    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409|429)/.test(m.text())) problems.push(m.text()); });
    await c.signIn(page);

    await page.goto(`${c.origin}/cabinets/${sync}/firewall`);
    await page.getByRole("button", { name: "Apply policy" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("note").filter({ hasText: "This is the sync cabinet for 2 satellites (EXAM 1, EXAM 2)." }).waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // The same change on a satellite: no warning.
    await page.goto(`${c.origin}/cabinets/${satA}/firewall`);
    await page.getByRole("button", { name: "Apply policy" }).click();
    await page.getByRole("dialog").getByText(/Set the firewall profiles as the policy says/).waitFor();
    assert.equal(await page.getByRole("dialog").getByText(/This is the sync cabinet/).count(), 0);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await c.close();
  }
});
