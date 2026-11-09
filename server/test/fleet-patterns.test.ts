// Fleet patterns (decision-log D22): the same problem at 5 or more sites within 24 hours is one fleet alert, counted up as it spreads,
// with a report of who has it and what they have in common. The owner's examples: one error at 50 of 100 sites after the same driver
// install, and 60 sites in reboot loops at once.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { storeEvents } from "../src/services/events.js";
import { countUpPattern, fleetCheckSettled, fleetPatternReport, listFleetPatterns, openPattern, resolvePattern, sweepFleetPatterns } from "../src/services/fleet-patterns.js";
import { upsertSetting } from "../src/services/settings.js";
import { ISSUE } from "../src/services/rules.js";
import { transaction } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db.drop(); });

/** n sites of one new client, each with `perSite` cabinets. */
async function fleet(n: number, perSite = 1): Promise<{ client: string; cabinets: string[][] }> {
  const client = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `Fleet ${randomBytes(3).toString("hex")}`]);
  const cabinets: string[][] = [];
  for (let s = 0; s < n; s++) {
    const site = randomUUID();
    await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [site, client, `Site ${s}`]);
    const ks: string[] = [];
    for (let c = 0; c < perSite; c++) {
      const k = randomUUID();
      await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, agent_version) VALUES ($1, $2, $3, 'standalone', 'active', '0.3.1')", [k, site, `CAB ${s}-${c}`]);
      ks.push(k);
    }
    cabinets.push(ks);
  }
  return { client, cabinets };
}
const iso = (minutesAgo: number) => new Date(Math.floor((Date.now() - minutesAgo * 60_000) / 1000) * 1000).toISOString().split(".")[0] + "Z";
let rec = 1;
const appError = (minutesAgo: number) => ({ eventId: randomUUID(), kind: "error" as const, occurredAt: iso(minutesAgo), severityHint: "major" as const,
  source: { log: "Application" as const, source: "Contoso Pharmacy Bridge", eventId: 7101, level: "error" as const, recordId: rec++ },
  detail: { message: "The bridge could not open the scanner session (0x80070005)." } });
const driverInstall = (minutesAgo: number) => ({ eventId: randomUUID(), kind: "change" as const, occurredAt: iso(minutesAgo), severityHint: "minor" as const,
  source: { log: "System" as const, source: "Microsoft-Windows-UserPnp", eventId: 20001, level: "information" as const, recordId: rec++ },
  detail: { message: "Driver Management concluded the process to install driver contoso_usb_9.2.inf for Device Instance ID USB\\VID_1234&PID_9999\\1 with the following status: 0x0." } });
const patternsFor = async (title: string) => (await listFleetPatterns(db.app)).filter(p => p.title.includes(title));

test("50 of 100 sites showing one error after the same driver install: one fleet alert, the driver named as what they have in common", async () => {
  const f = await fleet(100);
  // Every site's cabinet gets the driver on the 50 affected sites, 2 hours before their error; 10 unaffected sites got it too, without the error.
  for (let s = 0; s < 50; s++) await storeEvents(db.app, f.cabinets[s]![0]!, { events: [driverInstall(180), appError(60 - (s % 30))] });
  for (let s = 50; s < 60; s++) await storeEvents(db.app, f.cabinets[s]![0]!, { events: [driverInstall(180)] });
  // The same error again on one cabinet folds into its alert; it does not count as another site.
  await storeEvents(db.app, f.cabinets[0]![0]!, { events: [appError(5)] });
  await sweepFleetPatterns(db.app);
  const found = await patternsFor("Contoso Pharmacy Bridge event 7101");
  assert.equal(found.length, 1, JSON.stringify((await listFleetPatterns(db.app)).map(p => p.title)));
  const p = found[0]!;
  assert.deepEqual([p.sites, p.cabinets, p.clients], [50, 50, 1]);
  assert.equal(p.occurrences, 51);
  assert.equal(p.resolvedAt, null);
  // A second sweep counts it up; it never makes a second pattern.
  for (let s = 50; s < 55; s++) await storeEvents(db.app, f.cabinets[s]![0]!, { events: [appError(3)] });
  await sweepFleetPatterns(db.app);
  const again = await patternsFor("Contoso Pharmacy Bridge event 7101");
  assert.equal(again.length, 1);
  assert.equal(again[0]!.sites, 55);

  const report = (await fleetPatternReport(db.app, p.id))!;
  assert.equal(report.cabinets.length, 55);
  assert.equal(report.byClient.length, 1);
  assert.equal(report.bySite.length, 55);
  const driver = report.commonFactors.find(c => c.change.includes("contoso_usb_9.2.inf"));
  assert.ok(driver, JSON.stringify(report.commonFactors.slice(0, 5)));
  assert.equal(driver.standsOut, true, "the driver the affected cabinets share stands out against the rest of the fleet");

});

test("60 sites in reboot loops at once are one fleet alert; four sites are not; repeats at one site count once", async () => {
  const f = await fleet(64, 2);
  const loop = async (k: string) => db.app.query(`INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen, occurrences, scope)
      VALUES ($1, $2, 'major', 'reboot_loop', 'Restarting repeatedly (possible reboot loop): 3 starts within an hour', DATEADD(minute, -30, SYSUTCDATETIME()), SYSUTCDATETIME(), 3, 'fleet')`, [k, ISSUE.rebootLoop]);
  for (let s = 0; s < 60; s++) for (const k of f.cabinets[s]!) await loop(k);
  await sweepFleetPatterns(db.app);
  const loops = await patternsFor("Restarting repeatedly");
  assert.equal(loops.length, 1);
  assert.deepEqual([loops[0]!.sites, loops[0]!.cabinets], [60, 120], "two cabinets at a site are one site");
  assert.equal(loops[0]!.severity, "major");
  assert.ok(loops[0]!.alarmedAt, "60 sites in reboot loops ring the alarm at once");

  // Four sites with a new problem: below the threshold.
  for (let s = 60; s < 64; s++) await db.app.query(`INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen, occurrences, scope)
      VALUES ($1, $2, 'minor', $3, 'Clock out of step', SYSUTCDATETIME(), SYSUTCDATETIME(), 9, 'fleet')`, [f.cabinets[s]![0], ISSUE.clock, `issue:${ISSUE.clock}`]);
  await sweepFleetPatterns(db.app);
  assert.equal((await patternsFor("Clock out of step")).length, 0, "4 sites stay ordinary alerts");
  // An Admin lowers the threshold to 3 sites: now it is one.
  await transaction(db.app, c => upsertSetting(c, "alerts.fleetPatternSites", 3, null));
  await sweepFleetPatterns(db.app);
  assert.equal((await patternsFor("Clock out of step")).length, 1);
  assert.equal((await patternsFor("Clock out of step"))[0]!.alarmedAt, null, "a minor one at 3 sites is listed, not rung");
  await transaction(db.app, c => upsertSetting(c, "alerts.fleetPatternSites", 5, null));

  // Once every loop alert is resolved, the pattern resolves itself and stays in the list as recently resolved. The fleet check that the
  // first test's events asked for (checkFleetSoon) must be done first: running between the update and the sweep below, it would resolve
  // the pattern itself and leave this sweep nothing to do (seen under load in review of #181).
  await fleetCheckSettled();
  await db.app.query("UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME() WHERE issue_type_id = $1", [ISSUE.rebootLoop]);
  const r = await sweepFleetPatterns(db.app);
  assert.ok(r.resolved >= 1);
  const after = await patternsFor("Restarting repeatedly");
  assert.equal(after.length, 1);
  assert.ok(after[0]!.resolvedAt);
  const audits = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE target_kind = 'fleet_pattern' AND target_id = $1 ORDER BY seq", [after[0]!.id])).rows.map(a => a.action);
  // A major pattern rings when it opens (D25), so its trail is open, alarm, resolve.
  assert.deepEqual(audits, ["fleet_pattern.open", "fleet_pattern.alarm", "fleet_pattern.resolve"]);
  // The next sweeps still see those alerts within the look-back window, resolved: they are what the pattern was, not a new one. Nothing
  // opens again, so no alarm rings again and no console is told of a "new" fleet pattern every minute after the fleet recovered.
  for (let i = 0; i < 2; i++) assert.equal((await sweepFleetPatterns(db.app)).opened, 0, "a resolved pattern's alerts do not open it again");
  assert.equal((await patternsFor("Restarting repeatedly")).length, 1);
  assert.deepEqual((await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE target_kind = 'fleet_pattern' AND target_id = $1 ORDER BY seq", [after[0]!.id])).rows.map(a => a.action),
    audits, "its trail is the same: it did not open, ring or resolve again");
});

test("alerts older than the window and demo cabinets never make a real fleet pattern; a report for no such pattern is null", async () => {
  const f = await fleet(8);
  for (let s = 0; s < 8; s++) await db.app.query(`INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen, occurrences, scope)
      VALUES ($1, NULL, 'minor', 'unrecognized:System|old source|1', 'Old error', DATEADD(day, -3, SYSUTCDATETIME()), DATEADD(day, -2, SYSUTCDATETIME()), 1, 'fleet')`, [f.cabinets[s]![0]]);
  await sweepFleetPatterns(db.app);
  assert.equal((await patternsFor("Old error")).length, 0, "two days old is outside the 24 hours");
  // Three real sites and three demo sites with the same problem: neither side reaches 5.
  const g = await fleet(6);
  for (let s = 0; s < 3; s++) await db.app.query("UPDATE cabinets SET demo_scenario = 'healthy' WHERE id = $1", [g.cabinets[s]![0]]);
  for (let s = 0; s < 6; s++) await db.app.query(`INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen, occurrences, scope)
      VALUES ($1, NULL, 'minor', 'unrecognized:System|mixed|2', 'Mixed error', SYSUTCDATETIME(), SYSUTCDATETIME(), 1, 'fleet')`, [g.cabinets[s]![0]]);
  await sweepFleetPatterns(db.app);
  assert.equal((await patternsFor("Mixed error")).length, 0);
  assert.equal(await fleetPatternReport(db.app, randomUUID()), null);
});

test("5 real sites and 5 demo sites with one error are two patterns, each with its own counts, report and resolution", async () => {
  const real = await fleet(5), demo = await fleet(5);
  for (const ks of demo.cabinets) await db.app.query("UPDATE cabinets SET demo_scenario = 'healthy' WHERE id = $1", [ks[0]]);
  const sig = `unrecognized:System|split probe ${randomBytes(3).toString("hex")}|9`;
  const raise = (k: string) => db.app.query(`INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen, occurrences, scope)
      VALUES ($1, NULL, 'minor', $2, 'Split probe error', SYSUTCDATETIME(), SYSUTCDATETIME(), 2, 'fleet')`, [k, sig]);
  for (const ks of [...real.cabinets, ...demo.cabinets]) await raise(ks[0]!);
  await sweepFleetPatterns(db.app);
  const found = await patternsFor("Split probe error");
  assert.equal(found.length, 2, "the demo fleet is a pattern of its own");
  for (const p of found) {
    assert.deepEqual([p.sites, p.cabinets, p.clients, p.occurrences], [5, 5, 1, 10]);
    const r = (await fleetPatternReport(db.app, p.id))!;
    assert.equal(r.cabinets.length, 5, "the report holds the pattern's own cabinets");
    assert.equal(r.bySite.length, 5);
    assert.equal(r.byClient.length, 1);
  }
  const reports = await Promise.all(found.map(p => fleetPatternReport(db.app, p.id)));
  const realIds = new Set(real.cabinets.map(k => k[0]!.toLowerCase()));
  const sides = reports.map(r => r!.cabinets.every(c => realIds.has(c.id)) ? "real" : r!.cabinets.every(c => !realIds.has(c.id)) ? "demo" : "mixed");
  assert.deepEqual(sides.sort(), ["demo", "real"], "no report mixes real and demo cabinets");

  // Resolving the real alerts resolves the real pattern only; the demo one stays open while its alerts are.
  await db.app.query("UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME() WHERE signature = $1 AND cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($2))",
    [sig, JSON.stringify([...realIds])]);
  await sweepFleetPatterns(db.app);
  const after = await patternsFor("Split probe error");
  const byId = new Map(after.map(p => [p.id, p]));
  const realId = found[reports.findIndex(r => r!.cabinets.every(c => realIds.has(c.id)))]!.id;
  const demoId = found.find(p => p.id !== realId)!.id;
  assert.ok(byId.get(realId)!.resolvedAt, "the real pattern resolved");
  assert.equal(byId.get(demoId)!.resolvedAt, null, "the demo pattern is still open");
});

test("incident response: the report counts who has recovered and who has not, and when each began and recovered", async () => {
  const f = await fleet(6, 2);
  const sig = `unrecognized:System|recovery probe ${randomBytes(3).toString("hex")}|3`;
  for (const ks of f.cabinets) for (const k of ks) await db.app.query(`INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen, occurrences, scope)
      VALUES ($1, NULL, 'major', $2, 'Recovery probe', DATEADD(hour, -3, SYSUTCDATETIME()), SYSUTCDATETIME(), 1, 'fleet')`, [k, sig]);
  await sweepFleetPatterns(db.app);
  const p = (await patternsFor("Recovery probe"))[0]!;
  let r = (await fleetPatternReport(db.app, p.id))!;
  assert.deepEqual([r.recovered, r.stillAffected], [0, 12]);
  // Two sites recover in full; at a third, one of its two cabinets recovers (the other keeps the site affected).
  const done = [...f.cabinets[0]!, ...f.cabinets[1]!, f.cabinets[2]![0]!];
  await db.app.query("UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME() WHERE signature = $1 AND cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($2))", [sig, JSON.stringify(done)]);
  r = (await fleetPatternReport(db.app, p.id))!;
  assert.deepEqual([r.recovered, r.stillAffected], [5, 7]);
  assert.equal(r.timeline.reduce((n, t) => n + t.began, 0), 12, "every cabinet began once");
  assert.equal(r.timeline.reduce((n, t) => n + t.recovered, 0), 5, "every recovered cabinet recovered once");
  assert.ok(r.timeline.every((t, i, all) => i === 0 || all[i - 1]!.hour < t.hour), "hours in order");
  // Recovery is staged site by site: each site lists exactly its cabinets still affected, and those sites come first.
  const still = (s: number) => r.bySite.find(x => x.site === `Site ${s}` && x.client === r.byClient[0]!.client)!;
  assert.deepEqual(still(0).stillAffected, []);
  assert.deepEqual(still(2).stillAffected.map(c => c.id), [f.cabinets[2]![1]!.toLowerCase()]);
  assert.deepEqual(still(4).stillAffected.map(c => c.id).sort(), f.cabinets[4]!.map(k => k.toLowerCase()).sort());
  assert.equal(r.bySite.reduce((n, s) => n + s.stillAffected.length, 0), r.stillAffected);
  assert.ok(r.bySite.every((s, i, all) => i === 0 || all[i - 1]!.stillAffected.length >= s.stillAffected.length), "sites with most still affected first");
  assert.ok(r.cabinets.every(c => r.bySite.some(s => s.siteId === c.siteId && s.site === c.site)), "each cabinet names its site's id");
  // A cabinet with one alert still open is not recovered, even if another alert of its in the pattern is resolved.
  const k = f.cabinets[3]![0]!;
  await db.app.query(`INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen, occurrences, scope, state, resolved_at)
      VALUES ($1, NULL, 'major', $2, 'Recovery probe', DATEADD(hour, -2, SYSUTCDATETIME()), DATEADD(hour, -2, SYSUTCDATETIME()), 1, 'fleet', 'resolved', DATEADD(hour, -1, SYSUTCDATETIME()))`, [k, sig]);
  r = (await fleetPatternReport(db.app, p.id))!;
  assert.deepEqual([r.recovered, r.stillAffected], [5, 7]);
});

test("alarm level (D25): a major pattern rings when it opens; a minor one is listed quietly until it reaches the Admin's number of sites", async () => {
  const tag = randomBytes(3).toString("hex");
  const raise = async (sites: number, severity: "major" | "minor", title: string) => {
    const f = await fleet(sites);
    for (const ks of f.cabinets) await db.app.query(`INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen, occurrences, scope)
        VALUES ($1, NULL, $2, $3, $4, DATEADD(minute, -30, SYSUTCDATETIME()), SYSUTCDATETIME(), 1, 'fleet')`, [ks[0], severity, `unrecognized:Application|${title.toLowerCase()}|7`, title]);
  };
  const rang = async (id: string) => (await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'fleet_pattern.alarm' AND target_id = $1", [id])).rows[0]!.n;
  await transaction(db.app, c => upsertSetting(c, "alerts.fleetMinorAlarmSites", 8, null));
  try {
    await raise(5, "major", `Major ${tag}`);
    await raise(5, "minor", `Minor ${tag}`);
    await sweepFleetPatterns(db.app);
    const major = (await patternsFor(`Major ${tag}`))[0]!, minor = (await patternsFor(`Minor ${tag}`))[0]!;
    assert.ok(major.alarmedAt, "a major one rings at once");
    assert.equal(minor.alarmedAt, null, "a minor one at 5 sites is listed, not rung");
    assert.equal(Number(await rang(minor.id)), 0);
    // It spreads to 7 sites: still quiet. Then to 8: it rings, once.
    await raise(2, "minor", `Minor ${tag}`);
    await sweepFleetPatterns(db.app);
    assert.equal((await patternsFor(`Minor ${tag}`))[0]!.alarmedAt, null);
    await raise(1, "minor", `Minor ${tag}`);
    await sweepFleetPatterns(db.app);
    await sweepFleetPatterns(db.app);
    const now = (await patternsFor(`Minor ${tag}`))[0]!;
    assert.equal(now.id, minor.id, "the same pattern, now ringing");
    assert.ok(now.alarmedAt);
    assert.equal(Number(await rang(minor.id)), 1, "it rings once, not at every sweep");
    // Raising the level afterwards does not silence an alarm already rung.
    await transaction(db.app, c => upsertSetting(c, "alerts.fleetMinorAlarmSites", 500, null));
    await sweepFleetPatterns(db.app);
    assert.equal((await patternsFor(`Minor ${tag}`))[0]!.alarmedAt, now.alarmedAt);
    assert.equal(Number(await rang(major.id)), 1);
  } finally {
    await transaction(db.app, c => upsertSetting(c, "alerts.fleetMinorAlarmSites", 20, null));
  }
});

test("the pattern writers (F21.R2, D65): input is checked before anything is written, and each can be repeated safely", async () => {
  const key = `test:${randomUUID()}`, at = new Date(Date.now() - 60_000);
  const base = { key, issueTypeId: null, title: "Fleet pattern: a test", severity: "minor", clients: 1, sites: 3, cabinets: 4, occurrences: 9, firstSeen: at, lastSeen: at };
  const rows = async () => (await db.app.query<{ id: string; sites: number; occurrences: number; resolved: number }>(
    "SELECT id, sites, occurrences, CASE WHEN resolved_at IS NULL THEN 0 ELSE 1 END AS resolved FROM fleet_patterns WHERE pattern_key = $1", [key])).rows;
  const audits = async (id: string) => (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY seq", [id])).rows.map(r => r.action);
  // Refused before the database: a missing or overlong key or title, a severity that is neither, counts that are not whole numbers from 0, a time that is not one.
  for (const bad of [{ key: "" }, { key: "k".repeat(451) }, { title: "" }, { title: "t".repeat(301) }, { severity: "critical" }, { severity: "major'; DROP TABLE fleet_patterns; --" },
    { sites: -1 }, { cabinets: 1.5 }, { occurrences: Number.NaN }, { clients: "2" }, { firstSeen: new Date("not a date") }, { lastSeen: "yesterday" }])
    await assert.rejects(openPattern(db.app, { ...base, ...bad } as never, {}, 99), /fleet pattern/, JSON.stringify(bad));
  await assert.rejects(countUpPattern(db.app, key, { clients: 1, sites: -2, cabinets: 1, occurrences: 1, lastSeen: at }), /fleet pattern/);
  assert.deepEqual(await rows(), [], "nothing was written");
  // Opened once: a second open of the same key finds it open and writes nothing more.
  const id = (await openPattern(db.app, base, { key }, 99))!;
  assert.ok(id);
  assert.equal(await openPattern(db.app, base, { key }, 99), null);
  assert.equal((await rows()).length, 1);
  assert.deepEqual(await audits(id), ["fleet_pattern.open"]);
  // Counts only grow while it is open.
  assert.equal(await countUpPattern(db.app, key, { clients: 1, sites: 2, cabinets: 2, occurrences: 20, lastSeen: new Date() }), true);
  assert.deepEqual((await rows()).map(r => [Number(r.sites), Number(r.occurrences)]), [[3, 20]]);
  // Resolved once: a second resolve does nothing and audits nothing; counting up a resolved pattern finds none open.
  assert.equal(await resolvePattern(db.app, id), true);
  assert.equal(await resolvePattern(db.app, id), false);
  assert.deepEqual(await audits(id), ["fleet_pattern.open", "fleet_pattern.resolve"]);
  assert.equal(await countUpPattern(db.app, key, { clients: 9, sites: 9, cabinets: 9, occurrences: 99, lastSeen: new Date() }), false);
  assert.deepEqual((await rows()).map(r => [Number(r.sites), Number(r.resolved)]), [[3, 1]]);
});
