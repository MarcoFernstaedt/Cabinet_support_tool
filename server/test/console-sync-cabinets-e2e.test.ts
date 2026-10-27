// Sync cabinets and satellites in the console (docs/spec/05-server-spec.md "Sync cabinets and satellites"): the site lists its sync
// cabinets and the satellites still waiting for one; an incomplete satellite says so and an Admin assigns it; a sync cabinet's address
// can be set by an Admin; and approving a satellite at a site with several sync cabinets asks which one it reaches.
// Runs when the console is built.
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

test("sync cabinets: the site's list, an incomplete satellite assigned, an Admin's address, and the approver's choice", { skip, timeout: 180_000 }, async () => {
  const { chromium } = await import("playwright");
  const c = await startConsole(dist);
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  try {
    const [client, site, syncA, syncB, sat] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await c.db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Riverside')", [client]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Midtown')", [site, client]);
    await c.db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, sync_address, sync_address_source) VALUES
      ($1, $4, 'Midtown Sync A', 'sync', 'active', '10.40.0.20', 'reported'), ($2, $4, 'Midtown Sync B', 'sync', 'active', NULL, NULL),
      ($3, $4, 'Exam 1', 'satellite', 'active', NULL, NULL)`, [syncA, syncB, sat, site]);

    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409)/.test(m.text())) problems.push(m.text()); });
    await c.signIn(page);

    // The site: both sync cabinets with where their address comes from, and the satellite still waiting.
    await page.goto(`${c.origin}/sites/${site}`);
    const panel = page.getByRole("region", { name: "Sync cabinets at Midtown" });
    await panel.getByRole("row", { name: /Midtown Sync A.*10\.40\.0\.20.*reported by the cabinet/ }).waitFor();
    await panel.getByRole("row", { name: /Midtown Sync B.*Not reported yet/ }).waitFor();
    await panel.getByText("1 satellite has no sync cabinet assigned.").waitFor();
    await page.getByRole("row", { name: /Exam 1/ }).getByText("Enrollment incomplete").waitFor();

    // The satellite says it is incomplete; an Admin assigns it with a code.
    await page.goto(`${c.origin}/cabinets/${sat}`);
    await page.getByText("Enrollment incomplete: no sync cabinet").waitFor();
    await page.getByRole("button", { name: "Assign" }).click();
    await page.getByLabel("Sync cabinet").selectOption({ label: "Midtown Sync A (10.40.0.20)" });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("dialog").getByText(/Assign Exam 1 to Midtown Sync A/).waitFor();
    await c.confirmWithCode(page);
    await page.getByText("Enrollment incomplete: no sync cabinet").waitFor({ state: "detached" });
    assert.equal((await c.db.app.query<{ s: string }>("SELECT sync_cabinet_id AS s FROM cabinets WHERE id = $1", [sat])).rows[0]!.s.toLowerCase(), syncA);

    // Sync B has no address yet: an Admin sets one.
    await page.goto(`${c.origin}/cabinets/${syncB}`);
    await page.getByRole("button", { name: "Set address" }).click();
    await page.getByLabel("Private IPv4 address").fill("8.8.8.8");
    await page.getByText(/A private IPv4 address: 10\.x/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true, "a public address is not even offered for the code");
    await page.getByLabel("Private IPv4 address").fill("10.40.0.21");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await c.confirmWithCode(page);
    await page.getByText("set by an Admin").waitFor();
    const stored = (await c.db.app.query<{ a: string; s: string }>("SELECT sync_address AS a, sync_address_source AS s FROM cabinets WHERE id = $1", [syncB])).rows[0]!;
    assert.deepEqual([stored.a, stored.s], ["10.40.0.21", "admin"]);

    // A new satellite at this site: the approver must choose which sync cabinet it reaches.
    const { token } = await createBootstrapToken(c.db.app, c.adminId);
    await submitEnrollment(c.db.app, { csr: csrFor(ecKey()), bootstrapToken: token,
      fingerprints: { hostname: "EXAM-2", serialNumber: "SN-" + randomBytes(3).toString("hex"), macAddresses: [], provisionedClient: null, provisionedSite: null,
        onlineSince: "2026-10-27T08:00:00Z", osVersion: "Windows 11", agentVersion: "0.3.0" } }, "127.0.0.1");
    await page.goto(`${c.origin}/admin/pending`);
    const card = page.getByRole("region", { name: "Request from EXAM-2" });
    await card.getByLabel("Client").fill("Riverside");
    await card.getByLabel("Site").fill("Midtown");
    await card.getByLabel("Role").selectOption("satellite");
    await card.getByText("This site has 2 sync cabinets.").waitFor();
    assert.equal(await card.getByRole("button", { name: "Approve" }).isDisabled(), true, "no choice yet");
    await card.getByLabel("Sync cabinet").selectOption({ label: "Midtown Sync B (10.40.0.21)" });
    await card.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("dialog").getByText(/It reaches Midtown Sync B/).waitFor();
    await c.confirmWithCode(page);
    await card.getByText(/Approved/).waitFor();
    const linked = (await c.db.app.query<{ s: string }>("SELECT y.name AS s FROM cabinets k JOIN cabinets y ON y.id = k.sync_cabinet_id WHERE k.name = 'EXAM-2'")).rows[0]?.s;
    assert.equal(linked, "Midtown Sync B");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await c.close();
  }
});
