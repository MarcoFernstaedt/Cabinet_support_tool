// The fingerprint scanner as a per-client choice in the console (docs/spec/05-server-spec.md "Fingerprint scanner per client"): an Admin
// switches a client's scanner on with its service (here with signing off, so it is approved at once) and off again; the cabinet then says
// the scanner is not used and offers no scanner checks. Runs when the console is built.
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

test("a client's fingerprint scanner: switched on with its service, switched off, and the cabinet says it is not used", { skip, timeout: 180_000 }, async () => {
  const browser = await launchChromium(); // first, so a browser that will not start leaves nothing running
  const c = await startConsole(dist);
  const problems: string[] = [];
  try {
    const [client, site, cabinet] = [randomUUID(), randomUUID(), randomUUID()];
    await c.db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Lakeside')", [client]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'East')", [site, client]);
    await c.db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, 'Ward 3', 'standalone', 'active')", [cabinet, site]);
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409)/.test(m.text())) problems.push(m.text()); });
    await c.signIn(page);

    await page.goto(`${c.origin}/clients/${client}`);
    const panel = page.getByRole("region", { name: "Fingerprint scanner for Lakeside" });
    await panel.getByText("Service not set up through the platform.").waitFor();
    await panel.getByRole("button", { name: "Set up the scanner's service" }).click();
    await panel.getByLabel("Service key name").fill("BioScanSvc");
    await panel.getByLabel("Service program").fill("C:\\Program Files\\BioScan\\BioScanSvc.exe");
    await panel.getByRole("button", { name: "Use this scanner service" }).click();
    await page.getByRole("dialog").getByText(/add BioScanSvc to its approved programs and watched services/).waitFor();
    await c.confirmWithCode(page);
    await panel.getByText("Approved and watched").waitFor();
    const row = (await c.db.app.query<{ on: boolean; w: string }>("SELECT fingerprint_scanner AS [on], watched_services AS w FROM clients WHERE id = $1", [client])).rows[0]!;
    assert.deepEqual([row.on, JSON.parse(row.w)], [true, ["BioScanSvc"]]);

    await panel.getByRole("button", { name: "Stop using a fingerprint scanner" }).click();
    await c.confirmWithCode(page);
    await panel.getByText(/Not used: no scanner checks, alerts or watching/).waitFor();
    assert.equal(await panel.getByLabel(/This client's scanner IDs/).count(), 0, "no scanner IDs to set for a client that uses no scanner");

    await page.goto(`${c.origin}/cabinets/${cabinet}`);
    await page.getByText("Not used by this client").waitFor();
    await page.goto(`${c.origin}/cabinets/${cabinet}/scanner`);
    await page.getByText(/Lakeside does not use a fingerprint scanner/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Check the scanner" }).count(), 0);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await c.close();
  }
});
