// The site installer's site picker (F6.R1), in a real browser: a failed read of the sites says so, with a way to read them again, instead
// of an empty list and a Create button that never comes on (review of #186).
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

test("the site installer says when the sites could not be read, and reads them again on request", { skip, timeout: 120_000 }, async () => {
  const browser = await launchChromium();
  const c = await startConsole(dist);
  const problems: string[] = [];
  try {
    const clientId = randomUUID(), siteId = randomUUID();
    await c.db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour Health')", [clientId]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [siteId, clientId]);
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    // The 500s below are faked, so the browser logging it is expected.
    page.on("console", m => { if (m.type() === "error" && !/status of (401|500)/.test(m.text())) problems.push(m.text()); });
    await c.signIn(page);
    // Every read of the sites fails until the test lets them through (the page reads them in more than one place).
    let failing = true;
    await page.route("**/api/admin/clients", route => {
      if (!failing) return route.continue();
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal", message: "the server is restarting" }) });
    });
    await page.goto(`${c.origin}/admin/setup`);
    await page.getByLabel("One installer for several cabinets of one site").check();
    const alert = page.getByRole("alert").filter({ hasText: "Could not read the sites" });
    await alert.waitFor();
    assert.equal(await page.getByRole("option", { name: "Harbour Health / Pier" }).count(), 0, "nothing to choose while the read failed");
    failing = false;
    await alert.getByRole("button", { name: "Try again" }).click();
    await page.getByRole("combobox", { name: /^Site/ }).selectOption({ label: "Harbour Health / Pier" });
    assert.equal(await alert.count(), 0, "the sentence goes once the sites are read");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await c.close();
  }
});
