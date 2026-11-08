// The offer to capture a cabinet's configuration as its site's baseline (F17, D53), in a real browser: on the cabinet's page, a healthy
// cabinet at a site with no baseline offers it, and accepting opens the site's new draft. A cabinet out of contact is not offered.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configHash, type Item } from "../src/services/config-canonical.js";
import { ingestAndEvaluate } from "../src/services/config-service.js";
import { reevaluationsSettled } from "../src/console-api/baseline-routes.js";
import { startConsole } from "./browser-console.js";
import { launchChromium } from "./browser-launch.js";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";

test("a healthy cabinet at a site with no baseline offers to become its baseline; accepting opens the site's draft", { skip, timeout: 120_000 }, async () => {
  const browser = await launchChromium();
  const c = await startConsole(dist);
  const problems: string[] = [];
  try {
    const clientId = randomUUID(), siteId = randomUUID(), cabinetId = randomUUID(), quietId = randomUUID();
    await c.db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour Health')", [clientId]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [siteId, clientId]);
    await c.db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, 'Pier 1', 'standalone', 'active', SYSUTCDATETIME())", [cabinetId, siteId]);
    await c.db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, 'Pier 2', 'standalone', 'active', DATEADD(hour, -3, SYSUTCDATETIME()))", [quietId, siteId]);
    const it = (key: string, values: Record<string, unknown>) => ({ key, values }) as Item;
    const s = (category: string, items: Item[]) => ({ observedAt: new Date().toISOString(), category, hash: configHash(items), truncated: false, items });
    const all = [
      s("network", [it("adapter:Ethernet", { connected: true, dhcp: true, addresses: ["10.77.0.9/24"], gateways: ["10.77.0.1"] })]),
      s("services", [it("service:W32Time", { startType: "automatic", state: "running" })]),
      s("drivers", [it("driver:oem1.inf", { version: "1.0" })]),
      s("updates", [it("update:KB5000001", { title: "Update" })]),
      s("firewall", [it("profile:domain", { enabled: true })]),
      s("time", [it("time", { timeZoneId: "UTC" })]),
      s("applications", [it("app:Cabinet App", { version: "4.2" })]),
      s("hosts", [it("host:localhost", { address: "127.0.0.1" })]),
      s("tasks", [it("task:Backup", { enabled: true })]),
      s("system", [it("hardware", { manufacturer: "Dell Inc.", model: "OptiPlex 7090" })]),
    ];
    for (const id of [cabinetId, quietId]) {
      await ingestAndEvaluate(c.db.app, id, all.slice(0, 8) as never, "agent");
      await ingestAndEvaluate(c.db.app, id, all.slice(8) as never, "agent");
    }
    await reevaluationsSettled();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of 401/.test(m.text())) problems.push(m.text()); });
    await c.signIn(page);
    // Out of contact: no offer.
    await page.goto(`${c.origin}/cabinets/${quietId}`);
    await page.getByRole("heading", { name: /^Configuration/ }).waitFor();
    assert.equal(await page.getByRole("note", { name: "Site baseline offer" }).count(), 0);
    // Healthy: offered, and accepting opens the draft for the site.
    await page.goto(`${c.origin}/cabinets/${cabinetId}`);
    const offer = page.getByRole("note", { name: "Site baseline offer" });
    await offer.waitFor();
    assert.match(await offer.innerText(), /Pier has no baseline of its own, and this cabinet is healthy/);
    await offer.getByRole("button", { name: "Capture as Pier's baseline" }).click();
    await page.waitForURL(/\/admin\/baselines\/versions\/[0-9a-f-]{36}$/);
    const site = (await c.db.app.query<{ scope_id: string; status: string }>(
      "SELECT b.scope_id, v.status FROM baselines b JOIN baseline_versions v ON v.baseline_id = b.id WHERE b.scope_kind = 'site'")).rows;
    assert.deepEqual(site.map(r => [r.scope_id.toLowerCase(), r.status]), [[siteId, "draft"]]);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await c.close();
  }
});
