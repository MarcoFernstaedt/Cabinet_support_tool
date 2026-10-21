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
    // A state search offers fixed choices; only the offline cabinets have their power settings stored, so the rest are never read.
    await page.getByLabel("Find").selectOption("power.status");
    assert.equal(await page.getByLabel("Text").count(), 0, "no free text for a state search");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await results.getByText(/found among the/).waitFor();
    await results.getByText(/never read/).waitFor();
    // The machine facts: a hosts line that sends the sync cabinet's name to an old address, and the one cabinet in a workgroup.
    await page.getByLabel("Find").selectOption("network.hosts");
    await page.getByLabel("Text").fill("sync.clinic.example");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await results.getByText(/found among the/).waitFor();
    await results.getByText(/sync\.clinic\.example, sync → \d+\.\d+\.\d+\.12/).first().waitFor();
    await page.getByLabel("Find").selectOption("identity-state");
    await page.getByLabel("Where").selectOption("workgroup");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await results.getByText(/found among the/).waitFor();
    await results.getByRole("link", { name: "Intake" }).waitFor();
    await results.getByText(/In a workgroup: WORKGROUP/).waitFor();
    // Back to the program, and open the match.
    await page.getByLabel("Find").selectOption("software.list");
    await page.getByLabel("Text").fill("Practice Manager");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    // Every demo cabinet has its software read; the offline one is opened by name.
    await results.getByLabel("Filter cabinets").fill("Step-down");
    await results.getByRole("link", { name: /Step-down/ }).first().click();

    // The offline cabinet's Windows tab shows what it last reported, without asking it.
    await page.getByText(/This cabinet has not been heard from since/).waitFor();
    await page.getByText(/Last read /).first().waitFor({ timeout: 30_000 });
    await page.getByText("Practice Manager").first().waitFor();
    // The hardware, identity and hosts file readings are stored too, with plain empty states where a list has nothing in it.
    for (const title of ["Hardware", "Identity and policy", "Hosts file"]) await page.getByRole("heading", { name: title, exact: true }).last().waitFor();
    await page.getByText(/OptiPlex/).first().waitFor();
    await page.getByText("Domain clinic.example").first().waitFor();
    await page.getByRole("cell", { name: "localhost" }).first().waitFor();

    // A cabinet that is heard from has a load history on its overview.
    const midtown = (await c.db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE name = 'Midtown Sync'")).rows[0]!.id;
    await page.goto(`${c.origin}/cabinets/${midtown}`);
    const trends = page.getByRole("region", { name: "Load over time" }).or(page.locator("section", { has: page.getByRole("heading", { name: "Load over time" }) }));
    await trends.getByRole("img", { name: /^Processor: \d+%/ }).waitFor({ timeout: 30_000 });
    await trends.getByRole("img", { name: /^Memory: \d+%/ }).waitFor();
    await trends.getByLabel("Range").selectOption("168");
    await trends.getByRole("img", { name: /^System drive: \d+%/ }).waitFor();
    // Drives that are heading for trouble are listed on the Fleet page, worst first, and the cabinet's drive page shows why and how it got there.
    await page.getByRole("link", { name: "Fleet", exact: true }).click();
    const risk = page.getByRole("region", { name: "Drives to look at" }).or(page.locator("section", { has: page.getByRole("heading", { name: "Drives to look at" }) }));
    await risk.getByRole("row", { name: /Surgery.*Back up and replace now.*reallocated sectors/ }).waitFor({ timeout: 30_000 });
    await risk.getByRole("row", { name: /Lab.*Plan a replacement.*rated life/ }).waitFor();
    await risk.getByRole("row", { name: /ICU.*Watch/ }).waitFor();
    await risk.getByRole("link", { name: "Surgery" }).click();
    const history = page.getByRole("article", { name: /^History of Samsung SSD/ });
    await history.getByText("Back up and replace now", { exact: false }).first().waitFor({ timeout: 30_000 });
    await history.getByRole("img", { name: /^Reallocated sectors: from 0 to \d+ over \d+ days$/ }).waitFor();
    assert.deepEqual(problems, []);
  } catch (e) {
    throw new Error(`${(e as Error).message}\nPage: ${page.url()}\n${(await page.locator("main").innerText().catch(() => "")).slice(0, 1800)}\nProblems: ${problems.join(" | ")}`);
  } finally {
    simulator.stop();
    await browser.close();
    await c.close();
  }
});
