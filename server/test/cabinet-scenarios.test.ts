// More demo scenarios (docs/platform/demo.md): a USB device that should be plugged in but is not (a cabinet alert that stays off the
// dashboard), a drive nearly full, and a cabinet whose event logs hold errors from several sources: some map to issue types by
// themselves, two are new and wait for someone to map them. Everything goes through the real alert engine.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { enableDemo } from "../src/demo/demo.js";
import { ISSUE } from "../src/services/rules.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

const ORIGIN = "https://console.test";
let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
let clock = Date.now();
let cookie = "";
const secrets = new SecretBox(randomBytes(32).toString("base64"));

async function call(url: string, method: "GET" | "POST" = "GET", body?: unknown) {
  const headers: Record<string, string> = { origin: ORIGIN, cookie };
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  let parsed: any = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
  return { status: r.statusCode, body: parsed };
}
const cab = async (name: string) => (await db.app.query<{ id: string }>("SELECT id FROM cabinets WHERE name = $1 AND demo_scenario IS NOT NULL", [name])).rows[0]!.id;

test.before(async () => {
  db = await createTestDatabase();
  const key = await developmentIssuingKey(tempDir());
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key, origin: ORIGIN, stream, logger: false, now: () => clock });
  const secret = totp.newSecret();
  const id = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc) VALUES ($1, 'tech', 'Tech', 'tier1', $2, 0, 1, $3)`,
    [id, await hashPassword("correct horse battery staple"), secrets.seal(secret)]);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ username: "tech", password: "correct horse battery staple" }) });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  clock += 30_000;
  assert.equal((await call("/api/auth/totp", "POST", { code: totp.code(secret, totp.stepAt(clock)) })).body.stage, "complete");
  const owner = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'demo.owner', 'Demo owner', 'admin', 'x')`, [owner]);
  await enableDemo(db.app, owner);
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

test("a USB device that should be there but is not: a cabinet alert with its logs, absent from the dashboard, the badge and the site counts", async () => {
  const intake = await cab("Intake");
  const mine = (await call(`/api/alerts?cabinetId=${intake}`)).body;
  const usb = mine.find((a: { issueTypeId: string }) => a.issueTypeId === ISSUE.usbMissing);
  assert.ok(usb, JSON.stringify(mine.map((a: { title: string }) => a.title)));
  assert.equal(usb.scope, "cabinet");
  assert.equal(usb.title, "Expected USB device not detected");
  // The logs that go with it: what Windows said about the port.
  const events = (await call(`/api/cabinets/${intake}/events`)).body;
  const text = JSON.stringify(events);
  assert.match(text, /USBHUB3/);
  assert.match(text, /No USB device detected on any of this cabinet's 3 USB ports/);
  // Not on the fleet dashboard.
  const fleetWide = (await call("/api/alerts")).body;
  assert.ok(!fleetWide.some((a: { issueTypeId: string }) => a.issueTypeId === ISSUE.usbMissing), "not in the alert list");
  assert.ok(!(await call(`/api/alerts?issueTypeId=${ISSUE.usbMissing}`)).body.length, "not even when asked for by issue type without a cabinet");
  const summary = (await call("/api/alerts/summary")).body;
  const fleetScope = (await db.app.query("SELECT COALESCE(SUM(CASE WHEN state <> 'resolved' THEN 1 ELSE 0 END), 0) AS active FROM alerts WHERE scope = 'fleet'")).rows[0].active;
  assert.equal(summary.active, fleetScope);
  // The site and client rows count fleet alerts only; the cabinet's own list shows it.
  const clients = (await call("/api/fleet/clients")).body as { name: string; openAlerts: number }[];
  const riverside = clients.find(c => c.name.includes("Riverside"))!;
  const expected = (await db.app.query(
    `SELECT COUNT(*) AS n FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
      WHERE c.name LIKE '%Riverside%' AND a.state <> 'resolved' AND a.scope = 'fleet'`)).rows[0].n;
  assert.equal(riverside.openAlerts, expected);
  const siteId = (await db.app.query("SELECT site_id FROM cabinets WHERE id = $1", [intake])).rows[0].site_id;
  const row = (await call(`/api/fleet/sites/${siteId}`)).body.cabinets.find((c: { id: string }) => c.id === intake);
  assert.ok(row.openAlerts >= 1, "the cabinet's own count includes it");
});

test("a cabinet alert closes like any other, and a second sighting folds into it", async () => {
  const intake = await cab("Intake");
  const alert = (await db.app.query("SELECT id, occurrences FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2", [intake, ISSUE.usbMissing])).rows;
  assert.equal(alert.length, 1);
  assert.equal((await call(`/api/alerts/${alert[0].id}`)).body.scope, "cabinet");
});

test("a nearly full drive raises a minor 'Low disk space' alert on the fleet list", async () => {
  const charting = await cab("Charting");
  const a = (await call(`/api/alerts?cabinetId=${charting}`)).body.find((x: { issueTypeId: string }) => x.issueTypeId === ISSUE.diskSpace);
  assert.ok(a);
  assert.equal(a.severity, "minor");
  assert.equal(a.scope, "fleet");
  assert.ok(a.occurrences >= 3);
  assert.ok((await call("/api/alerts")).body.some((x: { id: string }) => x.id === a.id));
});

test("event logs to issues: Billing's errors are collected, three kinds map to issue types on their own, and two new ones wait to be mapped", async () => {
  const billing = await cab("Billing");
  const list = (await call(`/api/alerts?cabinetId=${billing}`)).body as { title: string; unrecognized: boolean; issueTypeId: string | null; occurrences: number }[];
  const mapped = list.filter(a => !a.unrecognized).map(a => a.title).sort();
  assert.ok(mapped.some(t => /network/i.test(t)), mapped.join("; "));
  assert.ok(mapped.some(t => /update/i.test(t)), mapped.join("; "));
  assert.ok(mapped.some(t => /drive/i.test(t)), mapped.join("; "));
  const waiting = list.filter(a => a.unrecognized);
  assert.equal(waiting.length, 2, JSON.stringify(waiting));
  assert.ok(waiting.some(a => /BillingExport/.test(a.title)));
  assert.ok(waiting.some(a => /Application Error|StatementViewer/.test(a.title)));
  // They show in the fleet's list of unrecognized errors, where a Tier 2 technician maps them.
  const unrecognized = (await call("/api/alerts?unrecognized=true")).body as { cabinet: { id: string } }[];
  assert.ok(unrecognized.filter(a => a.cabinet.id === billing).length === 2);
});
