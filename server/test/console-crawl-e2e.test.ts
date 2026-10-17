// Every page and every cabinet section, in a real browser, as an Admin with the demo fleet on: each must load without a script error,
// a failed request that is not expected, an error banner, the error screen or a sideways scroll bar. The read buttons of every section are
// pressed too (never a button that changes anything). With SHOTS set, each page is photographed.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "playwright";
import { DemoSimulator } from "../src/demo/demo.js";
import { startConsole } from "./browser-console.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";

/** Buttons that only read. Anything else (Apply, Install, Set, Restart, Delete…) is never pressed. */
const READS = /^(Run|Read|Check|Measure|Diagnose|Refresh|Scan|List|Load|Look|Show|Test|Trace|Start reading)\b/i;

test("every page and cabinet section loads cleanly and its read buttons answer", { skip, timeout: 900_000 }, async () => {
  const { chromium } = await import("playwright");
  const c = await startConsole(dist);
  const simulator = new DemoSimulator(c.db.app, () => {});
  simulator.start();
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  let where = "";
  const note = (m: string) => problems.push(`${where}: ${m}`);
  try {
    const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
    page.on("pageerror", e => note(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409|429)/.test(m.text())) note(`console: ${m.text()}`); });
    await c.signIn(page);
    await c.startDemo(page);

    const q = async <T>(sql: string) => (await c.db.app.query<T & Record<string, string>>(sql)).rows;
    const cabinet = (await q<{ id: string }>("SELECT id FROM cabinets WHERE name = 'Midtown Sync'"))[0]!.id;
    const site = (await q<{ id: string }>("SELECT site_id AS id FROM cabinets WHERE name = 'Midtown Sync'"))[0]!.id;
    const client = (await q<{ id: string }>("SELECT s.client_id AS id FROM sites s WHERE s.id = (SELECT site_id FROM cabinets WHERE name = 'Midtown Sync')"))[0]!.id;
    const sections = ["overview", "standards", "troubleshoot", "changes", "compare", "alerts", "events", "services", "processes", "files", "devices", "drives", "updates", "time", "network", "firewall", "scanner", "crashes", "windows", "software", "history"];
    const pages = [
      "/", "/search", "/alerts", "/incidents", "/fleet-operations", "/issues", "/fixes", "/account", "/demo",
      `/clients/${client}`, `/sites/${site}`,
      ...["", "/setup", "/pending", "/tokens", "/scanner", "/audit", "/software", "/upgrades", "/users", "/online", "/clients", "/issues", "/safety", "/security", "/settings"].map(p => `/admin${p}`),
      ...sections.map(s => `/cabinets/${cabinet}/${s}`),
    ];

    let n = 0;
    for (const path of pages) {
      where = path;
      await page.goto(c.origin + path);
      await page.locator("h1, h2").first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(700);
      await readPage(page, note);
      if (path.startsWith("/cabinets/")) {
        const buttons = page.locator("main button:visible").filter({ hasText: READS });
        const count = Math.min(await buttons.count(), 6);
        for (let i = 0; i < count; i++) {
          const b = buttons.nth(i);
          if (!(await b.isEnabled().catch(() => false))) continue;
          await b.click({ timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(1_800);
        }
        await readPage(page, note);
      }
      await accessibility(page, note);
      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/crawl-${String(++n).padStart(2, "0")}-${path.replaceAll(/[^a-z0-9]+/gi, "_").slice(-40)}.png`, fullPage: true });
    }
    // The light theme, on the main pages and a cabinet.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    for (const path of ["/", "/alerts", "/search", "/admin/settings", `/cabinets/${cabinet}/overview`, `/cabinets/${cabinet}/drives`, `/cabinets/${cabinet}/network`]) {
      where = `${path} (light)`;
      await page.goto(c.origin + path);
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      await page.locator("h1, h2").first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(700);
      await accessibility(page, note);
    }
    assert.deepEqual(problems, []);
  } finally {
    simulator.stop();
    await browser.close();
    await c.close();
  }
});

/** What a person would see go wrong on the page as it is now. */
async function readPage(page: Page, note: (m: string) => void): Promise<void> {
  for (const text of await page.locator("[role=alert]:visible").allTextContents()) note(`alert: ${text.slice(0, 200)}`);
  if (await page.getByText(/Something went wrong|Unexpected Application Error/i).count()) note("the error screen is showing");
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) note("the page scrolls sideways");
}

/** The automated WCAG 2.1 A and AA rules (axe-core); anything it reports is a failure, named with the first element it found. */
async function accessibility(page: Page, note: (m: string) => void): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  for (const v of result.violations) note(`accessibility ${v.id} (${v.impact}, ${v.nodes.length}): ${v.nodes[0]?.target.join(" ")} ${(v.nodes[0]?.html ?? "").slice(0, 120)}`);
}
