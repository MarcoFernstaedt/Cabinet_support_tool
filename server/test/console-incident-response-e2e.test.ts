// Incident response (roadmap module 42), in a real browser: a fleet alert's report says who is still affected and who has recovered, and
// "Stage a recovery" opens Fleet operations with exactly the still-affected cabinets chosen, ready for its preview and batches.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sweepFleetPatterns } from "../src/services/fleet-patterns.js";
import { startConsole } from "./browser-console.js";
import { launchChromium } from "./browser-launch.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";

test("a fleet alert's report stages a recovery of the still-affected cabinets through Fleet operations", { skip, timeout: 300_000 }, async () => {
  const browser = await launchChromium();
  const c = await startConsole(dist);
  try {
    // Six sites with the same error. The first has three cabinets, one of which recovers; the second recovers outright.
    const client = randomUUID(), tag = randomBytes(3).toString("hex"), sig = `unrecognized:System|stage probe ${tag}|5`;
    await c.db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `Stage ${tag}`]);
    const cabinetsAt: string[][] = [];
    for (let s = 0; s < 6; s++) {
      const site = randomUUID(), here: string[] = []; cabinetsAt.push(here);
      await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [site, client, `Stage ${tag} site ${s}`]);
      for (let n = 0; n < (s === 0 ? 3 : 1); n++) {
        const k = randomUUID(); here.push(k);
        await c.db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, $3, 'standalone', 'active')", [k, site, `STAGE ${s}-${n}`]);
        await c.db.app.query(`INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen, occurrences, scope)
            VALUES ($1, NULL, 'major', $2, $3, DATEADD(hour, -2, SYSUTCDATETIME()), SYSUTCDATETIME(), 1, 'fleet')`, [k, sig, `Stage probe ${tag}`]);
      }
    }
    await sweepFleetPatterns(c.db.app);
    await c.db.app.query("UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME() WHERE signature = $1 AND cabinet_id IN ($2, $3)", [sig, cabinetsAt[0]![0], cabinetsAt[1]![0]]);

    const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
    await c.signIn(page);
    await page.goto(c.origin + "/incidents");
    await page.locator("tr", { hasText: `Stage probe ${tag}` }).getByRole("button", { name: "Report" }).click();
    const report = page.getByLabel(new RegExp(`Report: .*Stage probe ${tag}`));
    await report.waitFor();
    assert.match(await report.locator("dl").innerText(), /Still affected\s*6[\s\S]*Recovered\s*2/i);
    // The recovery table lists only the sites with cabinets still affected: the second site has recovered and is not there.
    const recovery = report.getByRole("table", { name: "Sites with cabinets still affected" });
    assert.equal(await recovery.locator("tbody tr").count(), 5);
    assert.equal(await recovery.locator("tr", { hasText: `site 1` }).count(), 0);
    await recovery.getByRole("button", { name: `Stage the recovery of Stage ${tag} site 0` }).click();
    await page.waitForURL(/\/fleet-operations/);
    // Fleet operations opens on that site with exactly its two still-affected cabinets chosen, of its three.
    await page.getByRole("status").filter({ hasText: /2 of 3 selected/ }).waitFor();
    // That line counts the selection carried in the link and the site's cabinet count, both known before the site's cabinets have loaded;
    // the rows come after. Read them once two ticked rows are on the page, not as soon as the line shows (under load, the table was still
    // empty then and this read []).
    const tickedRows = page.locator("tbody tr").filter({ has: page.locator("input[type=checkbox]:checked") });
    await tickedRows.nth(1).waitFor();
    const ticked = await tickedRows.allInnerTexts();
    assert.deepEqual(ticked.map(t => t.match(/STAGE \d-\d/)?.[0]).sort(), ["STAGE 0-1", "STAGE 0-2"]);
  } finally {
    await browser.close();
    await c.close();
  }
});
