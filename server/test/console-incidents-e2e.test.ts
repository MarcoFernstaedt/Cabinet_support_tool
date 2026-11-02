// Incident records on a cabinet's History tab, in a real browser (docs/platform/diagnostic-engine-execution.md, item 6): the incident is
// listed with its state and symptom, opens to its steps in order with who took each, and a cabinet with none says so. Runs when the
// console is built.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendStep, openIncident } from "../src/services/incidents.js";
import { startConsole } from "./browser-console.js";
import { launchChromium } from "./browser-launch.js";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";

test("a cabinet's History tab lists its incidents and opens one to its steps", { skip, timeout: 240_000 }, async () => {
  const browser = await launchChromium(); // first, so a browser that will not start leaves nothing running
  const c = await startConsole(dist);
  const problems: string[] = [];
  try {
    const [client, site, cab, quiet] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await c.db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbor Health')", [client]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'North')", [site, client]);
    await c.db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $3, 'EXAM 1', 'satellite', 'active'), ($2, $3, 'EXAM 2', 'satellite', 'active')", [cab, quiet, site]);
    const admin = (await c.db.app.query<{ id: string }>("SELECT id FROM users WHERE username = 'ada.admin'")).rows[0]!.id;
    const id = await openIncident(c.db.app, { cabinetId: cab, symptom: "The fingerprint scanner is not answering", by: { kind: "system", name: "engine" } });
    await appendStep(c.db.app, id, { kind: "proposed_repair", summary: "Restart the scanner's service" }, { kind: "system", name: "engine" });
    await appendStep(c.db.app, id, { kind: "approval", summary: "Approved for the morning" }, { kind: "user", userId: admin });

    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409|429)/.test(m.text())) problems.push(m.text()); });
    await c.signIn(page);

    await page.goto(`${c.origin}/cabinets/${cab}/history`);
    const panel = page.getByRole("region", { name: "Incidents" });
    await panel.getByText("The fingerprint scanner is not answering").waitFor();
    await panel.getByText("Approved", { exact: true }).waitFor();
    await panel.getByText("The repair is approved and not yet sent.").waitFor();
    await panel.getByRole("button", { name: "Show steps" }).click();
    const steps = panel.getByRole("list", { name: "Steps, in order" }).getByRole("listitem");
    await steps.nth(2).waitFor();
    assert.equal(await steps.count(), 3);
    assert.match(await steps.nth(0).innerText(), /Symptom: The fingerprint scanner is not answering\s+\(the platform \(engine\)\)/);
    assert.match(await steps.nth(1).innerText(), /Repair proposed: Restart the scanner's service/);
    assert.match(await steps.nth(2).innerText(), /Approved: Approved for the morning/);
    assert.ok(!(await panel.innerText()).includes(admin), "a person is named, never shown by id");
    // The command history is still on the tab, below.
    await page.getByRole("heading", { name: "Command history" }).waitFor();

    await page.goto(`${c.origin}/cabinets/${quiet}/history`);
    await page.getByText("No incidents have been recorded on this cabinet.").waitFor();
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await c.close();
  }
});
