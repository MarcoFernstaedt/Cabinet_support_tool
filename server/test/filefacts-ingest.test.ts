// What comes back from a read: the contract check, the admission rules that keep a
// report to metadata about the named paths, the version difference, and the alert the drift machinery raises or clears.
//
// The report is hostile telemetry: nearly every case here is something a wrong or compromised cabinet could send.
import test from "node:test";
import assert from "node:assert/strict";
import type { Queryable } from "../src/db/db.js";
import { APP_VERSION_ISSUE, FACTS_OPERATION, admitReport, ingestFacts, observedItems, parseReport, reconcileVersionAlert, storedRead, versionDrift, versionTitle,
  type FactsReport, type ReportFile } from "../src/services/filefacts-ingest.js";
import { allowlistHash, type AllowlistEntry } from "../src/services/filefacts-allowlist.js";
import { buildPlan, requestOf, type Caps, type Plan } from "../src/services/filefacts-request.js";
import { Refused } from "../src/services/errors.js";
import type { ResolvedItem, Origin } from "../src/services/baselines.js";

const caps: Caps = { maxFiles: 3, maxFileBytes: 4096, maxTotalBytes: 8192, maxElapsedMs: 5000, maxPerHour: 2 };
const CABINET = "0f1c8f0e-0000-4000-8000-000000000002";
const entryOf = (key: string, over: Partial<AllowlistEntry> = {}): AllowlistEntry => ({ key, root: "C:\\App", name: "app.exe", includeSha256: false, maxBytes: 4096, ...over });
const planWith = (entries: AllowlistEntry[]): Plan => buildPlan({ version: 2, entries, hash: allowlistHash(entries), setBy: "user", setAt: "2026-10-01T00:00:00.000Z" }, caps);
const file = (over: Record<string, unknown> = {}): ReportFile =>
  ({ key: "app:dispenser", status: "ok", signatureStatus: "valid", openedPath: "C:\\App\\app.exe", reparsePoint: false, observedAt: "2026-10-23T10:00:00.000Z", productVersion: "7.4.1", sizeBytes: 1024, ...over }) as ReportFile;
const report = (files: ReportFile[], over: Record<string, unknown> = {}): FactsReport =>
  ({ takenAt: "2026-10-23T10:00:00.000Z", allowlistVersion: 2, files, fileCount: files.length, totalBytes: files.length * 1024, elapsedMs: 100, truncated: false, ...over }) as FactsReport;
const refuses = (raw: unknown): Refused => {
  try {
    parseReport(raw);
    assert.fail("expected a refusal");
  } catch (e) {
    assert.ok(e instanceof Refused, `expected Refused, got ${String(e)}`);
    assert.equal((e as Refused).code, "invalid_result");
    assert.equal((e as Refused).status, 400);
    return e as Refused;
  }
};

test("the report is checked against its contract before anything else looks at it", () => {
  const good = parseReport(report([file()]));
  assert.equal(good.files.length, 1);
  assert.equal(good.files[0]?.openedPath, "C:\\App\\app.exe");
  // File content smuggled in as an extra property: refused, and the refusal says nothing about the value.
  const smuggled = refuses(report([{ ...file(), content: "SECRET-FILE-CONTENT" } as unknown as ReportFile]));
  assert.equal(smuggled.message.includes("SECRET"), false);
  assert.match(smuggled.message, /invalid_result|did not match its contract/);
});

test("a report that is not the shape the contract describes is refused", () => {
  refuses({});
  refuses("not a report");
  refuses(report([file()], { allowlistVersion: 0 }));
  refuses(report([file()], { elapsedMs: 60_001 }));
  refuses(report([file()], { fileCount: 33 }));
  refuses(report([file()], { totalBytes: 67_108_865 }));
  refuses(report(Array.from({ length: 33 }, (_, i) => file({ key: `app:a${i}` })), { fileCount: 33 }));
  refuses(report([file({ status: "shell" })]));
  refuses(report([file({ signatureStatus: "banana" })]));
  refuses(report([file({ observedAt: "yesterday" })]));
  refuses(report([file({ productVersion: "7.4.1\u0000" })])); // a control character is never text
  refuses(report([file({ productVersion: "7".repeat(300) })]));
  refuses(report([file({ companyName: "Acme\n7.4.1" })]));
  refuses(report([file({ openedPath: "\\\\server\\share\\app.exe" })])); // a UNC handle is not a local path
  refuses(report([file({ openedPath: "\\\\?\\C:\\App\\app.exe" })])); // nor a device path
  refuses(report([file({ openedPath: "C:/App/app.exe" })]));
  refuses(report([file({ openedPath: "C:\\App\\app.exe:stream" })])); // nor an alternate data stream
  refuses(report([file({ openedPath: "C:\\App\\..\\App\\app.exe" })]));
  refuses(report([file({ sha256: "zz" })]));
  refuses(report([file({ reparsePoint: "no" })]));
});

test("only the named paths in the plan are admitted, and only the handle inside the allowed root", () => {
  const plan = planWith([entryOf("app:dispenser")]);
  const one = admitReport(plan, report([file()]), caps);
  assert.deepEqual(one.dropped, []);
  assert.deepEqual(one.allowed.map(a => a.key), ["app:dispenser"]);
  assert.equal(one.allowed[0]?.status, "ok");
  assert.equal(one.allowed[0]?.version, "7.4.1");
  assert.equal(one.allowed[0]?.facts?.productVersion, "7.4.1");
  assert.equal(one.files, 1);
  assert.equal(one.bytes, 1024);
  assert.equal(one.truncated, false);
  assert.equal(one.takenAt, "2026-10-23T10:00:00.000Z");
  for (const openedPath of ["C:\\Other\\app.exe", "C:\\App\\sub\\app.exe", "C:\\AppData\\app.exe", "C:\\App\\App.EXE", "C:\\App\\app.exe.exe", "C:\\App", null, undefined, "C:\\App\\..\\App\\app.exe", "D:\\App\\app.exe"]) {
    const refused = admitReport(plan, report([file({ openedPath })]), caps);
    assert.equal(refused.allowed[0]?.status, "outside_root", `expected a refusal for ${String(openedPath)}`);
    assert.equal(refused.allowed[0]?.facts, null);
    assert.equal(refused.files, 0);
  }
  // The directory may be reported in another case: Windows resolves it either way, and the name is still the named one.
  assert.equal(admitReport(plan, report([file({ openedPath: "c:\\app\\app.exe" })]), caps).allowed[0]?.status, "ok");
});

test("a reparse point, a file over its cap, and a path the read was not asked about are all refused", () => {
  const plan = planWith([entryOf("app:dispenser")]);
  const reparse = admitReport(plan, report([file({ reparsePoint: true })]), caps);
  assert.equal(reparse.allowed[0]?.status, "reparse_point");
  assert.equal(reparse.allowed[0]?.facts, null);
  const huge = admitReport(plan, report([file({ sizeBytes: 4097 })]), caps);
  assert.equal(huge.allowed[0]?.status, "too_large");
  assert.equal(huge.allowed[0]?.facts, null);
  const unknown = admitReport(plan, report([file(), file({ key: "app:evil" })]), caps);
  assert.deepEqual(unknown.dropped, [{ key: "app:evil", reason: "unknown_path" }]);
  assert.equal(unknown.allowed.length, 1);
  const twice = admitReport(plan, report([file(), file({ productVersion: "9.9.9" })]), caps);
  assert.deepEqual(twice.dropped, [{ key: "app:dispenser", reason: "duplicate_key" }]);
  assert.equal(twice.allowed[0]?.facts?.productVersion, "7.4.1");
  const failed = admitReport(plan, report([file({ status: "missing", openedPath: null, productVersion: null, detail: "no such file" })]), caps);
  assert.equal(failed.allowed[0]?.status, "missing");
  assert.equal(failed.allowed[0]?.facts, null);
  assert.equal(failed.allowed[0]?.detail, "no such file");
  assert.equal(failed.files, 0);
});

test("a hash is kept only when the allowlist asked for it, and a version is never taken on trust", () => {
  const plain = planWith([entryOf("app:dispenser")]);
  const asked = planWith([entryOf("app:dispenser", { includeSha256: true })]);
  const hash = "a".repeat(64);
  assert.equal(admitReport(plain, report([file({ sha256: hash })]), caps).allowed[0]?.facts?.sha256, null);
  assert.equal(admitReport(asked, report([file({ sha256: hash })]), caps).allowed[0]?.facts?.sha256, hash);
  assert.equal(admitReport(asked, report([file({ sha256: "0".repeat(63) })]), caps).allowed[0]?.facts?.sha256, null);
  assert.equal(admitReport(asked, report([file({ sha256: null })]), caps).allowed[0]?.facts?.sha256, null);
  const junk = admitReport(plain, report([file({ productVersion: "   ", fileVersion: null, companyName: "Acme Corp" })]), caps);
  assert.equal(junk.allowed[0]?.facts?.productVersion, null);
  assert.equal(junk.allowed[0]?.facts?.fileVersion, null);
  assert.equal(junk.allowed[0]?.version, null);
  assert.equal(junk.allowed[0]?.facts?.companyName, "Acme Corp");
  const long = admitReport(plain, report([file({ productVersion: "7".repeat(200) })]), caps);
  assert.equal(long.allowed[0]?.facts?.productVersion, null); // longer than a version: dropped, not truncated into one
  assert.equal(long.allowed[0]?.status, "ok");
  // The file version stands in for the product version only when there is no product version at all.
  assert.equal(admitReport(plain, report([file({ productVersion: null, fileVersion: "7.4.1.0" })]), caps).allowed[0]?.version, "7.4.1.0");
});

test("a report that claims more than the budget it was given is refused", () => {
  const plan = planWith([entryOf("app:dispenser")]);
  const over = (more: Record<string, unknown>): string => {
    try {
      admitReport(plan, report([file()], more), caps);
      return "accepted";
    } catch (e) {
      assert.ok(e instanceof Refused);
      assert.equal((e as Refused).status, 409);
      return (e as Refused).code;
    }
  };
  assert.equal(over({ fileCount: 4 }), "result_over_cap");
  assert.equal(over({ totalBytes: 8193 }), "result_over_cap");
  assert.equal(over({ elapsedMs: 5001 }), "result_over_cap");
  assert.equal(over({}), "accepted");
});

const origin: Origin = { kind: "site", id: "0f1c8f0e-0000-4000-8000-000000000003", name: "Depot", baselineId: "0f1c8f0e-0000-4000-8000-000000000004", versionId: "0f1c8f0e-0000-4000-8000-000000000005", version: 7 };
const resolved = (key: string, expect: Record<string, unknown> | null, over: Partial<ResolvedItem> = {}): ResolvedItem =>
  ({ category: "applications", key, mode: "match", expect, required: false, severity: "minor", note: null, origin, ...over });

test("a version the file read witnesses is compared with the baseline, and the rest is left alone", () => {
  const plan = planWith([entryOf("app:dispenser"), entryOf("app:feeder", { name: "feeder.exe" })]);
  const items = [
    resolved("app:dispenser", { version: "7.4.1" }),
    resolved("app:feeder", { version: "2.0.0" }),
    resolved("app:pumps", { version: "1.0.0" }), // not in the plan: the read says nothing about it
    resolved("app:dispenser", { publisher: "Acme" }, { category: "drivers" }), // another category
  ];
  const drifted = admitReport(plan, report([file({ productVersion: "7.4.0" }), file({ key: "app:feeder", openedPath: "C:\\App\\feeder.exe", productVersion: "2.0.0" })]), caps);
  const rows = versionDrift(items, drifted.allowed, plan);
  assert.deepEqual(rows.map(r => [r.category, r.itemKey, r.field, r.actual]), [["applications", "app:dispenser", "version", "7.4.0"]]);
  assert.equal(rows[0]?.expected, "7.4.1");
  assert.equal(rows[0]?.origin.name, "Depot");
  const matched = admitReport(plan, report([file({ productVersion: "7.4.1" }), file({ key: "app:feeder", openedPath: "C:\\App\\feeder.exe", productVersion: "2.0.0" })]), caps);
  assert.deepEqual(versionDrift(items, matched.allowed, plan), []);
  // A field the read cannot witness must not alert forever.
  assert.deepEqual(versionDrift([resolved("app:dispenser", { publisher: "Acme", version: "7.4.1" })], matched.allowed, plan), []);
  // An item that has to exist and was not read is a difference.
  const present = [resolved("app:dispenser", null, { mode: "present" })];
  const missing = admitReport(plan, report([file({ status: "missing", openedPath: null })]), caps);
  assert.deepEqual(versionDrift(present, missing.allowed, plan).map(r => [r.itemKey, r.field, r.mode]), [["app:dispenser", "", "present"]]);
  // Nothing tracked at all: no work, and nothing to alert on.
  assert.deepEqual(versionDrift([], matched.allowed, plan), []);
  assert.deepEqual(versionDrift([resolved("app:other", { version: "1.0.0" })], matched.allowed, plan), []);
});

test("the observed versions are the items the baseline machinery compares", () => {
  const plan = planWith([entryOf("app:feeder", { name: "feeder.exe" }), entryOf("app:dispenser")]);
  const admitted = admitReport(plan, report([file({ productVersion: "7.4.1", fileVersion: "7.4.1.0" }), file({ key: "app:feeder", openedPath: "C:\\App\\feeder.exe", productVersion: null, fileVersion: "2.0.0.1" })]), caps);
  const items = observedItems(admitted.allowed);
  assert.deepEqual(items.map(i => [i.key, i.values.version]), [["app:dispenser", "7.4.1"], ["app:feeder", "2.0.0.1"]]);
  assert.equal(items[0]?.values.fileVersion, "7.4.1.0");
  assert.equal(items[0]?.values.productVersion, "7.4.1");
  const missing = admitReport(plan, report([file({ status: "missing", openedPath: null })]), caps);
  assert.equal(observedItems(missing.allowed).length, 0);
});

test("the line a difference is reported with is cleaned and names both values", () => {
  const plan = planWith([entryOf("app:dispenser")]);
  const rows = versionDrift([resolved("app:dispenser", { version: "7.4.1" })], admitReport(plan, report([file({ productVersion: "7.4.0" })]), caps).allowed, plan);
  const title = versionTitle(rows);
  assert.match(title, /app:dispenser/);
  assert.match(title, /7\.4\.0/);
  assert.match(title, /7\.4\.1/);
  assert.equal(title.includes("\n"), false);
});

interface Call { text: string; params: readonly unknown[] }
const fake = (answers: (text: string, params: readonly unknown[]) => unknown[]): { db: Queryable; calls: Call[] } => {
  const calls: Call[] = [];
  const db = {
    query: async (text: string, params: readonly unknown[] = []) => {
      calls.push({ text, params });
      const rows = answers(text, params);
      return { rows, rowCount: rows.length };
    },
  };
  return { db: db as unknown as Queryable, calls };
};
const driftOf = (): ReturnType<typeof versionDrift> => {
  const plan = planWith([entryOf("app:dispenser")]);
  return versionDrift([resolved("app:dispenser", { version: "7.4.1" })], admitReport(plan, report([file({ productVersion: "7.4.0" })]), caps).allowed, plan);
};

test("a difference raises one alert for the cabinet, through the machinery the baselines already use", async () => {
  const { db, calls } = fake(text =>
    text.includes("FROM issue_types") ? [{ name: "Application version differs from the baseline", severity: "minor" }]
      : text.includes("UPDATE alerts SET occurrences") ? [{ id: "0f1c8f0e-0000-4000-8000-000000000006" }]
        : []);
  assert.equal(await reconcileVersionAlert(db, CABINET, driftOf()), "raised");
  const lookup = calls.find(c => c.text.includes("FROM issue_types"));
  assert.ok(lookup, "the issue type is looked up before an alert is written");
  assert.deepEqual(lookup.params, [APP_VERSION_ISSUE]);
  const fold = calls.find(c => c.text.includes("UPDATE alerts SET occurrences"));
  assert.ok(fold, "the alert is folded, so one cabinet has one alert");
  assert.equal(fold.params[0], CABINET);
  assert.equal(fold.params[3], `issue:${APP_VERSION_ISSUE}`);
  assert.match(String(fold.params[9]), /^Application version differs from the baseline: /);
  assert.match(String(fold.params[9]), /app:dispenser/);
  assert.equal(String(fold.params[9]).length <= 250, true);
  assert.equal(String(fold.params[9]).includes("7.4.0") && String(fold.params[9]).includes("7.4.1"), true);
  assert.equal(fold.params[2], "minor", "the severity comes from the issue type");
});

test("an agreement clears the alert the platform raised", async () => {
  const { db, calls } = fake(() => []);
  assert.equal(await reconcileVersionAlert(db, CABINET, []), "cleared");
  const clear = calls.find(c => c.text.includes("state = 'resolved'"));
  assert.ok(clear, "the alert is resolved when nothing differs");
  // D92: the close goes through alerts.ts closeIssueAlert, which passes the resolution sentence as a parameter rather than in the SQL.
  assert.deepEqual(clear.params, [CABINET, APP_VERSION_ISSUE, "The versions read from the configured file paths match the baseline."]);
  assert.equal(calls.some(c => c.text.includes("UPDATE alerts SET occurrences")), false);
});

test("an issue type the platform does not know raises nothing and does not throw", async () => {
  const { db, calls } = fake(() => []);
  assert.equal(await reconcileVersionAlert(db, CABINET, driftOf()), "cleared");
  assert.equal(calls.some(c => c.text.includes("UPDATE alerts SET occurrences")), false);
});

test("a stored read is admitted against the plan it was actually asked for", async () => {
  const plan = planWith([entryOf("app:dispenser")]);
  const { db, calls } = fake(text => (text.includes("FROM commands")
    ? [{ params: JSON.stringify(requestOf(plan)), output: JSON.stringify(report([file({ productVersion: "7.4.0" })])), at: new Date("2026-10-23T10:00:00Z") }]
    : text.includes("FROM cabinets k JOIN sites s") ? [{ model: null, client_id: "0f1c8f0e-0000-4000-8000-000000000007", site_id: "0f1c8f0e-0000-4000-8000-000000000008" }]
      : []));
  const stored = await storedRead(db, CABINET.toUpperCase(), caps);
  assert.equal(stored?.plan?.allowlistVersion, plan.allowlistVersion);
  assert.deepEqual(stored?.plan?.entries.map(e => [e.key, e.root, e.name]), [["app:dispenser", "C:\\App", "app.exe"]]);
  assert.equal(stored?.at, "2026-10-23T10:00:00.000Z");
  const read = calls.find(c => c.text.includes("FROM commands"));
  assert.deepEqual(read?.params, [CABINET, FACTS_OPERATION], "one cabinet, one operation, in one case");
  assert.equal(read?.text.includes("'$.output'"), true, "the report is the stored answer's output");
  assert.equal(read?.text.includes("status = 'succeeded'"), true, "a failed command is not a read");
  const out = await ingestFacts(db, CABINET, caps);
  assert.equal(out.status, "done");
  assert.equal(out.admission?.allowed.length, 1);
  assert.equal(out.admission?.allowed[0]?.key, "app:dispenser");
  assert.deepEqual(out.differences, [], "no baseline covers this key, and no expectation means no drift");
  assert.equal(out.alert, "cleared");
});

test("a cabinet whose read came back before any list existed is not compared with anything", async () => {
  const { db, calls } = fake(() => []);
  const out = await ingestFacts(db, CABINET, caps);
  assert.equal(out.status, "no_read");
  assert.equal(out.admission, null);
  assert.equal(calls.some(c => c.text.includes("state = 'resolved'")), false, "nothing was read, so no alert is resolved either");
});

test("a stored request this server could not have issued is not used, and never clears an alert", async () => {
  const plan = planWith([entryOf("app:dispenser")]);
  const asked = requestOf(plan);
  const hostile = [
    { ...asked, entries: [{ ...asked.entries[0], root: "\\\\server\\share" }] },                             // a UNC root
    { ...asked, entries: [{ ...asked.entries[0], name: "..\\..\\Windows\\System32\\cmd.exe" }] },           // traversal in the name
    { ...asked, caps: { ...asked.caps, maxTotalBytes: asked.caps.maxTotalBytes * 100 } },                    // caps above the platform's
    { ...asked, allowlistVersion: 0 },                                                                      // no version to report against
  ];
  for (const params of hostile) {
    const { db, calls } = fake(text => (text.includes("FROM commands") ? [{ params: JSON.stringify(params), output: JSON.stringify(report([file({})])), at: new Date() }] : []));
    const out = await ingestFacts(db, CABINET, caps);
    assert.equal(out.status, "unusable_request");
    assert.equal(out.admission, null);
    assert.equal(calls.some(c => c.text.includes("state = 'resolved'")), false);
    assert.equal(calls.some(c => c.text.includes("UPDATE alerts SET occurrences")), false);
  }
});

test("a stored report that is not the contract shape is refused, not thrown, and resolves nothing", async () => {
  const plan = planWith([entryOf("app:dispenser")]);
  for (const output of ['{"nope":true}', "[]", "not json at all", "null"]) {
    const { db, calls } = fake(text => (text.includes("FROM commands") ? [{ params: JSON.stringify(requestOf(plan)), output, at: new Date() }] : []));
    const out = await ingestFacts(db, CABINET, caps);
    assert.equal(out.status, "malformed_report", output);
    assert.equal(calls.some(c => c.text.includes("state = 'resolved'")), false);
  }
});

test("a read where nothing could be read compares nothing and resolves nothing", async () => {
  const plan = planWith([entryOf("app:dispenser")]);
  const { db, calls } = fake(text => (text.includes("FROM commands")
    ? [{ params: JSON.stringify(requestOf(plan)), output: JSON.stringify(report([file({ status: "access_denied", openedPath: null, detail: "denied by the file" })])), at: new Date() }]
    : []));
  const out = await ingestFacts(db, CABINET, caps);
  assert.equal(out.status, "nothing_read");
  assert.equal(out.admission?.files, 0);
  assert.deepEqual(out.differences, []);
  assert.equal(out.alert, "none");
  assert.equal(calls.some(c => c.text.includes("state = 'resolved'")), false, "a read that saw nothing proves nothing");
});

test("a key the stored plan never issued cannot clear an alert for it", async () => {
  const plan = planWith([entryOf("app:dispenser")]);
  const { db } = fake(text => (text.includes("FROM commands")
    ? [{ params: JSON.stringify(requestOf(plan)), output: JSON.stringify(report([file({ key: "app:other", openedPath: "C:\\App\\Other.exe" })])), at: new Date() }]
    : []));
  const out = await ingestFacts(db, CABINET, caps);
  assert.equal(out.status, "nothing_read");
  assert.equal(out.admission?.allowed.length, 0);
  assert.equal(out.admission?.dropped.some(d => d.key === "app:other"), true);
});
