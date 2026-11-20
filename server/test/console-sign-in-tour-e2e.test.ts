// The browser tests' shared sign-in (browser-console.ts) returns only once the server has recorded the skipped tour. The console sends
// that without waiting for it, so a test that navigated straight after could cancel it, and the next page showed the tour again over
// the form the test meant to use (console-replacement-e2e on #327's run at c27a0b4). Runs when the console is built.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startConsole } from "./browser-console.js";
import { launchChromium } from "./browser-launch.js";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";

test("signing in returns only once the skipped tour is recorded, so the next page does not show it again", { skip, timeout: 120_000 }, async () => {
  const browser = await launchChromium(); // first, so a browser that will not start leaves nothing running
  const c = await startConsole(dist);
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    // A slow answer, as on a busy runner: it arrives after the page would already have moved on.
    await page.route("**/api/auth/tour-complete", async route => { await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
    await c.signIn(page);
    const seen = async () => (await c.db.app.query<{ done: boolean }>("SELECT tour_completed AS done FROM users WHERE id = $1", [c.adminId])).rows[0]!.done;
    assert.equal(await seen(), true, "the skip is recorded before signIn returns");
    await page.goto(`${c.origin}/admin/pending`);
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    assert.equal(await page.locator("aside.welcome-tour").count(), 0, "the tour does not come back on the next page");
  } finally {
    await browser.close();
    await c.close();
  }
});
