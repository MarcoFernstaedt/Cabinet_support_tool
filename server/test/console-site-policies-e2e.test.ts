// Site policies in a real browser (docs/spec/05-server-spec.md "Site policies"): the approval of a cabinet at a new site shows what the
// site would inherit, the approver sets the site's own firewall policy and time zone, and the site page then shows them as the site's
// own; the client's default zone set on its page reaches a site that sets none. Runs when the console is built.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { startConsole } from "./browser-console.js";
import { csrFor, ecKey } from "./helpers.js";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";

test("a new site's firewall policy and time zone are confirmed with its first approval, and a client's zone reaches its other sites", { skip, timeout: 240_000 }, async () => {
  const { chromium } = await import("playwright");
  const c = await startConsole(dist);
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409|429)/.test(m.text())) problems.push(m.text()); });
    const request = async (hostname: string) => {
      const { token } = await createBootstrapToken(c.db.app, c.adminId);
      return submitEnrollment(c.db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: { hostname, serialNumber: "SN-" + randomBytes(3).toString("hex"), macAddresses: [],
        provisionedClient: null, provisionedSite: null, onlineSince: new Date().toISOString(), osVersion: "Windows 11 Pro", agentVersion: "0.3.1" } }, "127.0.0.1");
    };
    await request("CLINIC-ONE");
    await c.signIn(page);
    await page.goto(`${c.origin}/admin/pending`);
    const card = page.getByRole("region", { name: "Request from CLINIC-ONE" });
    await card.getByLabel("Client").fill("Quill Veterinary");
    await card.getByLabel("Site").fill("Harbor");
    const policies = card.getByRole("group", { name: "Policies for the new site Harbor" });
    // Pre-filled from what the site would inherit: the fleet's all-off firewall policy, and no zone anywhere.
    await policies.getByText("Firewall: use the fleet's policy (Domain off, Private off, Public off)").waitFor();
    assert.equal(await policies.getByLabel(/Firewall: use the fleet's policy/).isChecked(), true);
    await policies.getByLabel("Firewall: set this site's own").check();
    await policies.getByLabel("Public profile").selectOption("on");
    await policies.getByLabel("New site's time zone").selectOption("Pacific Standard Time");
    await card.getByLabel("Capture this cabinet's configuration as the site baseline draft").check();
    await card.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("dialog").getByText(/The new site uses its own firewall policy \(Domain off, Private off, Public on\) and the time zone Pacific/).waitFor();
    await c.confirmWithCode(page);
    await card.getByText(/Approved\. CLINIC-ONE will come online within a minute/).waitFor();

    const ids = (await c.db.app.query<{ site: string; client: string }>(
      "SELECT s.id AS site, s.client_id AS client FROM sites s JOIN clients cl ON cl.id = s.client_id WHERE cl.name = 'Quill Veterinary' AND s.name = 'Harbor'")).rows[0]!;
    await page.goto(`${c.origin}/sites/${ids.site}`);
    await page.getByRole("region", { name: "Firewall policy at Harbor" }).getByText("Domain off, Private off, Public on").waitFor();
    assert.equal(await page.getByRole("region", { name: "Time zone at Harbor" }).getByLabel("Time zone").inputValue(), "Pacific Standard Time");

    // The client's default zone, set on the client's page, reaches a site that sets none of its own.
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES (NEWID(), $1, 'Inland')", [ids.client]);
    await page.goto(`${c.origin}/clients/${ids.client}`);
    const clientZone = page.getByRole("region", { name: "Time zone for Quill Veterinary's sites" });
    await clientZone.getByLabel("Time zone").selectOption("Mountain Standard Time");
    await clientZone.getByRole("button", { name: "Save" }).click();
    await clientZone.getByText(/Saved/).waitFor();
    const inland = (await c.db.app.query<{ id: string }>("SELECT id FROM sites WHERE client_id = $1 AND name = 'Inland'", [ids.client])).rows[0]!.id;
    await page.goto(`${c.origin}/sites/${inland}`);
    await page.getByRole("region", { name: "Time zone at Inland" }).getByText(/Not set here; the client's default applies: Mountain/).waitFor();
    await page.getByRole("region", { name: "Firewall policy at Inland" }).getByText(/Nothing set here; the fleet default applies/).waitFor();
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await c.close();
  }
});
