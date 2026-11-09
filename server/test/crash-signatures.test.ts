// Crash signatures (decision-log D26): what kind of blue screen each crash was, from the BugCheck 1001 message without regular expressions,
// grouped across the fleet with who has it and what they have in common. Hostile and malformed messages give no signature, never a wrong one.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { storeEvents } from "../src/services/events.js";
import { crashSignature, crashSignatureReport, fleetCrashSignatures, isSignatureKey, stopParametersOf } from "../src/services/crash-signatures.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { ISSUE } from "../src/services/rules.js";

const msg = (code: string, p: string[]) => `The computer has rebooted from a bugcheck.  The bugcheck was: ${code} (${p.join(", ")}). A dump was saved in: C:\\Windows\\Minidump\\110426-9875-01.dmp. Report Id: 4f1c.`;

test("the four parameters are read as Windows writes them", () => {
  assert.deepEqual(stopParametersOf(msg("0x000000d1", ["0x0000000000000028", "0x0000000000000002", "0x0000000000000000", "0xfffff8063c41a2b0"])),
    [0x28n, 0x2n, 0x0n, 0xfffff8063c41a2b0n]);
  assert.deepEqual(stopParametersOf("The bugcheck was: 0x0000007e (0xc0000005, 0x8a2b3c4d, 0x1, 0x2)."), [0xc0000005n, 0x8a2b3c4dn, 0x1n, 0x2n], "32-bit Windows writes shorter numbers");
});

test("an exception-coded stop code is signed by its exception, sign-extended or not, and named when common", () => {
  const a = crashSignature(msg("0x0000007e", ["0xffffffffc0000005", "0xfffff8012a4b1c20", "0xffffd50f3a2e7a58", "0xffffd50f3a2e7290"]))!;
  const b = crashSignature(msg("0x0000007e", ["0x00000000c0000005", "0xfffff80100000000", "0x1", "0x2"]))!;
  assert.equal(a.key, "0x0000007E/0xC0000005");
  assert.equal(b.key, a.key, "addresses differ crash to crash; the signature does not");
  assert.equal(a.detail?.kind, "exception");
  assert.match(a.title, /SYSTEM_THREAD_EXCEPTION_NOT_HANDLED/);
  assert.match(a.title, /access violation/);
  assert.notEqual(crashSignature(msg("0x0000007e", ["0xffffffffc000001d", "0x0", "0x0", "0x0"]))!.key, a.key, "a different exception is a different signature");
});

test("a subtype stop code is signed by its subtype; a stop code whose first parameter is an address is signed by the code alone", () => {
  assert.equal(crashSignature(msg("0x0000009f", ["0x0000000000000003", "0xffffb20d1a2c3060", "0xfffff80152a7f7f0", "0xffffb20d1f7b2010"]))!.key, "0x0000009F/0x3");
  assert.equal(crashSignature(msg("0x00000133", ["0x0000000000000001", "0x0000000000001e00", "0xfffff8015d6fb320", "0x0"]))!.detail?.meaning, "deferred procedures ran too long in total");
  const d1 = crashSignature(msg("0x000000d1", ["0x0000000000000028", "0x2", "0x0", "0xfffff8063c41a2b0"]))!;
  assert.equal(d1.key, "0x000000D1");
  assert.equal(d1.detail, null);
  // A stop code with no parameters in its message still has its signature.
  assert.equal(crashSignature("The bugcheck was: 0x0000007e")!.key, "0x0000007E");
  // A subtype stop code whose first parameter is too large to be a subtype keeps the code alone rather than a nonsense subtype.
  assert.equal(crashSignature(msg("0x00000124", ["0xffffffffffffffff", "0x0", "0x0", "0x0"]))!.key, "0x00000124");
});

test("hostile and malformed messages give no signature or no parameters, never a wrong one", () => {
  for (const m of ["", "bugcheck", "The bugcheck was: ", "The bugcheck was: 7e (0x1, 0x2, 0x3, 0x4)", "The bugcheck was: 0x (0x1)", "The bugcheck was: 0x0000007e1"])
    assert.equal(crashSignature(m), null, JSON.stringify(m));
  for (const m of [
    "The bugcheck was: 0x0000007e (0x1, 0x2, 0x3)",            // three parameters
    "The bugcheck was: 0x0000007e (0x1, 0x2, 0x3, 0x4, 0x5)",  // five
    "The bugcheck was: 0x0000007e (0x1; 0x2; 0x3; 0x4)",
    "The bugcheck was: 0x0000007e (0x11111111111111111, 0x2, 0x3, 0x4)", // 17 hex digits
    "The bugcheck was: 0x0000007e (1, 2, 3, 4)",
    "The bugcheck was: 0x0000007e" + " ".repeat(100) + "(0x1, 0x2, 0x3, 0x4)",
  ]) assert.equal(stopParametersOf(m), null, m);
  // A huge message is read without trouble and gives nothing it does not hold.
  assert.equal(crashSignature("x".repeat(1_000_000)), null);
  assert.equal(crashSignature("The bugcheck was: 0x0000007e (0x1, 0x2, 0x3, 0x4)" + "(".repeat(100_000))!.key, "0x0000007E/0x00000001");
});

test("only keys exactly as the list gives them are accepted back", () => {
  for (const k of ["0x0000007E", "0x0000007E/0xC0000005", "0x0000009F/0x3"]) assert.ok(isSignatureKey(k), k);
  for (const k of ["", "0x7E", "0x0000007e", "0x0000007E/", "0x0000007E/0x", "0x0000007E/0xC0000005/0x1", "0x0000007E/C0000005", "' OR 1=1 --", "0x0000007E/0x123456789", "0x0000007G"])
    assert.ok(!isSignatureKey(k), k);
});

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db.drop(); });

let rec = 1;
const iso = (minutesAgo: number) => new Date(Math.floor((Date.now() - minutesAgo * 60_000) / 1000) * 1000).toISOString().split(".")[0] + "Z";
const bugcheck = (minutesAgo: number, source: string, message: string) => ({ eventId: randomUUID(), kind: "error" as const, occurredAt: iso(minutesAgo), severityHint: "major" as const,
  source: { log: "System" as const, source, eventId: 1001, level: "error" as const, recordId: rec++ }, detail: { message } });
const driverInstall = (minutesAgo: number, inf: string) => ({ eventId: randomUUID(), kind: "change" as const, occurredAt: iso(minutesAgo), severityHint: "minor" as const,
  source: { log: "System" as const, source: "Microsoft-Windows-UserPnp", eventId: 20001, level: "information" as const, recordId: rec++ },
  detail: { message: `Driver Management concluded the process to install driver ${inf} for Device Instance ID PCI\\VEN_1234&DEV_5678\\1 with the following status: 0x0.` } });

async function cabinets(n: number): Promise<{ client: string; ids: string[] }> {
  const client = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `Sig ${randomBytes(3).toString("hex")}`]);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const site = randomUUID(), k = randomUUID();
    await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [site, client, `Site ${i}`]);
    await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, agent_version) VALUES ($1, $2, $3, 'standalone', 'active', '0.3.1')", [k, site, `SIG ${i}`]);
    ids.push(k);
  }
  return { client, ids };
}

test("across the fleet: one crash logged twice is one crash, a reboot loop's crashes stay many, and the driver they share stands out", async () => {
  const f = await cabinets(12);
  const ex = (p2: string) => msg("0x0000007e", ["0xffffffffc0000005", p2, "0xffffd50f3a2e7a58", "0xffffd50f3a2e7290"]);
  // Eight cabinets got the same storage driver, then crashed with the same signature (different addresses each time).
  for (let i = 0; i < 8; i++)
    await storeEvents(db.app, f.ids[i]!, { events: [driverInstall(600, "contoso_nvme_3.1.inf"), bugcheck(120 - i, "BugCheck", ex(`0xfffff8012a4b${1000 + i}`)),
      bugcheck(119 - i, "Microsoft-Windows-WER-SystemErrorReporting", ex(`0xfffff8012a4b${1000 + i}`))] });
  // One of them looped: two more crashes 4 and 8 minutes later, each logged once.
  await storeEvents(db.app, f.ids[0]!, { events: [bugcheck(116, "BugCheck", ex("0xfffff80100000001")), bugcheck(112, "BugCheck", ex("0xfffff80100000002"))] });
  // Two others crashed differently, and two did not crash.
  for (let i = 8; i < 10; i++) await storeEvents(db.app, f.ids[i]!, { events: [bugcheck(90, "BugCheck", msg("0x000000d1", ["0x28", "0x2", "0x0", "0xfffff8063c41a2b0"]))] });
  const to = new Date(Date.now() + 60_000), from = new Date(Date.now() - 2 * 86_400_000);
  const list = await fleetCrashSignatures(db.app, { from, to, clientId: f.client });
  assert.deepEqual(list.map(r => [r.key, r.cabinets, r.crashes]), [["0x0000007E/0xC0000005", 8, 10], ["0x000000D1", 2, 2]],
    "8 cabinets, 10 crashes: the 8 logged under both sources count once each, the loop's 2 more count");
  assert.equal(list[0]!.sites, 8);
  assert.equal(list[0]!.lastDay, 10);
  assert.ok(list.every(r => !r.demo));

  const report = (await crashSignatureReport(db.app, { from, to, clientId: f.client, key: "0x0000007E/0xC0000005", demo: false }))!;
  assert.equal(report.cabinets.length, 8);
  assert.equal(report.cabinets.find(c => c.id === f.ids[0]!.toLowerCase())!.crashes, 3);
  const driver = report.commonFactors.find(c => c.change.includes("contoso_nvme_3.1.inf"));
  assert.ok(driver?.standsOut, "the driver all eight installed before crashing stands out against the four that did not crash with it");
  assert.equal(await crashSignatureReport(db.app, { from, to, clientId: f.client, key: "0x0000007E/0xC0000005", demo: true }), null, "the demo fleet's version is not this one");
  assert.equal(await crashSignatureReport(db.app, { from, to, clientId: f.client, key: "0x00000050", demo: false }), null);
});

test("the list reads what the alerts engine filed as a blue screen: an unfiled entry, another source, or a removed cabinet is not a crash in it", async () => {
  const f = await cabinets(4);
  const m = msg("0x00000050", ["0xffffd50f3a2e7a58", "0x0", "0xfffff8012a4b1c20", "0x2"]);
  for (const id of f.ids) await storeEvents(db.app, id, { events: [bugcheck(60, "BugCheck", m)] });
  const to = new Date(Date.now() + 60_000), from = new Date(Date.now() - 2 * 86_400_000);
  const count = async () => (await fleetCrashSignatures(db.app, { from, to, clientId: f.client })).map(r => [r.key, r.cabinets]);
  assert.deepEqual(await count(), [["0x00000050", 4]]);
  // An entry the engine filed under no alert (an approved suppress rule leaves it so) is not listed.
  await db.app.query("UPDATE events SET alert_id = NULL WHERE cabinet_id = $1", [f.ids[0]]);
  // An entry held by the blue-screen alert that is not BugCheck 1001 (regrouped there by a rule) is not a crash, whatever its message.
  const crashAlert = (await db.app.query<{ id: string }>("SELECT TOP (1) id FROM alerts WHERE cabinet_id = $1 AND issue_type_id = $2", [f.ids[1], ISSUE.crash])).rows[0]!.id;
  await db.app.query("UPDATE events SET alert_id = NULL WHERE cabinet_id = $1", [f.ids[1]]);
  await storeEvents(db.app, f.ids[1]!, { events: [{ ...bugcheck(50, "BugCheck", m), source: { log: "System" as const, source: "Contoso-Watchdog", eventId: 1001, level: "error" as const, recordId: rec++ } },
    { ...bugcheck(49, "BugCheck", m), source: { log: "System" as const, source: "BugCheck", eventId: 1002, level: "error" as const, recordId: rec++ } }] });
  await db.app.query("UPDATE events SET alert_id = $2 WHERE cabinet_id = $1 AND alert_id IS NOT NULL", [f.ids[1], crashAlert]);
  // A removed cabinet's crashes are not the fleet's.
  await db.app.query("UPDATE cabinets SET status = 'removed' WHERE id = $1", [f.ids[2]]);
  assert.deepEqual(await count(), [["0x00000050", 1]], "only the cabinet whose blue screen was filed, from its own source, and is still in service");
});
