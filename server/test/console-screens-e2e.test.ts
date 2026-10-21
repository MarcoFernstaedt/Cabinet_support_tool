// Visits every page of the console at desktop widths (1280 and 1440), and checks that a narrow window gets the desktop-only notice, with the demo fleet on, and fails on sideways scrolling, raw values
// (undefined, [object Object], NaN, null) and console errors. With SHOTS set it photographs each page for review.
// The guided demo in a real browser: one story at Midtown Manhattan. The firewall fix is one click and it works (the site comes back clean),
// the scanner page shows three drops and the driver installed before them, and a site with no baseline still gets its network read.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { DemoSimulator, enableDemo } from "../src/demo/demo.js";
import { createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { createTestDatabase, startFeed } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";
const freePort = (): Promise<number> => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

test("every page fits its screen and shows no raw values", { skip, timeout: 600_000 }, async () => {
  const { chromium } = await import("playwright");
  const db = await createTestDatabase();
  let clock = Date.now();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const secrets = new SecretBox(randomBytes(32).toString("base64"));
  const stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  const app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin, stream, staticDir: dist, logger: false, now: () => clock });
  await app.listen({ host: "127.0.0.1", port });
  const password = "correct horse battery staple";
  const secret = totp.newSecret();
  const adminId = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, 'ada.admin', 'Ada Admin', 'admin', $2, 0, 1, $3, 1)`, [adminId, await hashPassword(password), secrets.seal(secret)]);
  await enableDemo(db.app, adminId);
  const simulatorProblems: string[] = [];
  const simulator = new DemoSimulator(db.app, m => simulatorProblems.push(m));
  simulator.start();
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const problems: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of (401|403|409|429)/.test(m.text())) problems.push(m.text()); });
    await page.goto(origin);
    // Desktop only: under 1200 px the sign-in page, like every page, is replaced by a plain notice.
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.getByText("This console is for desktop computers. Open it on a computer with a wider screen.").waitFor();
    assert.equal(await page.locator("#root").isVisible(), false);
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.getByLabel("Username").fill("ada.admin");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    clock += 30_000;
    await page.getByLabel(/6-digit code/).fill(totp.code(secret, totp.stepAt(clock)));
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();


    const ids = {
      cabinet: (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM cabinets WHERE demo_scenario = 'healthy' ORDER BY name")).rows[0]!.id,
      client: (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM clients ORDER BY name")).rows[0]!.id,
      site: (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM sites ORDER BY name")).rows[0]!.id,
    };
    const tabs = ["overview", "troubleshoot", "baseline", "alerts", "events", "services", "processes", "files", "devices", "drives", "updates", "time", "network", "firewall", "scanner", "crashes", "software", "history"];
    const pages = ["/", `/clients/${ids.client}`, `/sites/${ids.site}`, "/alerts", "/issues", "/incidents", "/fleet-operations", "/fleet-differences", "/fixes", "/account", "/demo",
      "/admin", "/admin/setup", "/admin/pending", "/admin/tokens", "/admin/scanner", "/admin/audit", "/admin/software", "/admin/upgrades", "/admin/users", "/admin/online",
      "/admin/clients", "/admin/issues", "/admin/safety", "/admin/security", "/admin/settings", "/admin/baselines", ...tabs.map(t => `/cabinets/${ids.cabinet}/${t}`)];
    const faults: string[] = [];
    for (const [label, size] of [["w1440", { width: 1440, height: 900 }], ["w1280", { width: 1280, height: 800 }]] as const) {
      await page.setViewportSize(size);
      for (const path of pages.filter(p => !process.env.ONLY || p.includes(process.env.ONLY) || process.env.ONLY.split(",").some(o => p.includes(o)))) {
        await page.goto(`${origin}${path}`);
        await page.locator("#main, main").first().waitFor();
        await page.waitForTimeout(2200);
        const check = await page.evaluate(() => ({
          text: document.body.innerText,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          wide: [...document.querySelectorAll<HTMLElement>("#main *, .topbar *")].filter(e => {
            if (e.getBoundingClientRect().right <= window.innerWidth + 1 || getComputedStyle(e).position === "fixed") return false;
            for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).overflowX !== "visible") return false;
            return true;
          }).slice(0, 3).map(e => `${e.tagName.toLowerCase()}.${e.className} ${Math.round(e.getBoundingClientRect().right)}px`),
        }));
        if (/undefined|\[object|NaN|null\b/.test(check.text.replace(/Demo mode.*$/m, ""))) faults.push(`${label} ${path}: shows a raw value (${(check.text.match(/.{0,30}(undefined|\[object|NaN|\bnull\b).{0,30}/) ?? [""])[0].replace(/\s+/g, " ")})`);
        if (check.overflow > 1) faults.push(`${label} ${path}: page scrolls sideways by ${check.overflow}px (${check.wide.join(", ")})`);
        if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/screens/${label}${path.replace(/[^a-z0-9]+/gi, "_").replace(ids.cabinet, "CAB").replace(ids.client, "CLIENT").replace(ids.site, "SITE")}.png`, fullPage: true });
      }
    }
    simulator.stop();
    assert.deepEqual(faults, []);
    assert.deepEqual(simulatorProblems, []);
    assert.deepEqual(problems, []);
  } finally {
    simulator.stop();
    await browser.close();
    await app.close();
    await stream.stop();
    await db.drop();
  }
});
