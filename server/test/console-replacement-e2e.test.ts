// Replacing a cabinet in a real browser (docs/spec/05-server-spec.md "Replacing a cabinet"): the approval offers the site's cabinets of
// the chosen role, the offline one first; choosing it fills in its name and the confirmation says what happens to it; afterwards the old
// cabinet's page links to its replacement and the new one's links back. Runs when the console is built.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { startConsole } from "./browser-console.js";
import { csrFor, ecKey } from "./helpers.js";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";

test("a reinstalled cabinet is approved as the one it replaces, and the two pages link to each other", { skip, timeout: 240_000 }, async () => {
  const { chromium } = await import("playwright");
  const c = await startConsole(dist);
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  try {
    const [client, site, old, online] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await c.db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Lakeside')", [client]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'East')", [site, client]);
    await c.db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES
      ($1, $3, 'Ward 3', 'standalone', 'active', DATEADD(day, -2, SYSUTCDATETIME())), ($2, $3, 'Ward 4', 'standalone', 'active', SYSUTCDATETIME())`, [old, online, site]);
    const { token } = await createBootstrapToken(c.db.app, c.adminId);
    await submitEnrollment(c.db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: { hostname: "WARD3-NEWDRIVE", serialNumber: "SN-" + randomBytes(3).toString("hex"),
      macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: new Date().toISOString(), osVersion: "Windows 11 Pro", agentVersion: "0.3.1" } }, "127.0.0.1");

    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409|429)/.test(m.text())) problems.push(m.text()); });
    await c.signIn(page);
    await page.goto(`${c.origin}/admin/pending`);
    const card = page.getByRole("region", { name: "Request from WARD3-NEWDRIVE" });
    await card.getByLabel("Client").fill("Lakeside");
    await card.getByLabel("Site").fill("East");
    const replaces = card.getByLabel("Replaces");
    await replaces.waitFor();
    // The cabinet not heard from comes first, after "a new cabinet".
    const options = await replaces.locator("option").allTextContents();
    assert.equal(options[0], "Nothing: a new cabinet");
    assert.match(options[1]!, /^Ward 3 \(not heard from since /);
    assert.equal(options[2], "Ward 4");
    await replaces.selectOption({ label: options[1]! });
    assert.equal(await card.getByLabel("Cabinet name").inputValue(), "Ward 3", "replacing fills in the old name");
    await card.getByText("Ward 3 is retired and its settings are copied to this cabinet.", { exact: false }).waitFor();
    await card.getByLabel("Capture this cabinet's configuration as the site baseline draft").check();
    await card.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("dialog").getByText(/It replaces Ward 3: the old cabinet is retired with its history kept/).waitFor();
    await c.confirmWithCode(page);
    await card.getByText(/Approved\. Ward 3 will come online within a minute\. Ward 3 is retired\./).waitFor();

    const fresh = (await c.db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE replaces_cabinet_id = $1", [old])).rows[0]!.id;
    await page.goto(`${c.origin}/cabinets/${old}`);
    const note = page.getByRole("note").filter({ hasText: "This cabinet was replaced by" });
    await note.getByRole("link", { name: "Ward 3" }).click();
    await page.waitForURL(new RegExp(`/cabinets/${fresh}$`, "i"));
    await page.getByRole("heading", { name: "Ward 3", level: 1 }).waitFor();
    await page.getByRole("link", { name: /^Ward 3 \(replaced \d{4}-\d{2}-\d{2}\)$/ }).waitFor();
    // What will be put back once the new agent reports (no agent runs here, so it waits).
    await page.getByRole("region", { name: /^Settings put back from Ward 3 \(replaced/ }).getByText(/Waiting for this cabinet to report/).waitFor();
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await c.close();
  }
});
