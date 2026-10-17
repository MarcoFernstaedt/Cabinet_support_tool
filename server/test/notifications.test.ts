// The notification feed on SQL Server (replaces LISTEN/NOTIFY): triggers write rows for new commands, command results and alert
// changes; the feed hands them to the command notifier and to the consoles' live stream.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SessionUser } from "../src/auth/sessions.js";
import { CommandNotifier } from "../src/agent-api/notifier.js";
import { ResultStream } from "../src/console-api/stream.js";
import { claimAlert, resolveAlert, upsertAlert } from "../src/services/alerts.js";
import { notify } from "../src/db/db.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let feed: NotificationFeed;
const ids = { client: randomUUID(), site: randomUUID(), cabinet: randomUUID(), other: randomUUID(), admin: randomUUID(), tier1: randomUUID() };
const received: Record<string, string[]> = {};
const MAJOR_ISSUE = "00000000-0000-4000-8000-000000000102";

const waitFor = async (what: string, ok: () => boolean, ms = 5_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 20))) if (ok()) return;
  assert.fail(`timed out waiting for ${what}`);
};

test.before(async () => {
  db = await createTestDatabase();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Acme')", [ids.client]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'North')", [ids.site, ids.client]);
  for (const [id, name] of [[ids.cabinet, "One"], [ids.other, "Two"]] as const)
    await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, $3, 'standalone', 'active')", [id, ids.site, name]);
  await db.app.query("INSERT INTO users (id, username, name, role, password_hash) VALUES ($1, 'admin', 'Admin', 'admin', 'x'), ($2, 'tier1', 'Tier One', 'tier1', 'x')", [ids.admin, ids.tier1]);
  // The test brings its own issue type, so it does not depend on seed data.
  await asOwner(db, c => c.query("IF NOT EXISTS (SELECT 1 FROM issue_types WHERE id = $1) INSERT INTO issue_types (id, name, severity, description, built_in) VALUES ($1, 'Drive', 'major', 'x', 1)", [MAJOR_ISSUE]));
  feed = new NotificationFeed(db.app, 25);
  for (const channel of ["cabinet_commands", "command_results", "alerts", "custom"]) {
    received[channel] = [];
    feed.on(channel, payload => received[channel]!.push(payload));
  }
  await feed.start();
});
test.after(async () => { feed.stop(); await db.drop(); });

const insertCommand = async (cabinetId: string, issuedBy: string): Promise<string> => {
  const id = randomUUID();
  await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status)
                      VALUES ($1, $2, 'system.info', '{}', $3, SYSUTCDATETIME(), DATEADD(minute, 5, SYSUTCDATETIME()), 'queued')`, [id, cabinetId, issuedBy]);
  return id;
};

test("a new command wakes the feed with its cabinet", async () => {
  await insertCommand(ids.cabinet, ids.tier1);
  await waitFor("cabinet_commands", () => received.cabinet_commands!.includes(ids.cabinet));
});

test("a command result is announced once, with the command and the person who issued it", async () => {
  const id = await insertCommand(ids.cabinet, ids.tier1);
  await db.app.query("UPDATE commands SET status = 'delivered', delivered_at = SYSUTCDATETIME() WHERE id = $1", [id]);
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!received.command_results!.some(p => p.startsWith(id)), "delivery is not a result");
  await db.app.query("UPDATE commands SET status = 'succeeded', result = '{\"ok\":true}', result_at = SYSUTCDATETIME() WHERE id = $1", [id]);
  await waitFor("command_results", () => received.command_results!.includes(`${id} ${ids.tier1}`));
  await db.app.query("UPDATE commands SET result_at = SYSUTCDATETIME(), result = '{\"ok\":false}' WHERE id = $1", [id]);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(received.command_results!.filter(p => p.startsWith(id)).length, 1, "a second write of the result does not announce again");
});

test("alert changes are announced: created, claimed, resolved; a repeat is not; a minor alert that turns major is", async () => {
  const sig = `test:${randomUUID()}`;
  const base = { cabinetId: ids.cabinet, issueTypeId: MAJOR_ISSUE, signature: sig, title: "Drive", seenAt: new Date(), ruleId: null, eventId: null };
  const a = await upsertAlert(db.app, { ...base, severity: "minor" });
  assert.equal(a.created, true);
  await waitFor("created", () => received.alerts!.includes(`${a.id} created`));
  const repeat = await upsertAlert(db.app, { ...base, severity: "minor" });
  assert.deepEqual([repeat.id, repeat.created], [a.id, false]);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(received.alerts!.filter(p => p === `${a.id} created`).length, 1, "a repeat is not announced");
  await upsertAlert(db.app, { ...base, severity: "major" });
  await waitFor("major again", () => received.alerts!.filter(p => p === `${a.id} created`).length === 2);

  await claimAlert(db.app, ids.tier1, a.id);
  await waitFor("claimed", () => received.alerts!.includes(`${a.id} claimed`));
  await resolveAlert(db.app, { userId: ids.tier1, role: "tier1" }, a.id, "done");
  await waitFor("resolved", () => received.alerts!.includes(`${a.id} resolved`));
});

test("notify() writes a row the feed delivers, and a long payload is cut to the column", async () => {
  await db.app.transaction(tx => notify(tx, "custom", "x".repeat(900)));
  await waitFor("custom", () => received.custom!.length === 1);
  assert.equal(received.custom![0]!.length, 450);
});

test("the feed starts after the newest row: a restart does not replay old notifications", async () => {
  const late: string[] = [];
  const f = new NotificationFeed(db.app, 25);
  f.on("cabinet_commands", p => late.push(p));
  await f.start();
  await new Promise(r => setTimeout(r, 150));
  assert.equal(late.length, 0);
  await insertCommand(ids.other, ids.tier1);
  await waitFor("new row", () => late.includes(ids.other));
  f.stop();
  assert.equal(f.running, false);
});

test("a handler that throws does not stop the others", async () => {
  const f = new NotificationFeed(db.app, 25);
  const got: string[] = [];
  f.on("custom", () => { throw new Error("boom"); });
  f.on("custom", p => got.push(p));
  await f.start();
  await db.app.transaction(tx => notify(tx, "custom", "hello"));
  await waitFor("second handler", () => got.includes("hello"));
  f.stop();
});

// ---- The command notifier ------------------------------------------------------------------

test("the notifier wakes a waiting long poll when a command is inserted for its cabinet, and not for another", async () => {
  const notifier = new CommandNotifier(feed);
  assert.equal(notifier.listening, false, "not listening before start");
  await notifier.start();
  assert.equal(notifier.listening, true);
  const abort = new AbortController();
  const mark = notifier.mark(ids.cabinet);
  const started = Date.now();
  const waiting = notifier.wait(ids.cabinet, 10_000, abort.signal, mark);
  assert.equal(notifier.waiting, 1);
  await insertCommand(ids.other, ids.tier1);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(notifier.waiting, 1, "another cabinet's command does not wake it");
  await insertCommand(ids.cabinet, ids.tier1);
  await waiting;
  assert.ok(Date.now() - started < 5_000);
  assert.equal(notifier.waiting, 0);
  assert.notEqual(notifier.mark(ids.cabinet), mark);
  // A wake between the database check and the wait is not lost.
  await notifier.wait(ids.cabinet, 10_000, abort.signal, mark);
  // The timeout and an abort both end a wait.
  await notifier.wait(ids.cabinet, 20, abort.signal);
  const aborting = notifier.wait(ids.cabinet, 10_000, abort.signal);
  abort.abort();
  await aborting;
  await notifier.stop();
  assert.equal(notifier.listening, false);
});

test("the notifier reports it is not listening while the feed is stopped (long polls then re-check the database)", async () => {
  const f = new NotificationFeed(db.app, 25);
  const notifier = new CommandNotifier(f);
  await notifier.start();
  assert.equal(notifier.listening, false);
  await f.start();
  assert.equal(notifier.listening, true);
  f.stop();
  assert.equal(notifier.listening, false);
  await notifier.stop();
});

// ---- The live stream -----------------------------------------------------------------------

function fakeConnection() {
  const written: string[] = [];
  const raw = Object.assign(new EventEmitter(), {
    destroyed: false, socket: { destroyed: false }, written,
    writeHead() { return this; }, write(s: string) { written.push(s); return true; }, end() { (raw as { ended: boolean }).ended = true; }, ended: false,
  });
  return { raw, request: { raw } as unknown as FastifyRequest, reply: { raw } as unknown as FastifyReply, written };
}
const user = (userId: string, role: SessionUser["role"]) => ({ userId, role, stage: "complete" }) as unknown as SessionUser;

test("the live stream carries a user's own command results, every major alert, and security alerts to Admins only", async () => {
  const stream = new ResultStream(feed, db.app);
  await stream.start();
  const admin = fakeConnection(), tier1 = fakeConnection();
  stream.attach(user(ids.admin, "admin"), admin.request, admin.reply, async () => user(ids.admin, "admin"));
  stream.attach(user(ids.tier1, "tier1"), tier1.request, tier1.reply, async () => user(ids.tier1, "tier1"));
  assert.equal(stream.count, 2);

  const id = await insertCommand(ids.cabinet, ids.tier1);
  await db.app.query("UPDATE commands SET status = 'succeeded', result = '{}', result_at = SYSUTCDATETIME() WHERE id = $1", [id]);
  await waitFor("result to the issuer", () => tier1.written.some(w => w.startsWith("event: result") && w.includes(id)));
  assert.ok(!admin.written.some(w => w.includes(id)), "someone else's result is not sent");

  const major = await upsertAlert(db.app, { cabinetId: ids.cabinet, issueTypeId: MAJOR_ISSUE, severity: "major", signature: `s:${randomUUID()}`, title: "Big", seenAt: new Date(), ruleId: null, eventId: null });
  const minor = await upsertAlert(db.app, { cabinetId: ids.cabinet, issueTypeId: MAJOR_ISSUE, severity: "minor", signature: `s:${randomUUID()}`, title: "Small", seenAt: new Date(), ruleId: null, eventId: null });
  await waitFor("major alert to everyone", () => [admin, tier1].every(c => c.written.some(w => w.startsWith("event: alert") && w.includes(major.id))));
  await claimAlert(db.app, ids.tier1, minor.id);
  await waitFor("a claim of a minor alert", () => admin.written.some(w => w.includes(minor.id) && w.includes('"change":"claimed"')));
  assert.ok(!admin.written.some(w => w.includes(minor.id) && w.includes('"change":"created"')), "a new minor alert is not pushed");

  await db.app.transaction(tx => notify(tx, "security_alerts", JSON.stringify({ id: "sa1", created: true, kind: "failed_logins", title: "Many failed sign-ins" })));
  await db.app.transaction(tx => notify(tx, "security_alerts", "not json"));
  await db.app.transaction(tx => notify(tx, "security_alerts", JSON.stringify({ id: 5 })));
  await waitFor("security alert to the admin", () => admin.written.some(w => w.startsWith("event: security") && w.includes("Many failed sign-ins")));
  assert.ok(!tier1.written.some(w => w.startsWith("event: security")), "Tier 1 is not told about security alerts");

  admin.raw.emit("close");
  assert.equal(stream.count, 1);
  await stream.stop();
  assert.equal(stream.count, 0);
  assert.equal(tier1.raw.ended, true);
});
