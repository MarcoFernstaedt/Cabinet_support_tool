// Application crashes and hangs (decision-log D29): an unrecognized Application Error 1000 or Application Hang 1002 is known by its program,
// read from the first line of the message by label (never a pattern), so different programs never fold into one alert or one fleet pattern. Hostile and malformed messages fall back to the plain log, source and event ID.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { appFault, SIGNATURE_MAX, unrecognizedSignature } from "../src/services/alerts.js";
import { storeEvents } from "../src/services/events.js";
import { listFleetPatterns, sweepFleetPatterns } from "../src/services/fleet-patterns.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

const APP_ERROR = { log: "Application" as const, source: "Application Error", eventId: 1000, level: "error" as const, recordId: 1 };
const HANG = { log: "Application" as const, source: "Application Hang", eventId: 1002, level: "error" as const, recordId: 1 };
// What a cabinet actually sends: the agent puts only the first line of a message into the event (EventLogWatch.ToEvent), and for an
// Application Error 1000 that line names the program. The faulting module and exception code are on later lines and never arrive.
const crash = (program: string) => `Faulting application name: ${program}, version: 7.2.1.0, time stamp: 0x6512a3b4`;

test("a crash and a hang are known by their program, from the first line the agent sends", () => {
  assert.deepEqual(appFault(APP_ERROR, crash("CabinetUI.exe")), { program: "CabinetUI.exe", hang: false });
  // The label is found whatever its case.
  assert.equal(appFault(APP_ERROR, "faulting application name: A.exe, version: 1")?.program, "A.exe");
  assert.deepEqual(appFault(HANG, "The program CabinetUI.exe version 7.2.1.0 stopped interacting with Windows and was closed."), { program: "CabinetUI.exe", hang: true });
  const a = unrecognizedSignature({ kind: "error", source: APP_ERROR, detail: { message: crash("CabinetUI.exe") } });
  assert.equal(a, "unrecognized:Application|application error|1000~cabinetui.exe");
  assert.notEqual(a, unrecognizedSignature({ kind: "error", source: APP_ERROR, detail: { message: crash("StatementViewer.exe") } }), "another program, another signature");
  assert.equal(a, unrecognizedSignature({ kind: "error", source: APP_ERROR, detail: { message: crash("CABINETUI.EXE") } }), "the same program in another letter case is the same signature");
});

test("hostile or malformed messages fall back to the plain signature, never a wrong one or an unbounded one", () => {
  const plain = "unrecognized:Application|application error|1000";
  for (const message of [undefined, "", "no labels here", "Faulting application name: , version: 1", "Faulting application name:"])
    assert.equal(unrecognizedSignature({ kind: "error", source: APP_ERROR, detail: message === undefined ? {} : { message } }), plain, String(message));
  // Another log or event ID is never read as an application crash.
  assert.equal(appFault({ ...APP_ERROR, log: "System" as const }, crash("A.exe")), null);
  assert.equal(appFault({ ...APP_ERROR, eventId: 1001 }, crash("A.exe")), null);
  // Separator characters cannot be smuggled into the signature, and the program name is bounded.
  const sneaky = unrecognizedSignature({ kind: "error", source: APP_ERROR, detail: { message: crash("A|B~C" + "x".repeat(10_000)) } });
  assert.ok(!sneaky.slice(plain.length).includes("|"));
  assert.equal(sneaky.split("~").length, 2);
  assert.ok(sneaky.length <= plain.length + 1 + 80 && sneaky.length <= SIGNATURE_MAX);
  // A hang with no " version " after the program name is not guessed at.
  assert.equal(appFault(HANG, "The program CabinetUI.exe stopped interacting with Windows."), null);
  assert.equal(appFault(HANG, "The program  version 1"), null);
});

let db: TestDatabase;
test.before(async () => { db = await createTestDatabase(); });
test.after(async () => { await db.drop(); });

let rec = 1;
const iso = (minutesAgo: number) => new Date(Math.floor((Date.now() - minutesAgo * 60_000) / 1000) * 1000).toISOString().split(".")[0] + "Z";
const appCrash = (minutesAgo: number, program: string) => ({ eventId: randomUUID(), kind: "error" as const, occurredAt: iso(minutesAgo), severityHint: "minor" as const,
  source: { ...APP_ERROR, recordId: rec++ }, detail: { message: crash(program) } });

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
  await storeEvents(db.app, k!, { events: [appCrash(30, "CabinetUI.exe"), appCrash(20, "CabinetUI.exe"), appCrash(10, "StatementViewer.exe")] });
  const rows = await alertsOf(k!);
  assert.deepEqual(rows.map(r => [r.title, Number(r.occurrences)]), [["CabinetUI.exe crashed", 2], ["StatementViewer.exe crashed", 1]]);
});

test("across the fleet: two programs crashing at five sites each are two fleet patterns, not one", async () => {
  const ids = await fleet(10), tag = randomBytes(3).toString("hex");
  for (const [i, k] of ids.entries())
    await storeEvents(db.app, k, { events: [i < 5 ? appCrash(15, `Pharmacy${tag}.exe`) : appCrash(15, `Reader${tag}.exe`)] });
  await sweepFleetPatterns(db.app);
  const mine = (await listFleetPatterns(db.app)).filter(p => p.title.includes(tag));
  assert.deepEqual(mine.map(p => [p.title.replace("Fleet pattern: ", ""), p.sites]).sort(),
    [[`Pharmacy${tag}.exe crashed`, 5], [`Reader${tag}.exe crashed`, 5]]);
});
