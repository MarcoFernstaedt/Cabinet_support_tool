// The cabinet's System panel in a real browser: Windows, processor, memory with its meter, the machine and each drive, every figure with
// its age, for a Tier 1 user. The screenshot is written to the scratch folder when CABINET_SYSTEM_SHOT is set.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import { operations } from "../src/contracts.js";
import { startConsole } from "./browser-console.js";
import { launchChromium } from "./browser-launch.js";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";
const GB = 1024 ** 3;

test("a Tier 1 user sees the cabinet's Windows, processor, memory, machine and drives at a glance", { skip, timeout: 120_000 }, async () => {
  const browser = await launchChromium();
  const c = await startConsole(dist);
  const problems: string[] = [];
  try {
    const clientId = randomUUID(), siteId = randomUUID(), k = randomUUID(), userId = randomUUID();
    await c.db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'issuer.e2e', 'Issuer', 'tier1')", [userId]);
    await c.db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour Health')", [clientId]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [siteId, clientId]);
    await c.db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, architecture, last_heartbeat_at) VALUES ($1, $2, 'Pier 1', 'standalone', 'active', 'windows-x64', SYSUTCDATETIME())", [k, siteId]);
    // Contract example answers with the fields under test changed, each checked against the operation's output contract, so the page is
    // shown only what an agent can really send (review of #215).
    const example = (op: string) => JSON.parse(readFileSync(join(dirname(SCHEMA_DIR), "examples", "operations", op, "output", "valid", "typical.json"), "utf8")) as Record<string, unknown>;
    const stored = (op: string, output: unknown) => {
      operations[op as keyof typeof operations]!.output.parse(output);
      return c.db.app.query(
        `INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result, result_at)
         VALUES ($1, $2, $3, '{}', $4, DATEADD(minute, -10, SYSUTCDATETIME()), DATEADD(minute, -5, SYSUTCDATETIME()), 'succeeded', $5, DATEADD(minute, -10, SYSUTCDATETIME()))`,
        [randomUUID(), k, op, userId, JSON.stringify({ status: "succeeded", output })]);
    };
    const hw = example("system.hardware"), perf = example("system.performance");
    await stored("system.hardware", { ...hw, manufacturer: "Dell Inc.", model: "OptiPlex 7090", cpu: { model: "Intel Core i5-10500T", logicalCores: 12 },
      memory: { ...(hw.memory as object), totalBytes: 16 * GB, moduleCount: 2 }, bios: { vendor: "Dell", version: "1.18.0", date: "2023-05-09T00:00:00Z" },
      tpm: { present: true, enabled: true, version: "2.0" }, secureBoot: "on", lastBoot: null });
    await stored("system.info", { ...example("system.info"), osVersion: "Windows 11 IoT Enterprise LTSC 2024", osBuild: "26100.2033", uptimeSeconds: 259_200 });
    await stored("system.performance", { ...perf, memory: { ...(perf.memory as object), totalBytes: 16 * GB, availableBytes: 6 * GB },
      volumes: [{ drive: "C:", label: "OS", fileSystem: "NTFS", sizeBytes: 256 * GB, freeBytes: 20 * GB }, { drive: "D:", label: "Data", fileSystem: "NTFS", sizeBytes: 1024 * GB, freeBytes: 900 * GB }] });
    await c.db.app.query("INSERT INTO health_samples (cabinet_id, [at], cpu_percent, memory_used_percent, disk_free_percent) VALUES ($1, SYSUTCDATETIME(), 17, 62, 8)", [k]);
    await c.addUser("tier1.view", "tier1");
    await c.db.app.query("UPDATE users SET tour_completed = 1 WHERE username = 'tier1.view'"); // the welcome tour is not under test here
    const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
    page.on("pageerror", e => problems.push(`page error: ${e.message}`));
    page.on("console", m => { if (m.type() === "error" && !/status of 401/.test(m.text())) problems.push(m.text()); });
    await c.signInAs(page, "tier1.view");
    await page.goto(`${c.origin}/cabinets/${k}`);
    const panel = page.getByRole("region", { name: "System" });
    await panel.waitFor();
    await panel.getByText("Intel Core i5-10500T").waitFor();
    const text = await panel.innerText();
    for (const expected of ["Windows 11 IoT Enterprise LTSC 2024", "Build 26100.2033", "12 logical cores", "10.0 GB of 16.0 GB", "63% in use", "Up 3 d 0 h · ", "Dell Inc. OptiPlex 7090",
      "BIOS 1.18.0 (2023-05-09)", "TPM 2.0", "Secure Boot on"])
      assert.ok(text.includes(expected), `${expected} in:\n${text}`);
    const c_ = panel.getByRole("row").filter({ hasText: "C:" });
    assert.match(await c_.innerText(), /C:\s*OS\s+92%\s+20\.0 GB\s+256\.0 GB/);
    if (process.env.CABINET_SYSTEM_SHOT) await panel.screenshot({ path: process.env.CABINET_SYSTEM_SHOT });
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await c.close();
  }
});
