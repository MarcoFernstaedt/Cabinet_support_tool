// The time zone and clock alerts time.ts opened and closed itself, moved into alerts.ts, the table's owner (F21.R2, decision-log D106).
// A condition is named by its caller and its SQL comes from cabinet-conditions.ts; alerts.ts opens one minor alert per active cabinet in
// scope heard from recently, folds repeats into it, and closes it once the condition is gone, each close audited. What it is given is
// checked before the database is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { foldCabinetCondition } from "../src/services/alerts.js";
import { ISSUE } from "../src/services/rules.js";
import type { Queryable } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db?.drop(); });

const BOTH = { open: true, close: true };

/** A client with one site in Eastern time, and its cabinets: [name, zone, clock skew, minutes since heard from]. */
async function site(cabinets: [string, string, number, number][]): Promise<{ site: string; client: string; ids: string[] }> {
  const client = randomUUID(), s = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name, time_zone) VALUES ($1, $2, 'S', 'Eastern Standard Time')", [s, client]);
  const ids: string[] = [];
  for (const [name, zone, skew, ago] of cabinets) {
    const k = randomUUID();
    await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, time_zone_id, clock_skew_seconds, last_heartbeat_at)
      VALUES ($1, $2, $3, 'standalone', 'active', $4, $5, DATEADD(minute, -$6, SYSUTCDATETIME()))`, [k, s, name, zone, skew, ago]);
    ids.push(k);
  }
  return { site: s, client, ids };
}
const open = async (k: string, issue: string) => (await db.app.query<{ id: string; severity: string; occurrences: number }>(
  "SELECT id, severity, occurrences FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'", [k, issue])).rows;
const resolvedAudits = async (ids: string[]) => (await db.app.query<{ actor_id: string; details: Record<string, unknown> }>(
  "SELECT actor_id, details FROM audit_log WHERE action = 'alert.resolve' AND target_id IN (SELECT LOWER(value) FROM OPENJSON($1))", [JSON.stringify(ids)])).rows;
// A connection that fails the test if it is used: a refusal has to come from the check, not from the database.
const untouched: Queryable = { query: async () => { throw new Error("a value the check refuses reached the database"); } };

test("a wrong zone opens one minor alert per cabinet in scope heard from recently, and closes it, audited, once it is right", async () => {
  const p = await site([["WRONG", "Pacific Standard Time", 0, 1], ["RIGHT", "Eastern Standard Time", 0, 1], ["QUIET", "Pacific Standard Time", 0, 60]]);
  const elsewhere = await site([["OTHER", "Pacific Standard Time", 0, 1]]);
  const r = await foldCabinetCondition(db.app, "timeZone", { siteId: p.site }, BOTH);
  assert.deepEqual(r, { opened: 1, resolved: 0 });
  const [wrong, right, quiet] = p.ids;
  assert.equal((await open(wrong!, ISSUE.timeZone)).length, 1);
  assert.equal((await open(wrong!, ISSUE.timeZone))[0]!.severity, "minor", "the cabinet's own alert, minor");
  assert.equal((await open(right!, ISSUE.timeZone)).length, 0);
  assert.equal((await open(quiet!, ISSUE.timeZone)).length, 0, "a cabinet not heard from in the offline window is not judged");
  assert.equal((await open(elsewhere.ids[0]!, ISSUE.timeZone)).length, 0, "another site is out of scope");
  // Again: the open alert is kept, not doubled.
  assert.deepEqual(await foldCabinetCondition(db.app, "timeZone", { cabinetId: wrong! }, BOTH), { opened: 0, resolved: 0 });
  assert.equal((await open(wrong!, ISSUE.timeZone)).length, 1);
  const alertId = (await open(wrong!, ISSUE.timeZone))[0]!.id;
  // Put right: the alert closes and the close is audited by the time check.
  await db.app.query("UPDATE cabinets SET time_zone_id = 'Eastern Standard Time' WHERE id = $1", [wrong]);
  assert.deepEqual(await foldCabinetCondition(db.app, "timeZone", { clientId: p.client }, BOTH), { opened: 0, resolved: 1 });
  assert.equal((await open(wrong!, ISSUE.timeZone)).length, 0);
  const audits = await resolvedAudits([alertId]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.actor_id, "time-check");
  assert.equal(audits[0]!.details.resolution, "The cabinet is in its site's time zone again.");
});

test("a clock off by more than two minutes opens the clock alert, not the zone's; only what the caller asks for runs", async () => {
  const p = await site([["SKEWED", "Eastern Standard Time", 300, 1], ["CLOSE", "Eastern Standard Time", 119, 1]]);
  const [skewed, close] = p.ids;
  // Asked only to close: nothing opens.
  assert.deepEqual(await foldCabinetCondition(db.app, "clock", { siteId: p.site }, { open: false, close: true }), { opened: 0, resolved: 0 });
  assert.equal((await open(skewed!, ISSUE.clock)).length, 0);
  assert.deepEqual(await foldCabinetCondition(db.app, "clock", "all", { open: true, close: false }), { opened: 1, resolved: 0 }, "fleet-wide, only this new cabinet is skewed");
  assert.equal((await open(skewed!, ISSUE.clock)).length, 1);
  assert.equal((await open(close!, ISSUE.clock)).length, 0, "119 seconds is within the tolerance");
  assert.equal((await open(skewed!, ISSUE.timeZone)).length, 0);
  // Retired: an alert of a cabinet no longer active closes.
  await db.app.query("UPDATE cabinets SET status = 'removed' WHERE id = $1", [skewed]);
  assert.deepEqual(await foldCabinetCondition(db.app, "clock", { siteId: p.site }, { open: false, close: true }), { opened: 0, resolved: 1 });
});

test("a fold in a transaction that rolls back leaves no alert", async () => {
  const p = await site([["WRONG", "Pacific Standard Time", 0, 1]]);
  await assert.rejects(db.app.transaction(async tx => {
    assert.equal((await foldCabinetCondition(tx, "timeZone", { cabinetId: p.ids[0]! }, BOTH)).opened, 1);
    throw new Error("rolled back");
  }), /rolled back/);
  assert.equal((await open(p.ids[0]!, ISSUE.timeZone)).length, 0);
});

test("anything but a known condition, a scope by id or all, and what to run is refused before the database is touched", async () => {
  const id = randomUUID();
  let refused = 0;
  const refuse = async (p: Promise<unknown>, why: RegExp, what: string) => {
    await assert.rejects(p, (e: Error) => why.test(e.message), what); refused++;
  };
  // Not a name it knows: unknown, inherited from Object, a SQL fragment, other case, not a string.
  for (const n of [undefined, null, "", "firewallPolicy", "toString", "__proto__", "constructor", "1 = 1", "TIMEZONE", 3])
    await refuse(foldCabinetCondition(untouched, n as never, "all", BOTH), /not a cabinet condition/, `name ${String(n)}`);
  for (const s of [undefined, null, "", "ALL", {}, { cabinetId: "x" }, { siteId: `${id}'; DROP TABLE alerts; --` }, { clientId: 7 }, { other: id }, [id]])
    await refuse(foldCabinetCondition(untouched, "clock", s as never, BOTH), /scope is one cabinet, site or client/, `scope ${JSON.stringify(s)}`);
  for (const r of [undefined, null, {}, { open: true }, { open: "yes", close: true }, { open: true, close: 1 }, "both"])
    await refuse(foldCabinetCondition(untouched, "clock", { cabinetId: id }, r as never), /whether to open and whether to close/, `run ${JSON.stringify(r)}`);
  // The firewall condition is judged against the fleet's policy, each of the three profiles on or off.
  for (const v of [undefined, null, {}, { fleetPolicy: null }, { fleetPolicy: { domain: "on", private: "on" } }, { fleetPolicy: { domain: "on", private: "on", public: "yes" } },
    { fleetPolicy: { domain: true, private: false, public: false } }, { fleetPolicy: "{\"domain\":\"on\"}" }, { fleetPolicy: ["on", "on", "on"] }])
    await refuse(foldCabinetCondition(untouched, "firewall", { cabinetId: id }, BOTH, v as never), /needs the fleet's policy/, `firewall values ${JSON.stringify(v)}`);
  assert.equal(refused, 36);
  // Asked to run neither: nothing reaches the database either.
  assert.deepEqual(await foldCabinetCondition(untouched, "clock", { cabinetId: id }, { open: false, close: false }), { opened: 0, resolved: 0 });
});

const OFF = { domain: "off", private: "off", public: "off" } as const;
const allOn = '{"domain":true,"private":true,"public":true}';

test("a firewall that differs from its site's policy opens the cabinet's minor alert, and the site's own policy is the one judged (D107)", async () => {
  const strict = await site([["LOOSE", "Eastern Standard Time", 0, 1], ["QUIET", "Eastern Standard Time", 0, 60]]);
  const plain = await site([["DEFAULT", "Eastern Standard Time", 0, 1]]);
  // The strict site has its own policy, every profile on; the plain one follows the fleet's, every profile off.
  await db.app.query(`UPDATE sites SET firewall_policy = '{"domain":"on","private":"on","public":"on"}' WHERE id = $1`, [strict.site]);
  await db.app.query(`UPDATE cabinets SET firewall_profiles = '{"domain":true,"private":false,"public":true}' WHERE id IN ($1, $2)`, strict.ids);
  await db.app.query("UPDATE cabinets SET firewall_profiles = $2 WHERE id = $1", [plain.ids[0], allOn]);
  assert.deepEqual(await foldCabinetCondition(db.app, "firewall", { siteId: strict.site }, BOTH, { fleetPolicy: OFF }), { opened: 2, resolved: 0 });
  const [loose, quiet] = strict.ids;
  assert.equal((await open(loose!, ISSUE.firewallPolicy))[0]!.severity, "minor", "the cabinet's own alert, minor");
  // As before, the firewall check judges every active cabinet, not only those heard from in the offline window.
  assert.equal((await open(quiet!, ISSUE.firewallPolicy)).length, 1);
  // The plain site's cabinet has every profile on against the fleet's all-off: it differs too, judged on its own site's scope.
  assert.deepEqual(await foldCabinetCondition(db.app, "firewall", { siteId: plain.site }, BOTH, { fleetPolicy: OFF }), { opened: 1, resolved: 0 });
  // Matched: the strict site's cabinets are put right and close, audited by the firewall check with its sentence.
  const alertId = (await open(loose!, ISSUE.firewallPolicy))[0]!.id;
  await db.app.query("UPDATE cabinets SET firewall_profiles = $3 WHERE id IN ($1, $2)", [...strict.ids, allOn]);
  assert.deepEqual(await foldCabinetCondition(db.app, "firewall", { clientId: strict.client }, BOTH, { fleetPolicy: OFF }), { opened: 0, resolved: 2 });
  const audits = await resolvedAudits([alertId]);
  assert.deepEqual(audits.map(a => [a.actor_id, a.details.resolution]), [["firewall-policy", "The firewall matches its policy again."]]);
  assert.equal((await open(plain.ids[0]!, ISSUE.firewallPolicy)).length, 1, "another client's alert stays open");
});

test("a stored fleet policy with more than the three profiles is judged on the three", async () => {
  const p = await site([["MATCHES", "Eastern Standard Time", 0, 1]]);
  await db.app.query("UPDATE cabinets SET firewall_profiles = '{\"domain\":false,\"private\":false,\"public\":false}' WHERE id = $1", [p.ids[0]]);
  const extra = { ...OFF, note: "set by hand" } as never;
  assert.deepEqual(await foldCabinetCondition(db.app, "firewall", { cabinetId: p.ids[0]! }, BOTH, { fleetPolicy: extra }), { opened: 0, resolved: 0 });
});

