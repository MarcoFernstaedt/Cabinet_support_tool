// Desktop and laptop only (docs/spec/06-console-spec.md): at every common width from 1024 to 2560 px the main pages fit the window
// without a sideways page scroll (wide tables scroll inside their own region), the top bar keeps every link reachable, and the narrow-
// screen notice is hidden. Below 1024 px the desktop layout stays and the notice shows. SHOTS=<folder> saves a screenshot of each.
// Runs when the console is built.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startConsole } from "./browser-console.js";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";
const WIDTHS = [1024, 1280, 1366, 1440, 1920, 2560];

test("desktop widths 1024-2560 px: no sideways page scroll, every top-bar link reachable; below 1024 px a notice", { skip, timeout: 300_000 }, async () => {
  const { chromium } = await import("playwright");
  const c = await startConsole(dist);
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await c.signIn(page);
    await c.startDemo(page);
    const cabinet = (await c.db.app.query<{ id: string }>("SELECT TOP (1) id FROM cabinets WHERE demo_scenario IS NOT NULL ORDER BY name")).rows[0]!.id;
    const site = (await c.db.app.query<{ site_id: string }>("SELECT site_id FROM cabinets WHERE id = $1", [cabinet])).rows[0]!.site_id;
    const pages = ["/", "/alerts", "/search", "/incidents", "/fleet-operations", "/fleet-differences", "/issues", "/admin", "/admin/users",
      `/sites/${site}`, `/cabinets/${cabinet}`, `/cabinets/${cabinet}/network`, `/cabinets/${cabinet}/services`, `/cabinets/${cabinet}/logs`];
    const problems: string[] = [];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width >= 1920 ? 1080 : 800 });
      for (const path of pages) {
        await page.goto(`${c.origin}${path}`);
        await page.locator("main h1").first().waitFor();
        await page.waitForTimeout(400); // the live stream keeps the network busy, so let the page settle instead
        const fit = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: window.innerWidth }));
        if (fit.scroll > fit.view) problems.push(`${width}px ${path}: the page is ${fit.scroll}px wide`);
        if (await page.locator(".screen-notice").isVisible()) problems.push(`${width}px ${path}: the narrow-screen notice shows`);
        if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `${width}${path.replace(/[^a-z0-9]+/gi, "-")}.png`) });
      }
      // Every main-menu link can be reached: in view, or scrolled into view inside the bar.
      for (const link of await page.getByRole("navigation", { name: "Main" }).getByRole("link").all()) {
        await link.scrollIntoViewIfNeeded();
        if (!(await link.isVisible())) problems.push(`${width}px: the "${await link.textContent()}" link cannot be reached`);
      }
    }
    assert.deepEqual(problems, []);

    // A narrower window keeps the desktop layout (scrolls sideways) and says the console is for wider screens.
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto(`${c.origin}/`);
    await page.getByRole("note").getByText("at least 1024 px wide").waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth >= 1024), "the layout does not reflow below 1024 px");
  } finally {
    await browser.close();
    await c.close();
  }
});
