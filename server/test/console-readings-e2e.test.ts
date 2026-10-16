// Stored readings in the console: the fleet search finds what an offline cabinet last reported, its Windows tab shows that reading at once
// (with when it was read), and a cabinet's overview draws its load history.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DemoSimulator } from "../src/demo/demo.js";
import { startConsole } from "./browser-console.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";

test("the fleet search, last-known readings on an offline cabinet, and load charts", { skip, timeout: 300_000 }, async () => {
  const { chromium } = await import("playwright");
  const c = await startConsole(dist);
  const simulator = new DemoSimulator(c.db.app, () => {});
  simulator.start();
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  try {
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|404|409|429)/.test(m.text())) problems.push(m.text()); });
    await c.signIn(page);
    await c.startDemo(page);

    // Search by a program the offline cabinet last reported.
    await page.getByRole("link", { name: "Search", exact: true }).click();
    await page.getByRole("heading", { name: "Search the fleet" }).waitFor();
    await page.getByLabel("Text").fill("Practice Manager");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const results = page.getByRole("region", { name: "Search results" });
    await results.getByText(/found among the/).waitFor({ timeout: 30_000 });
    await results.getByText(/never read/).waitFor();
    // A state search offers fixed choices.
    await page.getByLabel("Find").selectOption("power.status");
    assert.equal(await page.getByLabel("Text").count(), 0, "no free text for a state search");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await results.getByText(/found among the/).waitFor();
    // Back to the program, and open the match.
    await page.getByLabel("Find").selectOption("software.list");
    await page.getByLabel("Text").fill("Practice Manager");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await results.getByRole("link").first().click();

    // The offline cabinet's Windows tab shows what it last reported, without asking it.
    await page.getByText(/This cabinet has not been heard from since/).waitFor();
    await page.getByText(/Last read /).first().waitFor({ timeout: 30_000 });
    await page.getByText("Practice Manager").first().waitFor();

    // A cabinet that is heard from has a load history on its overview.
    const midtown = (await c.db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE name = 'Midtown Sync'")).rows[0]!.id;
    await page.goto(`${c.origin}/cabinets/${midtown}`);
    const trends = page.getByRole("region", { name: "Load over time" }).or(page.locator("section", { has: page.getByRole("heading", { name: "Load over time" }) }));
    await trends.getByRole("img", { name: /^Processor: \d+%/ }).waitFor({ timeout: 30_000 });
    await trends.getByRole("img", { name: /^Memory: \d+%/ }).waitFor();
    await trends.getByLabel("Range").selectOption("168");
    await trends.getByRole("img", { name: /^System drive: \d+%/ }).waitFor();
    assert.deepEqual(problems, []);
  } catch (e) {
    throw new Error(`${(e as Error).message}\nPage: ${page.url()}\n${(await page.locator("main").innerText().catch(() => "")).slice(0, 1800)}\nProblems: ${problems.join(" | ")}`);
  } finally {
    simulator.stop();
    await browser.close();
    await c.close();
  }
});
