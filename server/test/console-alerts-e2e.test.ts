// Milestone 4 in a real browser: an unrecognized error is mapped to an issue by Tier 2 and
// approved by an Admin in the console; the next occurrence raises a major alert that reaches
// every signed-in console at once, and only one of them can claim it.
// Runs when the console is built (console/dist); CI builds it.
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
import { approveEnrollment, createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { storeEvents } from "../src/services/events.js";
import { ISSUE } from "../src/services/rules.js";
import { verifyAuditChain, NULL_BINARY } from "../src/db/db.js";
import type { Event } from "../src/contracts.js";
import { createTestDatabase, startFeed } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";
import { launchChromium } from "./browser-launch.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "console", "dist");
const skip = existsSync(join(dist, "index.html")) ? false : "build the console first (console/dist)";
const freePort = (): Promise<number> => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

test("alerts in the console: map an unrecognized error, approve it, and race to claim the major alert it raises", { skip, timeout: 180_000 }, async () => {
  const browser = await launchChromium(); // first, so a browser that will not start leaves nothing running
  const db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  let clock = Date.now();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const secrets = new SecretBox(randomBytes(32).toString("base64"));
  const stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  const app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin, stream, staticDir: dist, logger: false, now: () => clock });
  await app.listen({ host: "127.0.0.1", port });

  const password = "correct horse battery staple";
  const people = [
    { username: "ada.admin", name: "Ada Admin", role: "admin", secret: totp.newSecret() },
    { username: "tess.tier2", name: "Tess Tier2", role: "tier2", secret: totp.newSecret() },
    { username: "sam.support", name: "Sam Support", role: "tier1", secret: totp.newSecret() },
  ] as const;
  const ids: string[] = [];
  for (const p of people) {
    const id = randomUUID();
    ids.push(id);
    await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                        VALUES ($1, $2, $3, $4, $5, 0, $6, $7, 1)`, [id, p.username, p.name, p.role, await hashPassword(password), !!p.secret, p.secret ? secrets.seal(p.secret) : NULL_BINARY]);
  }
  const code = (secret: Buffer): string => { clock += 30_000; return totp.code(secret, totp.stepAt(clock)); };

  const { token } = await createBootstrapToken(db.app, ids[0]!);
  const requestId = await submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: {
    hostname: "CAB-ICU", serialNumber: null, macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 10", agentVersion: "0.4.0" } }, "127.0.0.1");
  const { cabinetId } = await approveEnrollment(db.app, key, requestId, { clientName: "Acme Health", siteName: "North", cabinetName: "ICU cabinet", role: "standalone" }, ids[0]!);
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME()");
  let record = 500;
  const lockError = (): Event => ({ eventId: randomUUID(), kind: "error", occurredAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), severityHint: "minor",
    source: { log: "System", source: "Biometric Lock Driver", eventId: 4242, level: "error", recordId: ++record }, detail: { message: "Fingerprint sensor timed out." } });

  const problems: string[] = [];
  const pages = await Promise.all(people.map(async () => (await browser.newContext()).newPage()));
  const [ada, tess, sam] = pages as [typeof pages[0], typeof pages[0], typeof pages[0]];
  const shot = async (p: typeof ada, name: string) => { if (process.env.E2E_SCREENSHOTS) await p.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}.png`), fullPage: true }); };
  const a11y = async (p: typeof ada, where: string) => {
    assert.equal(await p.locator("h1").count(), 1, `${where}: one main heading`);
    const unnamed = await p.$$eval("button", bs => bs.filter(b => !(b.textContent ?? "").trim() && !b.getAttribute("aria-label")).length);
    assert.equal(unnamed, 0, `${where}: every button has a name`);
  };
  try {
    for (const [i, p] of pages.entries()) {
      p.on("pageerror", e => problems.push(`${people[i]!.username} page error: ${e.message}`));
      p.on("console", m => { if (m.type() === "error" && !m.text().includes("status of 401") && !m.text().includes("status of 409")) problems.push(`${people[i]!.username}: ${m.text()}`); });
      await p.goto(origin);
      await p.getByLabel("Username").fill(people[i]!.username);
      await p.getByLabel("Password").fill(password);
      await p.getByRole("button", { name: "Sign in" }).click();
      const secret = people[i]!.secret;
      if (secret) { await p.getByLabel(/6-digit code/).fill(code(secret)); await p.getByRole("button", { name: "Continue" }).click(); }
      await p.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();
    }

    // ---- An error nobody recognizes yet --------------------------------------------
    await storeEvents(db.app, cabinetId, { events: [lockError()] });
    await tess.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Alerts/ }).click();
    await tess.getByRole("button", { name: "Unrecognized errors" }).click();
    const row = tess.locator(".alert-row").filter({ hasText: "Biometric Lock Driver event 4242" });
    await row.waitFor();
    await a11y(tess, "unrecognized errors");
    await shot(tess, "m4-1-unrecognized");
    await row.getByRole("button", { name: "Map to issue" }).click();

    // ---- Tier 2 maps it (without regrouping, so the next occurrence is the first major alert) ----
    const dialog = tess.getByRole("dialog", { name: "Map to issue" });
    await dialog.getByRole("combobox", { name: "Issue" }).selectOption({ label: "Fingerprint scanner problem (major)" });
    await dialog.getByText(/would have matched 1 event on 1 cabinet/).waitFor();
    await dialog.getByRole("checkbox", { name: /Regroup/ }).uncheck();
    await dialog.getByLabel("Authenticator code").fill(code(people[1].secret));
    await shot(tess, "m4-2-map-to-issue");
    await dialog.getByRole("button", { name: "Send for approval" }).click();
    await dialog.getByText(/waiting for an Admin to approve it/).waitFor();
    await dialog.getByRole("button", { name: "Close" }).click();

    // ---- An Admin approves it in the Issues area ---------------------------------------
    await ada.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Issues" }).click();
    await ada.getByRole("heading", { name: "Issues", level: 1 }).waitFor();
    const proposal = ada.locator(".alert-row").filter({ hasText: "event ID 4242" });
    await proposal.waitFor();
    await a11y(ada, "issues");
    await shot(ada, "m4-3-proposal");
    await proposal.getByRole("button", { name: "Approve" }).click();
    const confirm = ada.getByRole("dialog", { name: "Confirm with your authenticator" });
    await confirm.getByLabel("Authenticator code").fill(code(people[0].secret));
    await confirm.getByRole("button", { name: "Confirm" }).click();
    await confirm.waitFor({ state: "hidden" });
    await ada.getByText("No rules are waiting for approval.").waitFor();
    for (const p of pages) await p.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Fleet", exact: true }).click();

    // ---- The next occurrence raises Fingerprint scanner problem, on every console at once ----
    await storeEvents(db.app, cabinetId, { events: [lockError()] });
    const toasts = pages.map(p => p.getByRole("complementary", { name: "New major alerts" }));
    for (const t of toasts) await t.getByText("Fingerprint scanner problem").waitFor({ timeout: 15_000 });
    for (const p of pages) await p.locator(".alerts-link .count").filter({ hasText: "1" }).waitFor();
    await shot(sam, "m4-4-major-alert");

    // All three click Claim at once: one opens the cabinet, the others are told who has it, either by the
    // server refusing their claim or by the live stream removing their button before they could press it.
    await Promise.all(toasts.map(t => t.getByRole("button", { name: "Claim and open cabinet" }).click({ timeout: 3000 }).catch(() => undefined)));
    const opened = await Promise.all(pages.map(p => p.getByRole("heading", { name: "ICU cabinet", level: 1 }).waitFor({ timeout: 5000 }).then(() => true, () => false)));
    assert.equal(opened.filter(Boolean).length, 1, "exactly one console claimed it");
    const winner = people[opened.indexOf(true)]!;
    for (const i of pages.keys()) if (!opened[i]) await toasts[i]!.getByText(`Claimed by ${winner.name}`).waitFor();
    const claimed = (await db.app.query<{ state: string; claimed_by: string }>("SELECT state, claimed_by FROM alerts WHERE issue_type_id = $1", [ISSUE.scanner])).rows;
    assert.deepEqual(claimed, [{ state: "claimed", claimed_by: ids[opened.indexOf(true)] }]);

    // The winner resolves it from the cabinet's alerts section.
    const w = pages[opened.indexOf(true)]!;
    await w.getByRole("heading", { name: "Alerts", level: 2 }).waitFor();
    await a11y(w, "cabinet alerts");
    await w.getByRole("button", { name: "Resolve…" }).first().click();
    await w.getByLabel("What fixed it (optional)").fill("Reseated the scanner on the rear USB port.");
    await w.getByRole("button", { name: "Resolve", exact: true }).click();
    await w.getByText("No open alerts.").waitFor({ timeout: 10_000 }).catch(async () => {
      // The unrecognized alert (not regrouped) is still open on this cabinet; the scanner one must be gone.
      assert.equal(await w.locator(".alert-row").filter({ hasText: "Fingerprint scanner problem" }).count(), 0);
    });
    await shot(w, "m4-5-resolved");
    assert.equal((await db.app.query("SELECT state FROM alerts WHERE issue_type_id = $1", [ISSUE.scanner])).rows[0].state, "resolved");

    // ---- Where alerts show: a drive's early warning is minor (cabinet only); a bad block makes it major (everywhere) ----
    const warn = (eventId: number, level: "warning" | "error", message: string): Event => ({ eventId: randomUUID(), kind: "error",
      occurredAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), severityHint: "minor",
      source: { log: "System", source: "disk", eventId, level, recordId: ++record }, detail: { message } });
    await storeEvents(db.app, cabinetId, { events: [warn(153, "warning", "The IO operation at logical block address 0x1f was retried.")] });
    await tess.goto(`${origin}/alerts`);
    await tess.getByRole("heading", { name: "Alerts", level: 1 }).waitFor();
    assert.equal(await tess.locator(".alert-row").filter({ hasText: "Drive failing" }).count(), 0, "a minor alert is not on the Alerts tab");
    await tess.goto(`${origin}/cabinets/${cabinetId}/alerts`);
    await tess.locator(".alert-row").filter({ hasText: "Drive failing" }).waitFor();
    await shot(tess, "m4-6-minor-on-cabinet");
    await tess.goto(`${origin}/alerts`);
    await tess.getByRole("heading", { name: "Alerts", level: 1 }).waitFor();
    for (let i = 0; i < 50 && (await stream.count) < 3; i++) await new Promise(r => setTimeout(r, 100)); // every console's live stream is connected again
    await storeEvents(db.app, cabinetId, { events: [warn(7, "error", "The device, \\Device\\Harddisk0\\DR0, has a bad block.")] });
    await tess.getByRole("complementary", { name: "New major alerts" }).getByText("Drive failing").waitFor({ timeout: 15_000 });
    await tess.locator(".alert-row").filter({ hasText: "Drive failing" }).waitFor({ timeout: 15_000 });
    await shot(tess, "m4-7-major-on-alerts-tab");

    // ---- The offline filter -----------------------------------------------------------
    await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(day, -6, SYSUTCDATETIME())");
    await sam.goto(`${origin}/alerts?view=offline`);
    await sam.getByRole("link", { name: "Acme Health" }).click();
    await sam.getByRole("link", { name: "North" }).click();
    await sam.getByRole("link", { name: "ICU cabinet" }).waitFor();
    await sam.getByText("Past the threshold").waitFor();
    await a11y(sam, "offline");

    assert.equal((await verifyAuditChain(db.app)).ok, true);
    assert.deepEqual(problems, [], "no errors in the browsers");
  } catch (e) {
    console.error("Browser problems:\n" + problems.join("\n"));
    if (process.env.E2E_SCREENSHOT) for (const [i, p] of pages.entries()) await p.screenshot({ path: `${process.env.E2E_SCREENSHOT}-${i}.png`, fullPage: true }).catch(() => undefined);
    throw e;
  } finally {
    await browser.close();
    await app.close();
    await stream.stop();
    await db.drop();
  }
});
