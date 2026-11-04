// Application crashes and hangs (decision-log D29): an unrecognized Application Error 1000 or Application Hang 1002 is known by its program,
// faulting module and exception code, read from the message by label (never a pattern), so different programs never fold into one alert
// or one fleet pattern. Hostile and malformed messages fall back to the plain log, source and event ID.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { appFault, SIGNATURE_MAX, unrecognizedSignature } from "../src/services/alerts.js";
import { storeEvents } from "../src/services/events.js";
import { listFleetPatterns, sweepFleetPatterns } from "../src/services/fleet-patterns.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

const APP_ERROR = { log: "Application" as const, source: "Application Error", eventId: 1000, level: "error" as const, recordId: 1 };
const HANG = { log: "Application" as const, source: "Application Hang", eventId: 1002, level: "error" as const, recordId: 1 };
const crash = (program: string, module: string, code: string) =>
  `Faulting application name: ${program}, version: 7.2.1.0, time stamp: 0x6512a3b4\r\nFaulting module name: ${module}, version: 10.0.19041.3636, time stamp: 0x8f1b2c3d\r\nException code: ${code}\r\nFault offset: 0x000000000007286e`;

test("a crash is known by its program, faulting module and exception code; a hang by its program", () => {
  assert.deepEqual(appFault(APP_ERROR, crash("CabinetUI.exe", "ucrtbase.dll", "0xc0000409")), { program: "CabinetUI.exe", module: "ucrtbase.dll", exception: "0xc0000409", hang: false });
  // The labels are found whatever their case (the demo writes "faulting module name").
  assert.equal(appFault(APP_ERROR, "Faulting application name: A.exe, version: 1, faulting module name: b.dll, version: 2, exception code: 0xc0000005")?.module, "b.dll");
  assert.deepEqual(appFault(HANG, "The program CabinetUI.exe version 7.2.1.0 stopped interacting with Windows and was closed."), { program: "CabinetUI.exe", module: null, exception: null, hang: true });
  const a = unrecognizedSignature({ kind: "error", source: APP_ERROR, detail: { message: crash("CabinetUI.exe", "ucrtbase.dll", "0xc0000409") } });
  assert.equal(a, "unrecognized:Application|application error|1000~cabinetui.exe~ucrtbase.dll~0xc0000409");
  assert.notEqual(a, unrecognizedSignature({ kind: "error", source: APP_ERROR, detail: { message: crash("StatementViewer.exe", "ucrtbase.dll", "0xc0000409") } }), "another program, another signature");
  assert.notEqual(a, unrecognizedSignature({ kind: "error", source: APP_ERROR, detail: { message: crash("CabinetUI.exe", "ntdll.dll", "0xc0000005") } }), "another fault, another signature");
});

test("hostile or malformed messages fall back to the plain signature, never a wrong one or an unbounded one", () => {
  const plain = "unrecognized:Application|application error|1000";
  for (const message of [undefined, "", "no labels here", "Faulting application name: , version: 1", "Faulting application name:"])
    assert.equal(unrecognizedSignature({ kind: "error", source: APP_ERROR, detail: message === undefined ? {} : { message } }), plain, String(message));
  // Another log or event ID is never read as an application crash.
  assert.equal(appFault({ ...APP_ERROR, log: "System" as const }, crash("A.exe", "b.dll", "0x1")), null);
  assert.equal(appFault({ ...APP_ERROR, eventId: 1001 }, crash("A.exe", "b.dll", "0x1")), null);
  // Separator characters cannot be smuggled into the signature, and every value is bounded.
  const sneaky = unrecognizedSignature({ kind: "error", source: APP_ERROR, detail: { message: crash("A|B~C.exe", "x".repeat(10_000), "0x1|2") } });
  assert.ok(!sneaky.slice(plain.length).includes("|"));
  assert.equal(sneaky.split("~").length, 4);
  assert.ok(sneaky.length <= SIGNATURE_MAX);
  // A hang with no " version " after the program name is not guessed at.
  assert.equal(appFault(HANG, "The program CabinetUI.exe stopped interacting with Windows."), null);
  assert.equal(appFault(HANG, "The program  version 1"), null);
});

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db.drop(); });

let rec = 1;
const iso = (minutesAgo: number) => new Date(Math.floor((Date.now() - minutesAgo * 60_000) / 1000) * 1000).toISOString().split(".")[0] + "Z";
const appCrash = (minutesAgo: number, program: string, module: string, code: string) => ({ eventId: randomUUID(), kind: "error" as const, occurredAt: iso(minutesAgo), severityHint: "minor" as const,
  source: { ...APP_ERROR, recordId: rec++ }, detail: { message: crash(program, module, code) } });

async function fleet(n: number): Promise<string[]> {
  const client = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `Apps ${randomBytes(3).toString("hex")}`]);
  const ids: string[] = [];
  for (let s = 0; s < n; s++) {
    const site = randomUUID(), k = randomUUID();
    await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [site, client, `Site ${s}`]);
    await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, agent_version) VALUES ($1, $2, $3, 'standalone', 'active', '0.3.1')", [k, site, `APP ${s}`]);
    ids.push(k);
  }
  return ids;
}
const alertsOf = async (cabinetId: string) => (await db.app.query<{ signature: string; title: string; occurrences: number }>(
  "SELECT signature, title, occurrences FROM alerts WHERE cabinet_id = $1 ORDER BY title", [cabinetId])).rows;

test("on one cabinet: the same program crashing twice is one alert counted twice; another program is its own alert, named", async () => {
  const [k] = await fleet(1);
  await storeEvents(db.app, k!, { events: [appCrash(30, "CabinetUI.exe", "ucrtbase.dll", "0xc0000409"), appCrash(20, "CabinetUI.exe", "ucrtbase.dll", "0xc0000409"),
    appCrash(10, "StatementViewer.exe", "ntdll.dll", "0xc0000005")] });
  const rows = await alertsOf(k!);
  assert.deepEqual(rows.map(r => [r.title, Number(r.occurrences)]), [["CabinetUI.exe crashed in ucrtbase.dll (0xc0000409)", 2], ["StatementViewer.exe crashed in ntdll.dll (0xc0000005)", 1]]);
});

test("across the fleet: two programs crashing at five sites each are two fleet patterns, not one", async () => {
  const ids = await fleet(10), tag = randomBytes(3).toString("hex");
  for (const [i, k] of ids.entries())
    await storeEvents(db.app, k, { events: [i < 5 ? appCrash(15, `Pharmacy${tag}.exe`, "ucrtbase.dll", "0xc0000409") : appCrash(15, `Reader${tag}.exe`, "hid.dll", "0xc0000005")] });
  await sweepFleetPatterns(db.app);
  const mine = (await listFleetPatterns(db.app)).filter(p => p.title.includes(tag));
  assert.deepEqual(mine.map(p => [p.title.replace("Fleet pattern: ", ""), p.sites]).sort(),
    [[`Pharmacy${tag}.exe crashed in ucrtbase.dll (0xc0000409)`, 5], [`Reader${tag}.exe crashed in hid.dll (0xc0000005)`, 5]]);
});
