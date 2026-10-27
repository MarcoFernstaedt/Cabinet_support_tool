// The welcome tour, as a person meets it: it starts by itself at first sign-in, goes through the menu and (when there is a cabinet) every tab of it,
// outlining each place as it is explained, differs by role, can be left at any point, is not shown again once seen, and can be taken again from Account.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { DemoSimulator } from "../src/demo/demo.js";
import { startConsole } from "./browser-console.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";

const TABS = ["Overview", "Standards", "Troubleshoot", "What changed", "Compare", "Alerts", "Event logs", "Services", "Processes", "Files", "Devices and drivers", "Drive health",
  "Windows updates", "Time", "Network", "Firewall", "Fingerprint scanner", "Crashes and restarts", "Windows", "Software", "Command history"];

const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/tour-${name.replace(/\W+/g, "_")}.png` }); };
// Checked once nothing is fading in: a contrast check taken mid-animation reads half-transparent text and fails at random.
const axe = async (page: Page, where: string) => {
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
  assert.deepEqual((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations.map(v => `${where}: ${v.id}`), []);
};
/** Goes through the whole tour with Next, returning each step's title; at every step what it points at is outlined (unless it says it cannot be). */
async function walk(page: Page, expect: { outlined: (title: string) => string | null }): Promise<string[]> {
  const panel = page.getByRole("dialog", { name: /./ }).filter({ has: page.locator("#welcome-title") });
  const titles: string[] = [];
  for (let guard = 0; guard < 80; guard++) {
    const title = (await panel.locator("#welcome-title").innerText()).trim();
    titles.push(title);
    const wanted = expect.outlined(title);
    if (wanted !== null) {
      const marked = page.locator(".tour-target").first();
      await marked.waitFor({ timeout: 10_000 });
      assert.match((await marked.innerText()).trim(), new RegExp(wanted), `${title}: the outlined control`);
      assert.equal(await panel.getByText(/not on screen for you/).count(), 0, `${title}: it found what it points at`);
    }
    if (/^(Fleet|Drive health|Time)$/.test(title)) await shot(page, title);
    assert.equal(await page.evaluate(() => document.activeElement?.id ?? ""), "welcome-title", `${title}: the step's heading has the focus`);
    if (await panel.getByRole("button", { name: "Finish" }).count()) { await panel.getByRole("button", { name: "Finish" }).click(); return titles; }
    await panel.getByRole("button", { name: "Next" }).click();
    await page.locator("#welcome-title", { hasNotText: title }).waitFor();
  }
  throw new Error("the tour did not end");
}

test("the welcome tour: first sign-in, role differences, every tab, leaving early, and taking it again", { skip, timeout: 600_000 }, async () => {
  const { chromium } = await import("playwright");
  const c = await startConsole(dist);
  const simulator = new DemoSimulator(c.db.app, () => {});
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  const open = async () => {
    const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|404|409|429)/.test(m.text())) problems.push(m.text()); });
    return page;
  };
  const tourCompleted = async (username: string) => (await c.db.app.query<{ t: boolean }>("SELECT tour_completed AS t FROM users WHERE username = $1", [username])).rows[0]!.t;
  let page = await open();
  try {
    // 1. An Admin on a new installation: nothing is open yet, so the tour starts by itself and says there is no cabinet to look at yet.
    await c.signInAs(page, "ada.admin");
    const welcome = page.getByRole("dialog", { name: "Welcome to the Mashura Support Console" });
    await welcome.waitFor();
    await welcome.getByText(/no remote shell and no file transfer/).waitFor();
    assert.equal(await tourCompleted("ada.admin"), false);
    await shot(page, "welcome");
    await axe(page, "welcome card");
    await welcome.getByRole("button", { name: "Take the tour" }).click();
    await page.locator("#welcome-title", { hasText: "The main menu" }).waitFor();
    await shot(page, "menu");
    await axe(page, "a tour step");
    const outlinedBy: Record<string, string | null> = { "The main menu": "Fleet", Fleet: "^Fleet$", "Jump to": "Jump", Search: "^Search$", Alerts: "^Alerts", Incidents: "^Incidents$", "Differences from baselines": "^Differences", "Fleet operations": "^Fleet operations$",
      Issues: "^Issues$", Fixes: "^Fixes", Admin: "^Admin", "Your account": "Ada Admin" };
    const first = await walk(page, { outlined: t => outlinedBy[t] ?? null });
    assert.deepEqual(first.slice(0, 12), ["The main menu", "Fleet", "Jump to", "Search", "Alerts", "Incidents", "Differences from baselines", "Fleet operations", "Issues", "Fixes", "Admin", "Cabinets"]);
    assert.deepEqual(first.slice(-2), ["Your account", "That is the tour"]);
    assert.ok(!first.includes("Overview"), "no cabinet, so no tabs are shown");
    await page.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();
    assert.equal(await welcome.count(), 0, "the tour is gone");
    await page.waitForFunction(() => !document.querySelector("#welcome-title"));
    await page.waitForFunction(async () => (await (await fetch("/api/auth/me")).json()).user.tourCompleted === true);
    assert.equal(await tourCompleted("ada.admin"), true);
    await page.reload();
    await page.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();
    assert.equal(await page.locator("#welcome-title").count(), 0, "not shown again once seen");

    // 2. With a cabinet: from Account, the full tour goes through every tab, and each tab's link is the one outlined while it is explained.
    await c.startDemo(page);
    simulator.start();
    await page.goto(`${c.origin}/account`);
    await page.getByRole("button", { name: "Run the tour again" }).click();
    await page.getByRole("dialog", { name: "Welcome to the Mashura Support Console" }).getByRole("button", { name: "Take the tour" }).click();
    // The menu's Alerts and the cabinet's Alerts tab share a name: once the cabinet is reached, a name is a tab.
    let inCabinet = false;
    const full = await walk(page, { outlined: t => { if (t === "A cabinet") { inCabinet = true; return "."; } return inCabinet && TABS.includes(t) ? `^${t}$` : inCabinet ? null : outlinedBy[t] ?? null; } });
    for (const t of TABS) assert.ok(full.includes(t), `the full tour explains the ${t} tab`);
    assert.deepEqual(full.slice(full.indexOf("A cabinet") + 1).filter(t => TABS.includes(t)), TABS, "in the order the tabs are shown");

    // 3. The short version, left early with Escape, counts as seen.
    // The finished tour is saved by a request of its own; it must land before the reset, or it would undo it.
    for (let i = 0; i < 100 && !(await c.db.app.query<{ done: boolean }>("SELECT tour_completed AS done FROM users WHERE username = 'ada.admin'")).rows[0]?.done; i++)
      await new Promise(r => setTimeout(r, 100));
    await c.db.app.query("UPDATE users SET tour_completed = 0 WHERE username = 'ada.admin'");
    await page.goto(`${c.origin}/`);
    const card = page.getByRole("dialog", { name: "Welcome to the Mashura Support Console" });
    await card.getByRole("button", { name: "Short version" }).click();
    await page.locator("#welcome-title", { hasText: "The main menu" }).waitFor();
    await page.getByRole("button", { name: "Next" }).click();
    await page.locator("#welcome-title", { hasText: "Fleet" }).waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#welcome-title"));
    await page.waitForFunction(async () => (await (await fetch("/api/auth/me")).json()).user.tourCompleted === true);

    // 4. A Tier 1 person: no Admin, no Fixes; and Back works.
    await c.addUser("tess.tier1", "tier1");
    page = await open();
    await c.signInAs(page, "tess.tier1");
    await page.getByRole("dialog", { name: "Welcome to the Mashura Support Console" }).getByRole("button", { name: "Take the tour" }).click();
    await page.locator("#welcome-title", { hasText: "The main menu" }).waitFor();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Back" }).click();
    await page.locator("#welcome-title", { hasText: "The main menu" }).waitFor();
    await page.getByRole("button", { name: "Next" }).click();
    const tier1 = await walk(page, { outlined: () => null });
    assert.ok(!tier1.includes("Admin") && !tier1.includes("Fixes"), "Tier 1 is not told about menus it does not have");
    assert.ok(tier1.includes("Standards") && tier1.includes("Command history"));
    assert.equal(await page.getByRole("link", { name: "Admin", exact: true }).count(), 0);

    // 5. Someone who may approve fixes is shown Fixes; the tour in the middle of a reload resumes where it was.
    await c.addUser("tom.tier2", "tier2", true);
    page = await open();
    await c.signInAs(page, "tom.tier2");
    await page.getByRole("button", { name: "Short version" }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Next" }).click();
    const where = (await page.locator("#welcome-title").innerText()).trim();
    await page.reload();
    await page.locator("#welcome-title", { hasText: where }).waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.waitForFunction(async () => (await (await fetch("/api/auth/me")).json()).user.tourCompleted === true);
    assert.equal(await tourCompleted("tom.tier2"), true);
    assert.deepEqual(problems, []);
  } finally {
    simulator.stop();
    await browser.close();
    await c.close();
  }
});
