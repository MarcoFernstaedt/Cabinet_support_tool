// The approved-applications list against a real SQL Server and the real migration: the columns it names exist, the fleet default and
// each scope's own list are read in one statement, the most specific level wins, a value edited outside the platform is ignored
// rather than half-applied, and only an administrator with a step-up token bound to these exact entries can set one.
//
// Why this test exists: approved-apps.ts is the only file in this feature that needs a live database, so without it the statements
// are unverified text and the migration's own check (at most 32 entries) is never exercised.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";
import { APPS_SET_ACTION, appLevels, normalizeEntries, readLevel, setApprovedApps, type ApprovedApp } from "../src/services/approved-apps.js";
import { paramsHash } from "../src/auth/canonical.js";
import { recordHeartbeat } from "../src/services/cabinets.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { Refused } from "../src/services/errors.js";

const admin = { userId: randomUUID(), role: "admin" };
const tier2 = { userId: randomUUID(), role: "tier2" };
const id = { client: randomUUID(), site: randomUUID(), otherSite: randomUUID(), cabinet: randomUUID(), other: randomUUID() };
const DISPENSER = { key: "app:dispenser", kind: "application", name: "Dispenser", path: "C:\\Program Files\\Dispenser\\dispenser.exe" };
const SPOOLER = { key: "app:spooler", kind: "service", name: "Print Spooler", path: "C:\\Windows\\System32\\spoolsv.exe", serviceName: "Spooler" };

/** The list as the service will hold it: the same normalisation the service applies before it binds the token. */
const canon = (raw: unknown[]): ApprovedApp[] => {
  const one = normalizeEntries(raw);
  assert.equal(one.ok, true, `expected a list: ${JSON.stringify(one)}`);
  return one.ok ? one.entries : [];
};
/** A step-up token for a level's write, bound to exactly the parameters the service will pass on. */
const tokenFor = async (level: "fleet" | "client" | "cabinet", target: string, entries: ApprovedApp[] | null): Promise<string> =>
  issueStepUpToken(db.app, admin.userId, APPS_SET_ACTION[level], level === "fleet" ? "fleet" : target, paramsHash({ level, id: target, entries }));
const set = async (level: "fleet" | "client" | "cabinet", target: string | null, entries: unknown[] | null) =>
  setApprovedApps(db.app, admin, level, target, entries, await tokenFor(level, target ?? "", entries === null ? null : canon(entries)));
/** The service called with a list exactly as it arrived, without the test's own normalisation: for the refusals, which the service
 *  reaches before it looks at the token. */
const setRaw = (level: "fleet" | "client" | "cabinet", target: string | null, entries: unknown[] | null) =>
  setApprovedApps(db.app, admin, level, target, entries, "A".repeat(43));

let db: TestDatabase;

test("approved applications: stored per level, the most specific wins, and what was edited outside the platform is ignored", async t => {
  db = await createTestDatabase();
  t.after(async () => { await db.drop(); });
  await db.app.query(`INSERT INTO users ([id],[username],[name],[role]) VALUES ($1,'apps.owner','Apps Owner','admin'), ($2,'apps.tier2','Apps Tier2','tier2')`, [admin.userId, tier2.userId]);
  await db.app.query(`INSERT INTO clients ([id],[name]) VALUES ($1,$2)`, [id.client, "Test client"]);
  await db.app.query(`INSERT INTO sites ([id],[client_id],[name]) VALUES ($1,$2,$3)`, [id.site, id.client, "Test site"]);
  await db.app.query(`INSERT INTO sites ([id],[client_id],[name]) VALUES ($1,$2,$3)`, [id.otherSite, id.client, "Test site two"]);
  await db.app.query(`INSERT INTO cabinets ([id],[site_id],[name],[role],[status]) VALUES ($1,$2,$3,$4,$5)`, [id.cabinet, id.site, "Test cabinet", "standalone", "active"]);
  await db.app.query(`INSERT INTO cabinets ([id],[site_id],[name],[role],[status]) VALUES ($1,$2,$3,$4,$5)`, [id.other, id.otherSite, "Other cabinet", "sync", "active"]);

  // Nothing set at any level: the capability is inert until the owner approves a program.
  const bare = await appLevels(db.app, id.cabinet);
  assert.equal(bare.source, "none");
  assert.equal(bare.effective, null);
  assert.deepEqual(bare.rejected, []);

  // The fleet default reaches a cabinet that has nothing of its own.
  assert.equal((await set("fleet", null, [DISPENSER]))?.entries.length, 1);
  assert.equal((await readLevel(db.app, "fleet", null))?.version, 1);
  const onFleet = await appLevels(db.app, id.cabinet);
  assert.equal(onFleet.source, "fleet");
  assert.deepEqual(onFleet.effective?.entries.map(e => e.key), ["app:dispenser"]);
  assert.equal(onFleet.effective?.setBy, admin.userId);

  // A client's own list reaches every cabinet below it.
  assert.equal((await set("client", id.client, [SPOOLER]))?.version, 1);
  assert.equal((await appLevels(db.app, id.cabinet)).source, "client");

  // The cabinet's own list wins whole; the other cabinet keeps following the client.
  assert.equal((await set("cabinet", id.cabinet, [DISPENSER, SPOOLER]))?.entries.length, 2);
  const onCabinet = await appLevels(db.app, id.cabinet);
  assert.equal(onCabinet.source, "cabinet");
  assert.deepEqual(onCabinet.effective?.entries.map(e => e.key), ["app:dispenser", "app:spooler"]);
  assert.equal((await appLevels(db.app, id.other)).source, "client");
  // Saving again steps the version up rather than replacing it silently.
  assert.equal((await set("cabinet", id.cabinet, [DISPENSER]))?.version, 2);

  // A value edited outside the platform does not describe its own entries, so the level is not used, the level above applies, and
  // the console is told which level was rejected.
  await asOwner(db, c => c.query(`UPDATE cabinets SET approved_apps = $2 WHERE id = $1`,
    [id.cabinet, JSON.stringify({ version: 9, entries: [DISPENSER], hash: "0".repeat(64), setBy: "someone", setAt: "2026-10-01T00:00:00.000Z" })]));
  const tampered = await appLevels(db.app, id.cabinet);
  assert.equal(tampered.source, "client");
  assert.deepEqual(tampered.rejected, ["cabinet"]);
  assert.deepEqual(tampered.effective?.entries.map(e => e.key), ["app:spooler"]);
  // And values that are JSON objects of the wrong shape are treated the same way, not as a crash.
  await asOwner(db, c => c.query(`UPDATE cabinets SET approved_apps = $2 WHERE id = $1`, [id.cabinet, JSON.stringify({ version: 1, entries: "not a list" })]));
  assert.deepEqual((await appLevels(db.app, id.cabinet)).rejected, ["cabinet"]);
  await asOwner(db, c => c.query(`UPDATE cabinets SET approved_apps = $2 WHERE id = $1`, [id.cabinet, JSON.stringify({ version: 1, entries: [DISPENSER] })]));
  const noHash = await appLevels(db.app, id.cabinet);
  assert.deepEqual(noHash.rejected, ["cabinet"]);
  assert.equal(noHash.effective?.entries[0]?.key, "app:spooler");

  // Removing the cabinet's list hands it back to the level above, which is what entries null means.
  assert.equal(await set("cabinet", id.cabinet, null), null);
  assert.equal((await appLevels(db.app, id.cabinet)).source, "client");
  assert.equal(await readLevel(db.app, "cabinet", id.cabinet), null);

  // The cabinet is told this same list on its heartbeat, by the same statement that records it: the cabinet level was rejected above,
  // so what leaves the server is the resolved list, with the whole path and the service name the broker checks a program against.
  const beat = async () => (await recordHeartbeat(db.app, id.cabinet, { agentVersion: "1.4.2", uptimeSeconds: 100, readOnlyMode: false })).approved;
  assert.deepEqual((await beat()).map(e => e.key), ["app:spooler"]);
  assert.equal((await beat())[0]?.path, "C:\\Windows\\System32\\spoolsv.exe");
  assert.equal((await beat())[0]?.serviceName, "Spooler");
  // With the client's list gone as well, the fleet default is what reaches it; with nothing set anywhere, an empty list, which is
  // what leaves the broker unable to control anything.
  assert.equal(await set("client", id.client, null), null);
  assert.deepEqual((await beat()).map(e => e.key), ["app:dispenser"]);
  assert.equal(await set("fleet", null, null), null);
  assert.deepEqual(await beat(), []);

  // Every write is audited with the keys, never with the paths a second time.
  const rows = (await db.app.query<{ action: string; details: { keys?: string[]; removed?: boolean } }>(`SELECT action, details FROM audit_log WHERE action IN ('settings.apps','client.apps','cabinet.apps') ORDER BY seq`)).rows;
  assert.deepEqual(rows.map(r => r.action), ["settings.apps", "client.apps", "cabinet.apps", "cabinet.apps", "cabinet.apps", "client.apps", "settings.apps"]);
  assert.deepEqual(rows[2]?.details.keys, ["app:dispenser", "app:spooler"]);
  assert.equal(rows[4]?.details.removed, true);
});

test("approved applications: who may set a list, and what the list refuses before it is stored", async t => {
  db = await createTestDatabase();
  t.after(async () => { await db.drop(); });
  await db.app.query(`INSERT INTO users ([id],[username],[name],[role]) VALUES ($1,'apps.owner','Apps Owner','admin'), ($2,'apps.tier2','Apps Tier2','tier2')`, [admin.userId, tier2.userId]);
  await db.app.query(`INSERT INTO clients ([id],[name]) VALUES ($1,$2)`, [id.client, "Test client"]);
  await db.app.query(`INSERT INTO sites ([id],[client_id],[name]) VALUES ($1,$2,$3)`, [id.site, id.client, "Test site"]);
  await db.app.query(`INSERT INTO cabinets ([id],[site_id],[name],[role],[status]) VALUES ($1,$2,$3,$4,$5)`, [id.cabinet, id.site, "Test cabinet", "standalone", "active"]);

  const entries = canon([DISPENSER]);
  const code = async (fn: () => Promise<unknown>): Promise<string> => {
    try { await fn(); return "accepted"; } catch (e) { return e instanceof Refused ? e.code : `threw ${String(e)}`; }
  };

  // A Tier 2 account does not approve programs, and a token issued to someone else is not a token.
  const token = await issueStepUpToken(db.app, admin.userId, APPS_SET_ACTION.cabinet, id.cabinet, paramsHash({ level: "cabinet", id: id.cabinet, entries }));
  assert.equal(await code(() => setApprovedApps(db.app, tier2, "cabinet", id.cabinet, [DISPENSER], token)), "forbidden");
  assert.equal(await code(() => setApprovedApps(db.app, admin, "cabinet", id.cabinet, [DISPENSER], "A".repeat(43))), "step_up_required");
  // A token confirmed for one list does not cover a different one.
  assert.equal(await code(() => setApprovedApps(db.app, admin, "cabinet", id.cabinet, [SPOOLER], token)), "step_up_required");

  // What the list refuses: a hostile path, a service without its name, too many entries, and a scope that is not there.
  assert.equal(await code(() => setRaw("cabinet", id.cabinet, [DISPENSER, DISPENSER])), "invalid_params");
  assert.equal(await code(() => setRaw("cabinet", id.cabinet, [DISPENSER, { ...DISPENSER, key: "app:tool", path: "C:\\Tools\\tool.exe --silent" }])), "invalid_params");
  assert.equal(await code(() => setRaw("cabinet", id.cabinet, Array.from({ length: 33 }, (_, i) => ({ ...DISPENSER, key: `app:tool${i}`, path: `C:\\Tools\\tool${i}.exe` })))), "invalid_params");
  assert.equal(await code(() => setRaw("cabinet", randomUUID(), [DISPENSER])), "not_found");
  // A removed cabinet is not a scope either: its list would have nothing left to describe.
  await db.app.query(`UPDATE cabinets SET status = 'removed' WHERE id = $1`, [id.cabinet]);
  assert.equal(await code(() => setRaw("cabinet", id.cabinet, [DISPENSER])), "not_found");

  // The migration's own check is the second one: a 33-entry list cannot be written even by the owner account, and neither can
  // anything that is not a JSON object.
  await assert.rejects(asOwner(db, c => c.query(`UPDATE cabinets SET approved_apps = $2 WHERE id = $1`,
    [id.cabinet, JSON.stringify({ version: 1, entries: Array.from({ length: 33 }, (_, i) => ({ ...DISPENSER, key: `app:tool${i}`, path: `C:\\Tools\\tool${i}.exe` })), hash: "0".repeat(64), setBy: "x", setAt: "2026-10-01T00:00:00.000Z" })])));
  await assert.rejects(asOwner(db, c => c.query(`UPDATE cabinets SET approved_apps = $2 WHERE id = $1`, [id.cabinet, JSON.stringify("just a string")])));
});
