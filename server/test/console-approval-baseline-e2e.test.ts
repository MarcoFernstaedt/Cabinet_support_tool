// The baseline decision in a real browser (docs/spec/15-baselines-and-config.md "Baselines at enrollment"): with no approved baseline in
// force, the approval says "Baseline required" and Approve waits for a decision; capture is confirmed in the dialog, and the site's cabinet
// list and the cabinet's Overview say "Baseline required" and why. With a client baseline approved, the next approval uses it by default.
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

test("the approval asks for a baseline decision, and the cabinet says Baseline required until one is in force", { skip, timeout: 240_000 }, async () => {
  const { chromium } = await import("playwright");
  const c = await startConsole(dist);
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409|429|500)/.test(m.text())) problems.push(m.text()); });
    const request = async (hostname: string) => {
      const { token } = await createBootstrapToken(c.db.app, c.adminId);
      return submitEnrollment(c.db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: { hostname, serialNumber: "SN-" + randomBytes(3).toString("hex"), macAddresses: [],
        provisionedClient: null, provisionedSite: null, onlineSince: new Date().toISOString(), osVersion: "Windows 11 Pro", agentVersion: "0.3.1" } }, "127.0.0.1");
    };
    await request("WARD-ONE");
    await c.signIn(page);
    await page.goto(`${c.origin}/admin/pending`);
    const card = page.getByRole("region", { name: "Request from WARD-ONE" });
    // The first read of which baselines apply fails (the 500 is faked, so the browser logging it is expected): the approval says so and
    // offers to read again, instead of waiting forever.
    let failOnce = true;
    await page.route("**/api/admin/enrollments/*/baseline?*", route => {
      if (!failOnce) return route.continue();
      failOnce = false;
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal", message: "internal error" }) });
    });
    await card.getByLabel("Client").fill("Papa Health");
    await card.getByLabel("Site").fill("Ward 4");
    await card.getByText(/Could not read which baselines apply/).waitFor();
    assert.equal(await card.getByRole("button", { name: "Approve" }).isDisabled(), true);
    await card.getByRole("button", { name: "Try again" }).click();
    await card.getByLabel("Role").selectOption("standalone");
    // No baseline applies to a new client: the approval says so, and Approve waits for the decision.
    await card.getByText("Baseline required").first().waitFor();
    await card.getByText("Choose a baseline to approve.").waitFor();
    assert.equal(await card.getByRole("button", { name: "Approve" }).isDisabled(), true, "no baseline decision, no approval");
    assert.equal(await card.getByLabel("Use the baseline in force").count(), 0, "nothing in force to use");
    await card.getByLabel("Capture this cabinet's configuration as the site baseline draft").check();
    await card.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("dialog").getByText(/Baseline: capture this cabinet's configuration as the site baseline draft\./).waitFor();
    await c.confirmWithCode(page);
    await card.getByText(/Approved\. WARD-ONE will come online within a minute\. It shows Baseline required/).waitFor();
    const decided = (await c.db.app.query<{ decision: string; capture_state: string }>(
      "SELECT e.decision, e.capture_state FROM enrollment_baselines e JOIN cabinets k ON k.id = e.cabinet_id WHERE k.name = 'WARD-ONE'")).rows[0];
    assert.deepEqual(decided, { decision: "capture", capture_state: "waiting" });

    // The site's cabinet list and the cabinet's Overview say "Baseline required", and why.
    const ids = (await c.db.app.query<{ site: string; client: string; cabinet: string }>(
      "SELECT s.id AS site, s.client_id AS client, k.id AS cabinet FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.name = 'WARD-ONE'")).rows[0]!;
    await page.goto(`${c.origin}/sites/${ids.site}`);
    await page.getByRole("table", { name: "Cabinets at Ward 4" }).getByText("Baseline required").waitFor();
    await page.goto(`${c.origin}/cabinets/${ids.cabinet}`);
    await page.getByText(/Baseline required\. Its configuration becomes the site's baseline draft once it has reported all of it \(0 of 10 parts so far\)\./).waitFor();

    // The client gets an approved baseline: the next approval at another of its sites uses it by default.
    const baselineId = randomUUID();
    await c.db.app.query("INSERT INTO baselines (id, scope_kind, scope_id, name, created_by) VALUES ($1, 'client', $2, 'Papa Health', $3)", [baselineId, ids.client.toLowerCase(), c.adminId]);
    await c.db.app.query(`INSERT INTO baseline_versions (id, baseline_id, [version], status, content, description, created_by, decided_by, decided_at)
                          VALUES ($1, $2, 1, 'approved', '{"items":[]}', 'Ward standard', $3, $3, SYSUTCDATETIME())`, [randomUUID(), baselineId, c.adminId]);
    await request("WARD-TWO");
    await page.goto(`${c.origin}/admin/pending`);
    const second = page.getByRole("region", { name: "Request from WARD-TWO" });
    await second.getByLabel("Client").fill("Papa Health");
    await second.getByLabel("Site").fill("Ward 5");
    await second.getByText("Judged against Papa Health v1 (the client).", { exact: true }).waitFor();
    assert.equal(await second.getByLabel("Use the baseline in force").isChecked(), true, "the baseline in force is the default");
    await second.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("dialog").getByText(/Baseline: Judged against Papa Health v1 \(the client\)\./).waitFor();
    await c.confirmWithCode(page);
    await second.getByText(/Approved\. WARD-TWO will come online within a minute\.$/).waitFor();
    const site5 = (await c.db.app.query<{ id: string }>("SELECT site_id AS id FROM cabinets WHERE name = 'WARD-TWO'")).rows[0]!.id;
    await page.goto(`${c.origin}/sites/${site5}`);
    await page.getByRole("table", { name: "Cabinets at Ward 5" }).getByText("In force").waitFor();
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await c.close();
  }
});
