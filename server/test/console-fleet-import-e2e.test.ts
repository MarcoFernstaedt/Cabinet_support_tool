// Clients and sites in bulk (F6.R4), in a real browser: a pasted list with a bad line is named by line; fixed, it is previewed against
// what exists and imported with one code, and the new clients and sites are on the page.
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

test("a pasted list is previewed, a bad line named, and the list imported with one code", { skip, timeout: 120_000 }, async () => {
  const browser = await launchChromium();
  const c = await startConsole(dist);
  const problems: string[] = [];
  try {
    const harbour = randomUUID();
    await c.db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour Health')", [harbour]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [randomUUID(), harbour]);
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of 401/.test(m.text())) problems.push(m.text()); });
    await c.signIn(page);
    await page.goto(`${c.origin}/admin/clients`);
    await page.getByText("Import clients and sites").click();
    const box = page.getByLabel("Clients and sites", { exact: true });
    await box.fill("Client, Site\nHarbour Health, Pier\nHarbour Health, Dock 2\nOnly a client\n\"Smith, Jones Clinic\", North");
    await page.getByRole("button", { name: "Preview" }).click();
    await page.getByRole("alert").getByText("Line 4: needs a client and a site").waitFor();
    await box.fill("Client, Site\nHarbour Health, Pier\nHarbour Health, Dock 2\n\"Smith, Jones Clinic\", North");
    await page.getByRole("button", { name: "Preview" }).click();
    await page.getByRole("status").getByText("1 new client and 2 new sites will be created.").waitFor();
    assert.equal(await page.getByRole("row").filter({ hasText: "Pier" }).getByText("Already exists").count(), 1);
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm with your authenticator" });
    await dialog.getByText("Create 1 client and 2 sites from the list.").waitFor();
    await dialog.getByLabel("Authenticator code").fill(await c.code());
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await page.getByRole("status").getByText("Imported 1 new client and 2 new sites.").waitFor();
    await page.getByRole("region", { name: "Client Smith, Jones Clinic" }).getByText("North").waitFor();
    const sites = (await c.db.app.query<{ name: string }>("SELECT name FROM sites WHERE client_id = $1 ORDER BY name", [harbour])).rows.map(r => r.name);
    assert.deepEqual(sites, ["Dock 2", "Pier"]);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await c.close();
  }
});
