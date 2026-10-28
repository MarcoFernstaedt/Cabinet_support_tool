// The support actions, clicked through in a real browser against the simulated fleet: each shows its confirmation, runs, and reports what
// the cabinet answered; what the simulated cabinet keeps (power settings, the drawer address) reads back changed.
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

test("restart, end a process, power settings, DHCP release, a static address with no gateway and the drawer address all work from the console", { skip, timeout: 600_000 }, async () => {
  const { chromium } = await import("playwright");
  const c = await startConsole(dist);
  const simulator = new DemoSimulator(c.db.app, () => {});
  simulator.start();
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  try {
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409|429)/.test(m.text())) problems.push(m.text()); });
    await c.signIn(page);
    await c.startDemo(page);
    const id = async (name: string) => (await c.db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE name = $1", [name])).rows[0]!.id;
    const midtown = await id("Midtown Sync");
    const panel = (title: string) => page.locator("section.panel", { has: page.getByRole("heading", { name: title, exact: true }) });

    // Power settings: read, turn USB power saving off, read again and see it off.
    await page.goto(`${c.origin}/cabinets/${midtown}/windows`);
    const power = panel("Power settings");
    await power.getByRole("button", { name: "Run", exact: true }).click();
    await power.getByText("USB selective suspend").waitFor();
    await power.locator("dl.kv > div", { has: page.locator("dt", { hasText: "USB selective suspend" }) }).getByRole("button", { name: "Turn off" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Make the change" }).click();
    await power.getByText("USB selective suspend is now off.").waitFor({ timeout: 30_000 });
    await power.getByRole("button", { name: "Run again" }).click();
    await power.locator("dl.kv > div", { has: page.locator("dt", { hasText: "USB selective suspend" }) }).getByText("Off", { exact: true }).first().waitFor({ timeout: 30_000 });

    // The health check, a read.
    await panel("Windows health check").getByRole("button", { name: "Run", exact: true }).click();
    await panel("Windows health check").getByText("Healthy").waitFor({ timeout: 30_000 });

    // Restart in five minutes with a message: needs an authenticator code, then reports the time.
    const restart = panel("Restart or shut down");
    assert.equal(await restart.getByRole("option", { name: "Shut down" }).count(), 1, "an Admin may shut a cabinet down");
    await restart.getByLabel("Message (optional)").fill("Restarting to finish updates.");
    await restart.getByRole("button", { name: "Review" }).click();
    await page.getByRole("dialog").getByText("Message on its screen").waitFor();
    await c.confirmWithCode(page);
    await restart.getByText(/Restart scheduled for/).waitFor({ timeout: 30_000 });
    await restart.getByRole("button", { name: "Cancel a waiting restart" }).click();
    await c.confirmWithCode(page);
    await restart.getByText("The waiting restart was cancelled.").waitFor({ timeout: 30_000 });

    // End a process from the process list.
    await page.goto(`${c.origin}/cabinets/${midtown}/processes`);
    const end = page.getByRole("button", { name: /^End / }).first();
    await end.waitFor({ timeout: 30_000 });
    const label = (await end.getAttribute("aria-label"))!;
    await end.click();
    await c.confirmWithCode(page);
    await page.getByText(/^Ended .*\.$/).waitFor({ timeout: 30_000 });
    assert.match(label, /^End .+ \(\d+\)$/);

    // Network: release and renew a lease, then a static address with no gateway.
    await page.goto(`${c.origin}/cabinets/${midtown}/network`);
    await page.getByRole("button", { name: "Diagnose network" }).waitFor();
    const readAdapters = page.getByRole("button", { name: /^(Read the adapters|Run|Read)/ }).first();
    if (await readAdapters.count()) await readAdapters.click().catch(() => {});
    const release = page.getByRole("button", { name: "Release and renew" }).first();
    await release.waitFor({ timeout: 60_000 });
    await release.click();
    await page.getByRole("dialog").getByText(/Give back the current lease/).waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Make the change" }).click();
    await page.getByText(/Lease renewed|The DHCP server|lease/i).first().waitFor({ timeout: 30_000 });

    await page.getByRole("button", { name: "Edit IP settings" }).first().click();
    await page.getByLabel("Static", { exact: false }).first().check();
    await page.getByLabel("IPv4 address").fill("172.20.1.10");
    await page.getByLabel("Gateway (leave empty when there is no router)").fill("");
    await page.getByRole("button", { name: "Review the change" }).click();
    await page.getByRole("dialog").getByText("none", { exact: true }).first().waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).or(page.getByRole("dialog").getByRole("button", { name: "Cancel" })).first().click();

    // The drawer address, on the cabinet that has the drawer: the check finds what is off, the form sets it.
    const pharmacy = await id("Pharmacy Sync");
    // This drawer starts out right; make it the kind Windows gave itself an address on, as after a new drawer or a replaced adapter.
    await c.db.app.query("INSERT INTO settings ([key], [value]) VALUES ($1, '\"unset\"')", [`demo.drawer:${pharmacy}`]);
    await page.goto(`${c.origin}/cabinets/${pharmacy}/network`);
    await page.getByRole("button", { name: "Check drawer" }).click();
    const form = page.getByRole("form", { name: "Set the drawer address" });
    await form.waitFor({ timeout: 60_000 });
    // Nothing to type: every drawer adapter has the one standard address.
    await form.getByRole("button", { name: "Set the drawer address (172.20.1.0)" }).click();
    await page.getByRole("dialog").getByText("172.20.1.0/32").waitFor();
    await c.confirmWithCode(page);
    await page.getByRole("row", { name: /^IPv4/ }).getByText(/172\.20\.1\.0\/32, the drawer address/).waitFor({ timeout: 60_000 });
    await page.getByRole("row", { name: /^Gateway/ }).getByText(/None, as it should be/).waitFor();

    assert.deepEqual(problems, []);
  } catch (e) {
    // What the person would have been looking at when it failed.
    throw new Error(`${(e as Error).message}\nPage: ${page.url()}\n${(await page.locator("main").innerText().catch(() => "")).slice(-1800)}\nDrawer: ${await page.locator("[data-tour=drawer-check]").innerText().catch(() => "(none)")}\nDialogs: ${(await page.locator("[role=dialog], [role=alert]").allInnerTexts().catch(() => [])).join(" | ")}\nProblems: ${problems.join(" | ")}`);
  } finally {
    simulator.stop();
    await browser.close();
    await c.close();
  }
});
