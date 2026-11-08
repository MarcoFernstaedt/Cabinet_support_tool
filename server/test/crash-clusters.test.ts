// New kinds of blue screen, clustered (F17, decision-log D52). Every blue screen on a cabinet is one alert whatever its kind, so the fleet
// pattern for blue screens held every kind at once. A kind of blue screen new to the fleet (no crash of it before the last 7 days) on 2 or
// more cabinets now opens its own major fleet pattern, keyed by its crash signature, counted up as it spreads and resolved once none of its
// cabinets has a blue-screen alert open. Through the real event ingest, the hourly pass, the minute sweep and the report, on a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { clusterNewCrashKinds } from "../src/services/crash-clusters.js";
import { storeEvents } from "../src/services/events.js";
import { fleetPatternReport, sweepFleetPatterns } from "../src/services/fleet-patterns.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db.drop(); });

let rec = 1;
const iso = (minutesAgo: number) => new Date(Math.floor((Date.now() - minutesAgo * 60_000) / 1000) * 1000).toISOString().split(".")[0] + "Z";
const msg = (code: string, p: string[]) => `The computer has rebooted from a bugcheck.  The bugcheck was: ${code} (${p.join(", ")}). A dump was saved in: C:\\Windows\\Minidump\\110426-9875-01.dmp. Report Id: 4f1c.`;
const bugcheck = (minutesAgo: number, source: string, message: string) => ({ eventId: randomUUID(), kind: "error" as const, occurredAt: iso(minutesAgo), severityHint: "major" as const,
  source: { log: "System" as const, source, eventId: 1001, level: "error" as const, recordId: rec++ }, detail: { message } });
/** A blue screen as Windows logs it: under BugCheck and, a minute later, WER. */
const crash = (cabinetId: string, minutesAgo: number, message: string) => storeEvents(db.app, cabinetId, { events: [
  bugcheck(minutesAgo, "BugCheck", message), bugcheck(minutesAgo - 1, "Microsoft-Windows-WER-SystemErrorReporting", message)] });
const ACCESS_VIOLATION = msg("0x0000007e", ["0xffffffffc0000005", "0xfffff8012a4b1c20", "0xffffd50f3a2e7a58", "0xffffd50f3a2e7290"]);
const DRIVER_IRQL = msg("0x000000d1", ["0x0000000000000028", "0x2", "0x0", "0xfffff8063c41a2b0"]);
const WATCHDOG = msg("0x00000133", ["0x0", "0x501", "0x500", "0xfffff8057e2fb320"]);

/** Cabinets each at its own site. */
async function cabinets(n: number): Promise<string[]> {
  const client = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `Kinds ${randomBytes(3).toString("hex")}`]);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const site = randomUUID(), k = randomUUID();
    await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [site, client, `Site ${i}`]);
    await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, agent_version) VALUES ($1, $2, $3, 'standalone', 'active', '0.3.1')", [k, site, `KIND ${i}`]);
    ids.push(k);
  }
  return ids;
}
const pattern = async (key: string) => (await db.app.query<{ id: string; title: string; severity: string; cabinets: number; sites: number; occurrences: number; resolved_at: Date | null }>(
  "SELECT id, title, severity, cabinets, sites, occurrences, resolved_at FROM fleet_patterns WHERE pattern_key = $1", [key])).rows;

test("a new kind of blue screen on two cabinets opens its own major fleet pattern; the next pass counts it up and the minute sweep leaves it", async () => {
  const [a, b, c] = await cabinets(3);
  await crash(a!, 120, ACCESS_VIOLATION);
  await crash(b!, 60, ACCESS_VIOLATION);
  assert.equal((await clusterNewCrashKinds(db.app)).opened, 1);
  const [p] = await pattern("crash:0x0000007E/0xC0000005");
  assert.ok(p, "a pattern opened for the kind");
  assert.equal(p.severity, "major");
  assert.equal(p.title, "Fleet pattern: New kind of blue screen: 0x0000007E SYSTEM_THREAD_EXCEPTION_NOT_HANDLED, exception 0xC0000005 access violation (memory that was not the code's to touch)");
  assert.deepEqual([Number(p.cabinets), Number(p.sites), Number(p.occurrences)], [2, 2, 2], "each crash logged twice counts once");
  const audited = (await db.app.query<{ details: { newKind?: { signature: string } } }>(
    "SELECT details FROM audit_log WHERE action = 'fleet_pattern.open' AND target_id = $1", [p.id.toLowerCase()])).rows[0]!;
  assert.equal(audited.details.newKind?.signature, "0x0000007E/0xC0000005");
  // It spreads to a third cabinet: counted up, not opened twice. The minute sweep finds no alert keyed by a kind and leaves it open.
  await crash(c!, 30, ACCESS_VIOLATION);
  assert.equal((await clusterNewCrashKinds(db.app)).opened, 0);
  await sweepFleetPatterns(db.app);
  const [after] = await pattern("crash:0x0000007E/0xC0000005");
  assert.deepEqual([Number(after!.cabinets), after!.resolved_at], [3, null]);
  // The report lists the cabinets that had that kind, through their blue-screen alerts.
  const report = await fleetPatternReport(db.app, p.id.toLowerCase());
  assert.deepEqual(report!.cabinets.map(x => x.id).sort(), [a, b, c].map(x => x!.toLowerCase()).sort());
});

test("a kind the fleet has seen before, or a new kind on one cabinet, opens nothing: it is the usual crash, or that cabinet's own alert", async () => {
  const [old, x, y, lone] = await cabinets(4);
  await crash(old!, 60, DRIVER_IRQL);
  // That first crash of the kind was 10 days ago.
  await db.app.query("UPDATE events SET occurred_at = DATEADD(day, -10, occurred_at) WHERE cabinet_id = $1", [old]);
  await crash(x!, 50, DRIVER_IRQL);
  await crash(y!, 40, DRIVER_IRQL);
  await crash(lone!, 30, WATCHDOG);
  await clusterNewCrashKinds(db.app);
  assert.deepEqual(await pattern("crash:0x000000D1"), [], "not new to the fleet");
  assert.deepEqual(await pattern("crash:0x00000133/0x0"), [], "new, but on one cabinet");
});

test("once none of its cabinets has a blue-screen alert open, the pass resolves it, audited", async () => {
  const [p] = await pattern("crash:0x0000007E/0xC0000005");
  await db.app.query(`UPDATE alerts SET state = 'resolved', resolved_at = SYSUTCDATETIME()
    WHERE issue_type_id = '00000000-0000-4000-8000-000000000109' AND cabinet_id IN (SELECT cabinet_id FROM events WHERE JSON_VALUE(detail, '$.message') LIKE '%0x0000007e%')`);
  assert.equal((await clusterNewCrashKinds(db.app)).resolved, 1);
  assert.ok((await pattern("crash:0x0000007E/0xC0000005"))[0]!.resolved_at);
  assert.equal((await db.app.query("SELECT 1 AS x FROM audit_log WHERE action = 'fleet_pattern.resolve' AND target_id = $1", [p!.id.toLowerCase()])).rows.length, 1);
  // Resolved, it does not open again on the next pass while none of them is crashing.
  assert.equal((await clusterNewCrashKinds(db.app)).opened, 0);
});
