// A cancelled fleet job's page goes on following it until the batch it had already sent has finished (fleet audit finding 6, decision-log
// D83). Before, the page stopped refreshing the moment the job said "cancelled", so it showed "Cancelled" over cabinets still marked
// "Sent" until someone reloaded it. The job here is in the state a cancel leaves (cancelled, one cabinet sent, the rest cancelled); the
// runner's own part (follow up, verify, end) is covered in fleet-jobs.test.ts and is played here by two statements.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startConsole } from "./browser-console.js";
import { launchChromium } from "./browser-launch.js";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";

test("a cancelled job says it is finishing what it sent, keeps refreshing, and says Cancelled only once it has ended", { skip, timeout: 120_000 }, async () => {
  const browser = await launchChromium();
  const c = await startConsole(dist);
  try {
    const clientId = randomUUID(), siteId = randomUUID(), jobId = randomUUID(), commandId = randomUUID();
    const cabinets = [randomUUID(), randomUUID(), randomUUID()];
    await c.db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour')", [clientId]);
    await c.db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [siteId, clientId]);
    for (const [i, k] of cabinets.entries())
      await c.db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, $3, 'standalone', 'active')", [k, siteId, `Pier ${i + 1}`]);
    const userId = await c.addUser("job.owner", "tier1");
    await c.db.app.query("UPDATE users SET tour_completed = 1 WHERE id = $1", [userId]);
    await c.db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, bulk_id)
                          VALUES ($1, $2, 'time.sync', '{}', $3, SYSUTCDATETIME(), DATEADD(minute, 2, SYSUTCDATETIME()), 'delivered', $4)`, [commandId, cabinets[0], userId, jobId]);
    await c.db.app.query("INSERT INTO fleet_jobs (id, operation, created_by, batch_size, total, state, cancelled_by) VALUES ($1, 'time.sync', $2, 1, 3, 'cancelled', $2)", [jobId, userId]);
    await c.db.app.query(`INSERT INTO fleet_job_targets (job_id, cabinet_id, [position], params, state, command_id, detail) VALUES
                          ($1, $2, 0, '{}', 'issued', $5, NULL),
                          ($1, $3, 1, '{}', 'cancelled', NULL, 'The job was cancelled before this cabinet was reached.'),
                          ($1, $4, 2, '{}', 'cancelled', NULL, 'The job was cancelled before this cabinet was reached.')`, [jobId, ...cabinets, commandId]);

    const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
    await c.signInAs(page, "job.owner");
    await page.goto(`${c.origin}/fleet-operations/jobs/${jobId}`);
    const status = page.getByRole("status").filter({ hasText: "Cancel" });
    await status.getByText("Cancelling: finishing the cabinet already sent").waitFor();
    assert.equal(await page.getByRole("button", { name: "Cancel the rest" }).count(), 0, "nothing is left to cancel");
    const row = page.getByRole("row").filter({ hasText: "Pier 1" });
    await row.getByText("Sent").waitFor();

    // The runner verifies the cabinet it had sent, then ends the job. The page sees both without a reload.
    await c.db.app.query("UPDATE fleet_job_targets SET state = 'verified', detail = 'Verified: the cabinet''s clock is within two minutes of the server''s.' WHERE job_id = $1 AND cabinet_id = $2", [jobId, cabinets[0]]);
    await row.getByText("Verified", { exact: true }).waitFor({ timeout: 10_000 });
    await status.getByText("Cancelling: ending the job").waitFor({ timeout: 10_000 });
    await c.db.app.query("UPDATE fleet_jobs SET finished_at = SYSUTCDATETIME() WHERE id = $1", [jobId]);
    await status.getByText("Cancelled", { exact: true }).waitFor({ timeout: 10_000 });
    await page.getByText(/Finished at /).waitFor();
  } finally {
    await browser.close();
    await c.close();
  }
});
