// Session 1's own tests (docs/platform/archive/control-half-plan.md): what a control request may name, what its entry's kind allows,
// what the confirmation covers, and the one audit row every outcome leaves. The platform's real effects (the audit write, the
// token, the issue) are stood in for, so every decision in services/app-control.ts is exercised without a database; the route's
// own 202 over a real database is app-control-e2e.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { CONTROL_ACTIONS, CONTROL_AUDIT_ACTION, CONTROL_CODES, MAX_ATTEMPTED, PROCESS_END_STEP_UP, SERVICE_CONTROL_STEP_UP,
  boundParams, controlApproved, type ControlEffects, type ControlRequest } from "../src/services/app-control.js";
import { appsHash, normalizeEntries, rawEntry, resolveLevels, type ApprovedApp } from "../src/services/approved-apps.js";
import { assertApprovedTarget, listProblem } from "../src/services/controlled-targets.js";
import { Refused } from "../src/services/errors.js";
import type { AuditEntry, Queryable } from "../src/db/db.js";
import type { Command } from "../src/contracts.js";

const CABINET = "0f1c8f0e-0000-4000-8000-0000000000aa";
const OTHER = "0f1c8f0e-0000-4000-8000-0000000000bb";
const USER = { userId: "0f1c8f0e-0000-4000-8000-000000000001", role: "tier2" as const };
const TOKEN = "t".repeat(43);
const AT = "2026-10-24T09:30:00.000Z";
const SPOOLER = { key: "app:spooler", kind: "service", name: "Spooler", serviceName: "Spooler", path: "C:\\Windows\\System32\\spoolsv.exe" };
const DISPENSER = { key: "app:dispenser", kind: "application", name: "Dispenser", path: "C:\\Program Files\\Dispenser\\dispenser.exe" };

const entriesOf = (raw: unknown): ApprovedApp[] => {
  const one = normalizeEntries(raw);
  assert.equal(one.ok, true, `expected a list, got ${JSON.stringify(one)}`);
  return one.ok ? one.entries : [];
};
/** A level's stored value in the owner's own form: what the column holds and what the list's own check verifies. */
const stored = (raw: unknown, over: Record<string, unknown> = {}): string => {
  const entries = entriesOf(raw);
  return JSON.stringify({ version: 3, entries: entries.map(rawEntry), hash: appsHash(entries), setBy: USER.userId, setAt: "2026-10-01T00:00:00.000Z", ...over });
};

interface Reading { at: Date; output: string | null }
const reading = (output: unknown): Reading => ({ at: new Date(AT), output: output === null ? null : JSON.stringify(output) });

/** The database as these decisions see it: the one list read (cabinets JOIN sites JOIN clients) and the two readings. */
function fakeDb(o: { levels?: Record<string, unknown> | null; services?: unknown; processes?: unknown } = {}): Queryable {
  const levels = o.levels === undefined ? { k: stored([SPOOLER, DISPENSER]), s: null, c: null, f: null } : o.levels;
  return {
    query: async (text: string, params: readonly unknown[] = []) => {
      if (text.includes("JOIN sites s")) {
        const rows = levels === null ? [] : [levels];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("JSON_QUERY(result")) {
        const operation = String(params[1]);
        const known: Record<string, unknown> = {
          "services.list": o.services === undefined ? { services: [{ name: "Spooler", state: "running" }] } : o.services,
          "processes.list": o.processes === undefined ? { processes: [{ processId: 4242, name: "dispenser", executablePath: DISPENSER.path }] } : o.processes,
        };
        const one = reading(known[operation] ?? null);
        return { rows: one.output === null ? [] : [one], rowCount: one.output === null ? 0 : 1 };
      }
      throw new Error(`unexpected statement: ${text}`);
    },
  } as unknown as Queryable;
}

const COMMAND = { commandId: "0f1c8f0e-0000-4000-8000-0000000000c1", issuedAt: "2026-10-24T09:30:01.000Z", expiresAt: "2026-10-24T09:35:01.000Z" } as unknown as Command;
interface Calls { row: AuditEntry[]; issue: unknown[][] }
function fakeEffects(o: { issueThrows?: unknown } = {}): { calls: Calls; effects: ControlEffects } {
  const calls: Calls = { row: [], issue: [] };
  return {
    calls,
    effects: {
      record: async (entry: AuditEntry) => { calls.row.push(entry); },
      issue: async (...args: unknown[]) => {
        calls.issue.push(args);
        if (o.issueThrows) throw o.issueThrows;
        return COMMAND;
      },
    },
  };
}

const body = (over: Partial<ControlRequest> = {}): ControlRequest => ({ cabinetId: CABINET, entryKey: "app:spooler", action: "stop", stepUpToken: TOKEN, ...over });
const refusalOf = async (b: ControlRequest, o: Parameters<typeof fakeDb>[0] = {}, e: Parameters<typeof fakeEffects>[0] = {}): Promise<{ code: string; status: number; message: string; calls: Calls }> => {
  const { calls, effects } = fakeEffects(e);
  try {
    await controlApproved(fakeDb(o), USER, b, effects);
    assert.fail("expected a refusal");
  } catch (err) {
    assert.ok(err instanceof Refused, `expected Refused, got ${String(err)}`);
    return { code: (err as Refused).code, status: (err as Refused).status, message: (err as Refused).message, calls };
  }
};
/** The one audit row a refusal leaves: the code the console reads, the key as it was sent, and why. */
const refusedRow = (calls: Calls, code: string): AuditEntry => {
  assert.equal(calls.row.length, 1, "a refusal leaves exactly one row");
  const row = calls.row[0]!;
  assert.equal(row.outcome, "refused");
  assert.equal(row.action, CONTROL_AUDIT_ACTION);
  assert.equal(row.targetKind, "cabinet");
  assert.equal((row.details as Record<string, unknown>).reason, code);
  assert.ok(typeof (row.details as Record<string, unknown>).why === "string");
  return row;
};

test("a service control is issued from the entry the list approves, with before from the cabinet's own report", async () => {
  const { calls, effects } = fakeEffects();
  const outcome = await controlApproved(fakeDb(), USER, body(), effects);
  assert.deepEqual(outcome, { commandId: COMMAND.commandId, issuedAt: COMMAND.issuedAt, expiresAt: COMMAND.expiresAt,
    entryKey: "app:spooler", action: "stop", operation: "service.control", target: { name: "Spooler", action: "stop" }, before: "running" });
  // The target is the entry's own service name and the action as sent - never anything else in the body.
  // The request's token goes with the command and is spent in its transaction, bound to this exact entry, action and cabinet.
  assert.deepEqual(calls.issue, [[USER, CABINET, "service.control", { name: "Spooler", action: "stop" }, TOKEN, boundParams(body())]]);
  assert.equal(calls.row.length, 1, "one row per request");
  const row = calls.row[0]!;
  assert.equal(row.outcome, "succeeded");
  assert.equal(row.actorKind, "user");
  assert.equal(row.actorId, USER.userId);
  assert.equal(row.targetId, CABINET);
  assert.deepEqual(row.details, { entryKey: "app:spooler", action: "stop", kind: "service", operation: "service.control",
    params: { name: "Spooler", action: "stop" }, commandId: COMMAND.commandId, listFrom: "cabinet", rejected: [], before: "running", after: "stopped", reportedAt: AT });
});

test("the most specific level with a list wins whole, and a level that was rejected is reported", async () => {
  // The fleet approves the spooler; this cabinet has a list of its own, and that is the only list consulted.
  const { calls } = fakeEffects();
  const fleetOnly = await refusalOf(body(), { levels: { k: stored([DISPENSER]), s: null, c: null, f: stored([SPOOLER]) } });
  assert.equal(fleetOnly.code, CONTROL_CODES.entryNotApproved);
  assert.equal(fleetOnly.status, 403);
  assert.match(fleetOnly.message, /not on the cabinet list that applies to this cabinet/);
  assert.deepEqual((refusedRow(fleetOnly.calls, CONTROL_CODES.entryNotApproved).details as Record<string, unknown>).listFrom, "cabinet");
  // With no list of its own the fleet's applies, and the same request is issued: the fallback is real, not a refusal of its own.
  const fleetWins = fakeEffects();
  const viaFleet = await controlApproved(fakeDb({ levels: { k: null, s: null, c: null, f: stored([SPOOLER]) } }), USER, body(), fleetWins.effects);
  assert.equal(viaFleet.operation, "service.control");
  assert.equal(fleetWins.calls.row[0]!.outcome, "succeeded");
  assert.equal((fleetWins.calls.row[0]!.details as Record<string, unknown>).listFrom, "fleet");
  // A cabinet list edited outside the platform does not describe its own entries: it approves nothing (the fleet's list is not used
  // instead, which would widen what a damaged level allows), and the row says so.
  const fallback = await refusalOf(body(), { levels: { k: stored([SPOOLER], { hash: "0".repeat(64) }), s: null, c: null, f: stored([DISPENSER]) } });
  assert.equal(fallback.code, CONTROL_CODES.entryNotApproved);
  const details = refusedRow(fallback.calls, CONTROL_CODES.entryNotApproved).details as Record<string, unknown>;
  assert.deepEqual([details.listFrom, details.rejected], ["cabinet", ["cabinet"]]);
  assert.match(fallback.message, /is damaged .* so it approves nothing/);
  // Nothing at any level, and a cabinet the platform does not have (or has removed), are two different answers.
  const nothing = await refusalOf(body(), { levels: { k: null, s: null, c: null, f: null } });
  assert.equal(nothing.code, CONTROL_CODES.entryNotApproved);
  assert.match(nothing.message, /has no approved-programs list: none is set for the cabinet, its site, its client or the fleet/);
  assert.match(nothing.message, /Admin > Approved programs/, "the refusal says where the list is set");
  const gone = await refusalOf(body(), { levels: null });
  assert.equal(gone.code, "not_found");
  assert.equal(gone.status, 404);
  refusedRow(gone.calls, "not_found");
  assert.equal(calls.issue.length, 0, "nothing was issued by any of the refusals above");
});

test("a key that is not an approved-list key at all is refused with a code and a sentence", async () => {
  for (const key of ["C:\\Program Files\\Dispenser\\dispenser.exe", "spooler", "svc:spooler", "", "app:", "app:a/b", "app:x\\y", `app:${"z".repeat(200)}`]) {
    const one = await refusalOf(body({ entryKey: key }));
    assert.equal(one.code, CONTROL_CODES.entryInvalid, `key ${JSON.stringify(key)}`);
    assert.equal(one.status, 400);
    assert.match(one.message, /the entry key is not an approved-list key/);
    refusedRow(one.calls, CONTROL_CODES.entryInvalid);
    assert.equal(one.calls.issue.length, 0);
    assert.equal(one.calls.issue.length, 0, "an invalid key never reaches the token");
  }
  // The shape check is not the approval: a well-formed key nobody approved is the other refusal, and it says which list applied.
  for (const key of ["app:unlisted", "app:BIG", "app:has space"]) {
    const one = await refusalOf(body({ entryKey: key }));
    assert.equal(one.code, CONTROL_CODES.entryNotApproved, `key ${JSON.stringify(key)}`);
    assert.deepEqual((refusedRow(one.calls, CONTROL_CODES.entryNotApproved).details as Record<string, unknown>).listFrom, "cabinet");
    assert.equal(one.calls.issue.length, 0);
  }
});

test("the action is checked against the entry's kind, and against the platform's own list of actions", async () => {
  assert.deepEqual([...CONTROL_ACTIONS], ["start", "stop", "restart", "end"]);
  // An application has no service handle: stopped and started is a service conversation, ended and restarted is its own.
  for (const action of ["start", "stop"]) {
    const one = await refusalOf(body({ entryKey: "app:dispenser", action }));
    assert.equal(one.code, CONTROL_CODES.actionNotAllowed);
    assert.equal(one.status, 403);
    assert.match(one.message, /an application entry is ended or restarted, not started or stopped/);
    refusedRow(one.calls, CONTROL_CODES.actionNotAllowed);
  }
  const restart = await refusalOf(body({ entryKey: "app:dispenser", action: "restart" }));
  assert.equal(restart.code, CONTROL_CODES.actionNotSupported);
  assert.equal(restart.status, 409);
  assert.match(restart.message, /not built yet/);
  // An action the platform does not define, including one that is only close to one it does.
  for (const action of ["kill", "Start", "start-stop", "start ", "", "end;calc"]) {
    const one = await refusalOf(body({ action }));
    assert.equal(one.code, CONTROL_CODES.actionUnknown, `action ${JSON.stringify(action)}`);
    assert.equal(one.status, 400);
    refusedRow(one.calls, CONTROL_CODES.actionUnknown);
    assert.equal(one.calls.issue.length, 0);
  }
  // A service is restarted through the service control manager, and its before/after are the operation's own words.
  const { calls, effects } = fakeEffects();
  const outcome = await controlApproved(fakeDb({ services: { services: [{ name: "Spooler", state: "stopped" }] } }), USER, body({ action: "restart" }), effects);
  assert.deepEqual(outcome.target, { name: "Spooler", action: "restart" });
  assert.deepEqual([outcome.before], ["stopped"]);
  assert.equal((calls.row[0]!.details as Record<string, unknown>).after, "running");
});

test("a process ID is a pointer into the cabinet's own report, never a target", async () => {
  const end = body({ entryKey: "app:dispenser", action: "end" });
  const noPid = await refusalOf(end);
  assert.deepEqual([noPid.code, noPid.status], [CONTROL_CODES.pidRequired, 400]);
  refusedRow(noPid.calls, CONTROL_CODES.pidRequired);
  // A cabinet that has never reported its processes: there is nothing an ID could have been resolved against.
  const never = await refusalOf({ ...end, processId: 4242 }, { processes: null });
  assert.deepEqual([never.code, never.status], [CONTROL_CODES.processNoReading, 409]);
  assert.match(never.message, /has never reported its processes/);
  // An ID the cabinet's own list does not have, including one a hand-edited reading cannot steer past.
  for (const processes of [
    { processes: [{ processId: 7, name: "explorer", executablePath: DISPENSER.path }] },
    { processes: [{ processId: "4242", name: "dispenser", executablePath: DISPENSER.path }, { processId: 4242.5, name: "x", executablePath: DISPENSER.path }] },
  ]) {
    const one = await refusalOf({ ...end, processId: 4242 }, { processes });
    assert.equal(one.code, CONTROL_CODES.processUnreported);
    assert.equal(one.status, 404);
    assert.match(one.message, new RegExp(`no process 4242`));
    refusedRow(one.calls, CONTROL_CODES.processUnreported);
    assert.equal(one.calls.issue.length, 0);
  }
  // The ID exists, but the program under it is not the program this entry approves - or Windows gave no path at all.
  for (const row of [{ processId: 4242, name: "other", executablePath: "C:\\Program Files\\Other\\other.exe" }, { processId: 4242, name: "dispenser", executablePath: null }]) {
    const one = await refusalOf({ ...end, processId: 4242 }, { processes: { processes: [row] } });
    assert.equal(one.code, CONTROL_CODES.processNotApproved);
    assert.equal(one.status, 403);
    assert.match(one.message, /is not the program this entry approves/);
    const details = refusedRow(one.calls, CONTROL_CODES.processNotApproved).details as Record<string, unknown>;
    assert.deepEqual([details.reportedPath, details.approvedPath], [row.executablePath, DISPENSER.path]);
  }
  // The program matches: both values sent come from the cabinet's report, so a re-used ID names a different program and the agent refuses it.
  const { calls, effects } = fakeEffects();
  const outcome = await controlApproved(fakeDb(), USER, { ...end, processId: 4242 }, effects);
  assert.deepEqual(outcome.target, { processId: 4242, name: "dispenser" });
  assert.deepEqual(outcome.before, { processId: 4242, name: "dispenser", executablePath: DISPENSER.path });
  // A code-level write: its own token is spent inside the command's transaction.
  assert.deepEqual(calls.issue, [[USER, CABINET, "process.end", { processId: 4242, name: "dispenser" }, TOKEN, boundParams({ ...end, processId: 4242 })]]);
  assert.equal((calls.row[0]!.details as Record<string, unknown>).operation, "process.end");
  // A service entry can be ended as the process its own path names: the same pointer rule, on the same list.
  const svcEnd = fakeEffects();
  const svc = await controlApproved(fakeDb({ services: { services: [{ name: "Spooler", state: "running" }] }, processes: { processes: [{ processId: 1, name: "spoolsv", executablePath: SPOOLER.path }] } }),
    USER, { cabinetId: CABINET, entryKey: "app:spooler", action: "end", processId: 1, stepUpToken: TOKEN }, svcEnd.effects);
  assert.deepEqual([svc.operation, svc.target], ["process.end", { processId: 1, name: "spoolsv" }]);
  assert.equal((svcEnd.calls.row[0]!.details as Record<string, unknown>).kind, "service");
});

test("a process name is compared the way Windows compares it, whatever case the cabinet reports", async () => {
  // The command path the console and the CLI use carries a name as well as an ID (assertApprovedTarget), and Windows
  // compares process names without regard to case: a real desktop reports "Notepad.exe" while a caller may write
  // "notepad.exe". This was a live defect on a real cabinet - a correct process ID was refused as "no such process ID
  // with that name" and no command was ever issued - because every fixture here spelled both sides lower case.
  const reported = [{ processId: 9, name: "Dispenser.exe", executablePath: DISPENSER.path }];
  const db = fakeDb({ processes: { processes: reported } });
  await assertApprovedTarget(db, CABINET, "process.end", { processId: 9, name: "dispenser.exe" });
  await assertApprovedTarget(db, CABINET, "process.end", { processId: 9, name: "DISPENSER.EXE" });
  // Case is the only thing ignored: another program under that ID, and that name under another ID, are both refused.
  for (const params of [{ processId: 9, name: "elsewhere.exe" }, { processId: 8, name: "Dispenser.exe" }]) {
    await assert.rejects(assertApprovedTarget(db, CABINET, "process.end", params), (e: unknown) => {
      assert.equal((e as Refused).code, CONTROL_CODES.processUnreported);
      assert.equal((e as Refused).status, 404);
      return true;
    });
  }
  // The approved entry's path is what decides whether the program may be controlled; the name is only the pointer.
  const noPath = fakeDb({ processes: { processes: [{ processId: 9, name: "Dispenser.exe", executablePath: null }] } });
  await assert.rejects(assertApprovedTarget(noPath, CABINET, "process.end", { processId: 9, name: "dispenser.exe" }),
    (e: unknown) => (e as Refused).code === CONTROL_CODES.processNotApproved);
});

test("the confirmation is bound to this exact entry, action and cabinet", async () => {
  const noToken = await refusalOf(body({ stepUpToken: "" }));
  assert.deepEqual([noToken.code, noToken.status], ["step_up_required", 403]);
  assert.equal(noToken.calls.issue.length, 0, "a request with no token spends nothing");
  refusedRow(noToken.calls, "step_up_required");
  // What the token is spent on is the body without the token: this entry, this action, this cabinet.
  const bound = boundParams(body());
  assert.deepEqual(bound, { cabinetId: CABINET, entryKey: "app:spooler", action: "stop" });
  assert.deepEqual(Object.keys(boundParams(body({ processId: 7 }))).sort(), ["action", "cabinetId", "entryKey", "processId"]);
  assert.notDeepEqual(boundParams(body()), boundParams(body({ entryKey: "app:dispenser" })));
  assert.notDeepEqual(boundParams(body()), boundParams(body({ action: "start" })));
  assert.notDeepEqual(boundParams(body()), boundParams(body({ cabinetId: OTHER })));
  // A token bought for another entry is spent nowhere: the refusal names the operation the token had to cover.
  const wrongScope = await refusalOf(body(), {}, { issueThrows: new Refused("step_up_required", 403, "a valid step-up token for this exact action is required") });
  assert.equal(wrongScope.code, CONTROL_CODES.stepUpWrongScope);
  assert.equal(wrongScope.status, 403);
  assert.match(wrongScope.message, /confirm stop on app:spooler again/);
  const details = refusedRow(wrongScope.calls, CONTROL_CODES.stepUpWrongScope).details as Record<string, unknown>;
  assert.deepEqual([details.operation, details.stepUpAction], ["service.control", SERVICE_CONTROL_STEP_UP]);
  assert.equal(wrongScope.calls.issue.length, 1, "the token is refused inside the issue, which then records nothing of its own");
  // Any other refusal from the token or the command is carried out with its own code and status.
  const other = await refusalOf(body(), {}, { issueThrows: new Refused("cabinet_offline", 503, "the cabinet is not connected") });
  assert.deepEqual([other.code, other.status], ["cabinet_offline", 503]);
  refusedRow(other.calls, "cabinet_offline");
  // A failure that is not a refusal at all is recorded as failed before it is thrown on.
  const { calls, effects } = fakeEffects({ issueThrows: new Error("the outbox refused the command") });
  await assert.rejects(() => controlApproved(fakeDb(), USER, body(), effects), /the outbox refused the command/);
  assert.equal(calls.row.length, 1);
  assert.deepEqual([calls.row[0]!.outcome, (calls.row[0]!.details as Record<string, unknown>).reason], ["failed", "control_failed"]);
  assert.equal((calls.row[0]!.details as Record<string, unknown>).operation, "service.control");
});

test("a hostile key is recorded, but it cannot smuggle control characters in or fill the row", async () => {
  const hostile = `app:b\u0000ad\nname${"x".repeat(300)}`;
  const one = await refusalOf(body({ entryKey: hostile }));
  assert.equal(one.code, CONTROL_CODES.entryInvalid);
  const details = refusedRow(one.calls, CONTROL_CODES.entryInvalid).details as Record<string, unknown>;
  const kept = String(details.entryKey);
  assert.equal(kept.length, MAX_ATTEMPTED);
  assert.equal(/[\u0000-\u001f\u007f]/.test(kept), false, "no control character survives into the audit row");
  assert.equal(kept.slice(0, 9), "app:b?ad?");
  // The cabinet id is recorded the same way, and the token itself is never in the row.
  const badId = await refusalOf(body({ cabinetId: `not-a-uuid\ttab${"y".repeat(80)}` }));
  const idDetails = refusedRow(badId.calls, "invalid_params").details as Record<string, unknown>;
  assert.equal(String(badId.calls.row[0]!.targetId).length, MAX_ATTEMPTED);
  assert.equal(/"stepUpToken"|"{43}"/.test(JSON.stringify(idDetails)), false);
});

test("a refusal says why nothing matched and where an Admin sets the list: none set, damaged, empty, or not on it", () => {
  const why = (levels: Record<string, unknown>) => listProblem(resolveLevels(levels), "that service");
  // The hardware test's cabinet: no level set a list, and the old refusal only said the service was not on it.
  assert.match(why({}), /^this cabinet has no approved-programs list: .* An Admin sets one in the console under Admin > Approved programs$/);
  assert.match(why({ client: stored([]) }), /^the client list that applies to this cabinet is empty, so it approves nothing\. An Admin adds programs under Admin > Approved programs$/);
  assert.match(why({ site: stored([DISPENSER]) }), /^that service is not on the site list that applies to this cabinet\. An Admin adds it under Admin > Approved programs$/);
  // A list written by hand without its hash wins and denies everything (never the level above): the refusal names it as damaged.
  const damaged = why({ cabinet: stored([SPOOLER], { hash: "0".repeat(64) }), fleet: stored([SPOOLER]) });
  assert.match(damaged, /^that service is not approved; the cabinet list is damaged .* until an Admin saves it again under Admin > Approved programs$/);
  // A damaged level below the one in force is still mentioned, so it is not a surprise when a list above it is removed.
  assert.match(why({ site: stored([DISPENSER]), fleet: "not json" }), /not on the site list .*; the fleet list is damaged/);
});
