// The browser tests' sign-in helper returns only once the sign-in is complete (decision-log D79). Before, it clicked Continue on the code
// step and returned at once. A test that navigated straight after cancelled the code request and was left on the code form, half signed
// in; under load this failed the cabinet System panel test about one run in three. Here the code request is held back so that the race
// happens every time.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startConsole } from "./browser-console.js";
import { launchChromium } from "./browser-launch.js";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";

test("signInAs returns signed in even when the code step is slow and the test navigates straight after", { skip, timeout: 120_000 }, async () => {
  const browser = await launchChromium();
  const c = await startConsole(dist);
  try {
    const id = await c.addUser("slow.code", "tier1");
    await c.db.app.query("UPDATE users SET tour_completed = 1 WHERE id = $1", [id]);
    const page = await (await browser.newContext()).newPage();
    await page.route("**/api/auth/totp", async route => { await new Promise(r => setTimeout(r, 1_500)); await route.continue(); });
    await c.signInAs(page, "slow.code");
    await page.goto(`${c.origin}/`);
    await page.getByRole("heading", { name: "Fleet", level: 1 }).waitFor({ timeout: 15_000 });
    const stages = (await c.db.app.query<{ stage: string }>("SELECT stage FROM sessions WHERE user_id = $1", [id])).rows.map(r => r.stage);
    assert.deepEqual(stages, ["complete"]);
  } finally {
    await browser.close();
    await c.close();
  }
});

test("signInAs says so when the code step is refused, rather than returning on the code form", { skip, timeout: 120_000 }, async () => {
  const browser = await launchChromium();
  const c = await startConsole(dist);
  try {
    await c.addUser("bad.code", "tier1");
    const page = await (await browser.newContext()).newPage();
    await page.route("**/api/auth/totp", route => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "invalid_code", message: "That code is not right." }) }));
    await assert.rejects(c.signInAs(page, "bad.code"), /bad\.code: the code step answered 401/);
  } finally {
    await browser.close();
    await c.close();
  }
});
