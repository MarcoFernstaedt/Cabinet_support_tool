// The USB layer's data side, exercised without a database: a fake pool and transaction that record every statement and
// its parameters, so the wiring is verified even though the SQL itself needs a live SQL Server (usb-sql.test.ts checks
// the statements against the migration; this checks what the store does with them).
//
// What it pins: the contract check runs before any statement; a scope has to exist before a policy is written; the
// version goes up from whatever is stored; the settings write and its audit entry are the only writes for a policy
// change; a step-up token is consumed for this exact action and target, before the write; a report from another cabinet
// is refused; one report reads the incidents and the catalogue once however many units it carries; an absent unit opens
// the incident its return later closes — the signature written is the signature resolved, round trip.
import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "../src/db/db.js";
import { USB_POLICY_SETTING_KEY, parseUsbWatchPolicy, usbPolicySettingKey, usbStepUpAction } from "../src/services/usb-policy.js";
import { USB_RESOLUTION_TEXT, usbIncidentKey } from "../src/services/usb-rules.js";
import { applyUsbReport, clearUsbPolicy, setUsbPolicy } from "../src/services/usb-store.js";

const CABINET = "6f1d1f9e-3d3a-4a5b-8f0e-1b2c3d4e5f60";
const SITE = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";
const CLIENT = "9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f";
const USER = "7c6b5a49-3827-4615-a4b3-c2d1e0f9a8b7";
const TOKEN_HASH = "a".repeat(64);
const UNIT = "UNIT-1";

/** One statement the store issued, with the parameters it carried. */
interface Called { sql: string; params: readonly unknown[] }

type Answer = { rows?: unknown[]; rowCount?: number };
type Router = (sql: string, params: readonly unknown[], calls: readonly Called[]) => Answer | null;

/** A recording stand-in for the pool and its transaction, with a router that answers statement by statement. */
function fake(route: Router = () => null): { pool: Pool; calls: Called[] } {
  const calls: Called[] = [];
  const tx = {
    async query(sql: string, params: readonly unknown[] = []): Promise<Answer & { recordset: unknown[] }> {
      calls.push({ sql, params });
      const answer = route(sql, params, calls) ?? {};
      const rows = answer.rows ?? [];
      return { rows, rowCount: answer.rowCount ?? rows.length, recordset: rows };
    },
  };
  return { pool: { transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as Pool, calls };
}

/** The statements issued, in order, for a readable failure message. */
const issued = (calls: readonly Called[]): string => calls.map(c => `${c.sql.replace(/\s+/g, " ").slice(0, 90)} [${c.params.length}]`).join("\n");

/** What every test starts from: a live cabinet with a live site, nothing stored, one audit entry per call, no lock trouble. */
const base: Router = (sql, _params, calls) => {
  if (/FROM (cabinets|sites|clients) WHERE/.test(sql)) return { rows: [{ ok: 1 }], rowCount: 1 };
  if (/FROM cabinets cab/.test(sql)) return { rows: [levelsRow(null)] };
  if (/EXEC audit_append\b/.test(sql)) return { rows: [{ seq: String(calls.filter(c => /audit_append/.test(c.sql)).length) }] };
  if (/sp_getapplock/.test(sql)) return { rowCount: 0 };
  return null;
};

/** `base` plus whatever this test adds (the test's own answers win); anything neither answers is answered with no rows. */
const route = (...extra: Router[]): Router => (sql, params, calls) => {
  for (const r of [...extra, base]) {
    const answer = r(sql, params, calls);
    if (answer !== null) return answer;
  }
  return {};
};

/** The scope's stored document for a policy that watches UNIT-1. */
const stored = (version: number, over: Record<string, unknown> = {}): string => JSON.stringify({ version, policy: policyInput(over) });

/** A policy that watches UNIT-1, as the console would send it. */
const policyInput = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  identityKey: { kind: "device", value: UNIT, confidence: "high" },
  enabled: true,
  absentForMinutes: 5,
  reconnect: { count: 3, windowMinutes: 10 },
  quietHours: null,
  severity: {},
  autoRestart: false,
  ...over,
});

/** The four rows the join returns: a cabinet policy, nothing at site or client, none at fleet. */
const levelsRow = (storedAt: string | null): Record<string, unknown> => ({ cabinet: storedAt, site: null, client: null, fleet: null, site_id: SITE, client_id: CLIENT });

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

const device = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  unitKey: UNIT, portKey: "SLOT-9", parentKey: null, parentRootCause: "none", identity: "serial", identityConfidence: "high",
  instanceId: "USB\\VID_0BDA&PID_8153\\000001", serialHash: "b".repeat(64), portDisplay: "Port_#0002.Hub_#0003",
  state: "present", firstSeenAt: iso(-6 * 3600_000), lastSeenAt: iso(-60_000), firstAbsentAt: null, reconnectCount: 0,
  reconnectWindowMinutes: 10, cyclesAreLowerBound: false, healthySamples: 3, transitions: [], workload: [], workloadProbe: "none",
  ...over,
});

const absentDevice = (): Record<string, unknown> => device({ state: "absent", firstAbsentAt: iso(-10 * 60_000), lastSeenAt: iso(-11 * 60_000), healthySamples: 0 });

const report = (devices: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  cabinetId: CABINET, bootId: CABINET, reportedAt: iso(0), monitorState: "present", settled: true,
  eventHistoryComplete: true, sweepSeconds: 60, devices, ...over,
});

/** Every alert the store folded, with the signature it carried (the fold's fourth parameter). */
const foldedSignatures = (calls: readonly Called[]): string[] =>
  calls.filter(c => /DECLARE @o TABLE/.test(c.sql)).map(c => String(c.params[3]));

/** The statements that change a row, for asserting that a quiet path changed nothing. */
const writeStatements = (calls: readonly Called[]): Called[] => calls.filter(c => /^(UPDATE|INSERT|DELETE)/.test(c.sql.replace(/\s+/g, " ").trim()));

test("a valid policy is stored under the scope's key, versioned, with one audit entry and nothing else written", async () => {
  const { pool, calls } = fake(route());
  const policy = await setUsbPolicy(pool, USER, "cabinet", CABINET, policyInput());

  assert.equal(policy.enabled, true, issued(calls));
  const existence = calls.find(c => /FROM cabinets WHERE/.test(c.sql));
  assert.ok(existence, `the cabinet was never checked for:\n${issued(calls)}`);
  assert.deepEqual(existence.params, [CABINET]);

  const key = usbPolicySettingKey("cabinet", CABINET);
  const writes = calls.filter(c => /settings/.test(c.sql) && !/SELECT \[value\]/.test(c.sql));
  assert.equal(writes.length, 2, `a policy change writes the settings row twice (update, then insert-if-absent):\n${issued(calls)}`);
  for (const w of writes) {
    assert.equal(w.params[0], key, `the settings key is not the scope's own:\n${issued(calls)}`);
    assert.deepEqual(JSON.parse(String(w.params[1])), { version: 1, policy: parseUsbWatchPolicy(policyInput()) }, "the row does not hold the policy at version 1 as the contract validates it (settle timings filled in)");
    assert.equal(w.params[2], USER, "the write is not attributed to the operator who made it");
  }
  const audits = calls.filter(c => /EXEC audit_append\b/.test(c.sql));
  assert.equal(audits.length, 1, `a policy change appends exactly one audit entry:\n${issued(calls)}`);
  const details = JSON.parse(String(audits[0]!.params[6]));
  assert.equal(details.before, null, "there was nothing stored before, so the entry says so");
  assert.equal(details.after.identityKey.value, UNIT);
  assert.equal(audits[0]!.params[2], usbStepUpAction("cabinet"));
});

test("a policy already stored at version 4 is written at 5, and the audit entry carries what it replaced", async () => {
  const { pool, calls } = fake(route(sql => (/SELECT \[value\] FROM settings/.test(sql) ? { rows: [{ value: stored(4) }] } : null)));
  await setUsbPolicy(pool, USER, "site", SITE, policyInput({ absentForMinutes: 30 }));
  const write = calls.find(c => /UPDATE settings SET/.test(c.sql));
  assert.ok(write, `nothing was written:\n${issued(calls)}`);
  const written = JSON.parse(String(write.params[1]));
  assert.equal(written.version, 5, `the version did not move past the stored one:\n${issued(calls)}`);
  assert.equal(written.policy.absentForMinutes, 30);
  assert.equal(write.params[0], usbPolicySettingKey("site", SITE), `the site's own key was not used:\n${issued(calls)}`);
  const details = JSON.parse(String(calls.find(c => /EXEC audit_append\b/.test(c.sql))!.params[6]));
  assert.equal(details.before.absentForMinutes, 5, "the entry does not say what was in force before");
  assert.equal(details.before.version ?? null, null, "the stored version is not part of the policy itself");

  // A site policy also refuses a missing id, before it goes looking for anything.
  const empty = fake();
  await assert.rejects(() => setUsbPolicy(empty.pool, USER, "site", null, policyInput()), /needs an id/);
  assert.equal(empty.calls.length, 0, "a refusal still ran statements");
});

test("a policy that fails the contract is refused before a single statement runs", async () => {
  const { pool, calls } = fake();
  await assert.rejects(() => setUsbPolicy(pool, USER, "cabinet", CABINET, { ...policyInput(), absentForMinutes: -1 }), /usb policy/);
  await assert.rejects(() => setUsbPolicy(pool, USER, "cabinet", CABINET, { ...policyInput(), nonsense: true }), /usb policy/);
  await assert.rejects(() => setUsbPolicy(pool, USER, "cabinet", CABINET, { ...policyInput(), identityKey: { kind: "device" } }), /usb policy/);
  assert.deepEqual(calls, [], `a refused request must not reach the database:\n${issued(calls)}`);
});

test("a policy for a scope that is not there is refused; clearing a row that is not there is not an error", async () => {
  const gone = fake(sql => (
    /FROM (cabinets|clients) WHERE/.test(sql) ? { rows: [], rowCount: 0 }
      : /EXEC audit_append\b/.test(sql) ? { rows: [{ seq: "1" }] }
        : /FROM cabinets cab/.test(sql) ? { rows: [levelsRow(null)] }
          : null));
  await assert.rejects(() => setUsbPolicy(gone.pool, USER, "cabinet", CABINET, policyInput()), /no such cabinet/);
  assert.equal(gone.calls.filter(c => /settings|audit_append/.test(c.sql)).length, 0, `something was written for a cabinet that is gone:\n${issued(gone.calls)}`);
  await assert.rejects(() => setUsbPolicy(gone.pool, USER, "client", CLIENT, policyInput()), /no such client/);

  // Clearing is the one write that does not need the scope to still exist: a row left by a retired scope can go.
  const clearing = fake(route());
  await clearUsbPolicy(clearing.pool, USER, "cabinet", CABINET);
  assert.equal(clearing.calls.filter(c => /FROM cabinets WHERE/.test(c.sql)).length, 0, `clearing a policy looked the scope up:\n${issued(clearing.calls)}`);
  assert.deepEqual(clearing.calls.find(c => /DELETE FROM settings/.test(c.sql))!.params, [usbPolicySettingKey("cabinet", CABINET)]);
});

test("the step-up token is consumed for this exact action and target, before anything is written", async () => {
  // A token is spent as a digest of the token the console collected, carrying the hash it was bound to, for this exact
  // action and target, and only while it is unused and unexpired (the update carries those conditions itself).
  const ok = fake(route(sql => (/step_up_tokens/.test(sql) ? { rowCount: 1 } : null)));
  await setUsbPolicy(ok.pool, USER, "cabinet", CABINET, policyInput(), `${TOKEN_HASH}.${"b".repeat(64)}`);
  const consumed = ok.calls.find(c => /step_up_tokens/.test(c.sql));
  assert.ok(consumed, `the token was never spent:\n${issued(ok.calls)}`);
  assert.equal(consumed.params[1], USER);
  assert.equal(consumed.params[2], usbStepUpAction("cabinet"));
  assert.equal(consumed.params[3], CABINET);
  assert.ok(Buffer.isBuffer(consumed.params[0]) && (consumed.params[0] as Buffer).length === 32, `the token is not looked up as a sha256 digest: ${String(consumed.params[0])}`);
  assert.equal(consumed.params[4], "b".repeat(64), "the hash the token was bound to is not the one it carried");
  const order = ok.calls.map(c => (/step_up_tokens/.test(c.sql) ? "token" : /UPDATE settings SET/.test(c.sql) ? "write" : "other"));
  assert.ok(order.indexOf("token") < order.indexOf("write"), `the token has to be spent before the write:\n${issued(ok.calls)}`);

  // A token that does not match (already used, expired, or another operator's) stops the write. The read that decides
  // the next version happens first — the version has to be known — but nothing is written or audited.
  const stale = fake(route(sql => (/step_up_tokens/.test(sql) ? { rowCount: 0 } : null)));
  await assert.rejects(() => setUsbPolicy(stale.pool, USER, "cabinet", CABINET, policyInput(), TOKEN_HASH), /step-up token/);
  assert.equal(stale.calls.filter(c => /UPDATE settings SET|INSERT INTO settings|EXEC audit_append/.test(c.sql)).length, 0, `a policy was written without a valid token:\n${issued(stale.calls)}`);
});

test("clearing a policy deletes exactly one row and audits what was removed", async () => {
  const { pool, calls } = fake(route(sql => (/SELECT \[value\] FROM settings/.test(sql) ? { rows: [{ value: stored(2) }] } : null)));
  await clearUsbPolicy(pool, USER, "cabinet", CABINET);
  const deletes = calls.filter(c => /DELETE FROM settings/.test(c.sql));
  assert.equal(deletes.length, 1, issued(calls));
  assert.deepEqual(deletes[0]!.params, [usbPolicySettingKey("cabinet", CABINET)]);
  const details = JSON.parse(String(calls.find(c => /EXEC audit_append\b/.test(c.sql))!.params[6]));
  assert.equal(details.after, null);
  assert.equal(details.before.absentForMinutes, 5, "the entry does not record the policy that was cleared");

  // The fleet policy is the one level that has no id of its own.
  const fleet = fake(route());
  await clearUsbPolicy(fleet.pool, USER, "fleet", null);
  assert.deepEqual(fleet.calls.find(c => /DELETE FROM settings/.test(c.sql))!.params, [USB_POLICY_SETTING_KEY]);
});

test("a policy the layer cannot use never becomes the 'before' of an audit entry", async () => {
  // A row from a newer version of the platform, or a truncated one: the write still goes through, but the entry says
  // nothing about what was there rather than repeating a document the layer does not understand.
  const { pool, calls } = fake(route(
    sql => (/FROM cabinets cab/.test(sql) ? { rows: [levelsRow(JSON.stringify({ version: 99, policy: { identityKey: { kind: "device", value: "UNIT-9" } } }))] } : null),
    sql => (/SELECT \[value\] FROM settings/.test(sql) ? { rows: [{ value: "{ this is not json" }] } : null),
  ));
  await setUsbPolicy(pool, USER, "cabinet", CABINET, policyInput());
  const write = calls.find(c => /UPDATE settings SET/.test(c.sql));
  assert.ok(write, `the write did not happen:\n${issued(calls)}`);
  assert.equal(JSON.parse(String(write.params[1])).version, 1, "a document the layer cannot read is not a version to move past");
  const details = JSON.parse(String(calls.find(c => /EXEC audit_append\b/.test(c.sql))!.params[6]));
  assert.equal(details.before, null);
});

test("a report from another cabinet, or one that fails the contract, is refused with nothing read or written", async () => {
  const { pool, calls } = fake();
  await assert.rejects(() => applyUsbReport(pool, CABINET, report([device()], { cabinetId: CLIENT })), /another cabinet/);
  await assert.rejects(() => applyUsbReport(pool, CABINET, report([device({ state: "exploded" })])), /usb report/);
  await assert.rejects(() => applyUsbReport(pool, CABINET, report([])), /usb report/);
  assert.deepEqual(calls, [], `a refused report must not reach the database:\n${issued(calls)}`);
});

test("one report reads the incidents and the issue catalogue once, whatever it carries", async () => {
  const { pool, calls } = fake(route(
    sql => (/FROM cabinets cab/.test(sql) ? { rows: [levelsRow(stored(1))] } : null),
    sql => (/FROM issue_types/.test(sql) ? { rows: [{ key: "usb_missing", id: "id-missing", name: "Expected USB device not detected", severity: "minor" }] } : null),
    sql => (/FROM alerts a/.test(sql) ? { rows: [] } : null),
    sql => (/DECLARE @o TABLE/.test(sql) ? { rows: [{ id: "alert-1" }] } : null),
  ));
  const devices = [absentDevice(), absentDevice(), absentDevice(), device(), device({ unitKey: "UNIT-2" })];
  const counts = await applyUsbReport(pool, CABINET, report(devices));
  assert.equal(calls.filter(c => /FROM issue_types/.test(c.sql)).length, 1, `the catalogue is read per device:\n${issued(calls)}`);
  assert.equal(calls.filter(c => /FROM alerts a/.test(c.sql)).length, 1, `the open incidents are read per device:\n${issued(calls)}`);
  assert.equal(counts.decisions, counts.opened + counts.updated, `the tally does not add up: ${JSON.stringify(counts)}`);
});

test("an absent unit opens the incident, and the report of its return closes the same signature", async () => {
  const open: unknown[] = [];
  const incidents: Router = sql => (/FROM alerts a/.test(sql) ? { rows: open } : null);
  const rest = route(
    sql => (/FROM cabinets cab/.test(sql) ? { rows: [levelsRow(stored(1))] } : null),
    incidents,
    sql => (/FROM issue_types/.test(sql) ? { rows: [{ key: "usb_missing", id: "id-missing", name: "Expected USB device not detected", severity: "minor" }] } : null),
    sql => (/DECLARE @o TABLE/.test(sql) ? { rows: [{ id: "alert-1" }] } : null),
  );

  // The unit goes absent: the rule opens one incident, and the signature it writes is the one the layer will look for.
  const gone = fake(rest);
  const opened = await applyUsbReport(gone.pool, CABINET, report([absentDevice()]));
  const signatures = foldedSignatures(gone.calls);
  assert.equal(opened.opened, 1, `an absent unit past its threshold opens one incident:\n${issued(gone.calls)}\n${JSON.stringify(opened)}`);
  assert.equal(signatures.length, 1, `one alert written, not ${signatures.length}:\n${issued(gone.calls)}`);
  assert.equal(signatures[0], usbIncidentKey("usb-absent", UNIT), `the incident is not the one the rules name:\n${issued(gone.calls)}`);
  assert.equal(opened.resolved, 0);

  // Now the cabinet carries that incident, and the unit is back and healthy: the same report closes it.
  open.push({ signature: signatures[0], severity: "minor", occurrences: 1, last_seen: new Date(Date.now() - 20 * 60_000) });
  const back = fake(rest);
  const closed = await applyUsbReport(back.pool, CABINET, report([device()]));
  const resolves = back.calls.filter(c => /SET state = 'resolved'/.test(c.sql));
  assert.equal(resolves.length, 1, `the incident was not closed:\n${issued(back.calls)}\n${JSON.stringify(closed)}`);
  assert.equal(resolves[0]!.params[0], CABINET);
  assert.equal(resolves[0]!.params[1], signatures[0], "the resolution does not seek the signature the incident was opened under");
  assert.equal(resolves[0]!.params[2], USB_RESOLUTION_TEXT["usb-absent"], "the resolution text is not the one the rules carry for the absent rule");
  assert.equal(closed.resolved, 1, `the tally does not report the closure: ${JSON.stringify(closed)}`);
  assert.equal(closed.opened, 0, `a unit that is back opened something: ${JSON.stringify(closed)}`);

  // An incident the rules cannot attribute to a unit on this report is left alone: no resolve statement at all.
  open.length = 0;
  open.push({ signature: usbIncidentKey("usb-absent", "A-UNIT-THAT-LEFT"), severity: "minor", occurrences: 1, last_seen: new Date() });
  const other = fake(rest);
  const untouched = await applyUsbReport(other.pool, CABINET, report([device()]));
  assert.equal(other.calls.filter(c => /SET state = 'resolved'/.test(c.sql)).length, 0, `another unit's incident was closed:\n${issued(other.calls)}`);
  assert.equal(untouched.resolved, 0, JSON.stringify(untouched));

  // Nothing to say at all: a present, healthy watched unit with no open incident writes nothing. (The catalogue here
  // holds only the absent rule's issue type, so the other two rules hold rather than page for a name they cannot give.)
  open.length = 0;
  const quiet = fake(rest);
  const nothing = await applyUsbReport(quiet.pool, CABINET, report([device()]));
  assert.deepEqual(
    { decisions: nothing.decisions, opened: nothing.opened, updated: nothing.updated, resolved: nothing.resolved, silent: nothing.silent, suppressed: nothing.suppressed, unwatched: nothing.unwatched },
    { decisions: 0, opened: 0, updated: 0, resolved: 0, silent: 0, suppressed: 0, unwatched: 0 },
    `a quiet report decided something:\n${issued(quiet.calls)}\n${JSON.stringify(nothing)}`,
  );
  assert.deepEqual(writeStatements(quiet.calls), [], `a quiet report wrote something:\n${issued(quiet.calls)}`);
});

test("a rule whose issue type is missing from the catalogue holds instead of paging for a name it cannot give", async () => {
  const { pool, calls } = fake(route(
    sql => (/FROM issue_types/.test(sql) ? { rows: [] } : null),
    sql => (/FROM alerts a/.test(sql) ? { rows: [] } : null),
  ));
  const counts = await applyUsbReport(pool, CABINET, report([absentDevice()]));
  assert.equal(counts.holds, 1, `the rule did not hold:\n${issued(calls)}\n${JSON.stringify(counts)}`);
  assert.equal(counts.opened, 0);
  assert.deepEqual(writeStatements(calls), [], `an alert was written for an issue type the platform does not know:\n${issued(calls)}`);
});

test("a unit no level watches is reported as unwatched and writes nothing", async () => {
  const { pool, calls } = fake(route(
    sql => (/FROM cabinets cab/.test(sql) ? { rows: [levelsRow(null)] } : null),
    sql => (/FROM issue_types/.test(sql) ? { rows: [{ key: "usb_missing", id: "id-missing", name: "Expected USB device not detected", severity: "minor" }] } : null),
    sql => (/FROM alerts a/.test(sql) ? { rows: [] } : null),
  ));
  const counts = await applyUsbReport(pool, CABINET, report([device({ unitKey: "NOBODY-WATCHES-ME" })]));
  assert.equal(counts.decisions, 0, `an unwatched unit produced a decision:\n${issued(calls)}\n${JSON.stringify(counts)}`);
  assert.deepEqual(writeStatements(calls), [], issued(calls));
});
