// The approved-applications list itself (docs/spec/13-roadmap.md: process.end and app.restart with a per-client allowlist): what
// may be stored, what a stored value has to prove before it is used, which level wins for a cabinet, and who may set it. Pure: no
// database here, so the statements the storage layer runs are not exercised against a real SQL Server by this file.
import test from "node:test";
import assert from "node:assert/strict";
import { APPS_COLUMN, APPS_SET_ACTION, APPS_SETTING_KEY, appItems, appsHash, entryPath, MAX_APPS, assertOwner, normalizeEntries,
  normalizeEntry, rawEntry, resolveLevels, scopeKey, verifyStored, type ApprovedApp } from "../src/services/approved-apps.js";
import { Refused } from "../src/services/errors.js";

const entry = (over: Record<string, unknown> = {}): unknown =>
  ({ key: "app:dispenser", kind: "application", name: "Dispenser", path: "C:\\Program Files\\Dispenser\\dispenser.exe", ...over });
/** A list that must be acceptable, so the test says what it means instead of repeating the union. */
const entriesOf = (raw: unknown): ApprovedApp[] => {
  const one = normalizeEntries(raw);
  assert.equal(one.ok, true, `expected a list, got ${JSON.stringify(one)}`);
  return one.ok ? one.entries : [];
};
const reason = (raw: unknown): string => {
  const one = normalizeEntry(raw);
  return one.ok ? "accepted" : one.reason;
};
const throwsRefused = (fn: () => unknown, code: string): void => {
  try {
    fn();
    assert.fail(`expected a refusal (${code})`);
  } catch (e) {
    assert.ok(e instanceof Refused, `expected Refused, got ${String(e)}`);
    assert.equal((e as Refused).code, code);
  }
};
const stored = (entries: readonly ApprovedApp[], over: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 3, entries: entries.map(rawEntry), hash: appsHash(entries), setBy: "0f1c8f0e-0000-4000-8000-000000000001", setAt: "2026-10-01T00:00:00.000Z", ...over });

test("an entry is split into the directory it lives in and one file name, and the drive letter is canonical", () => {
  const one = normalizeEntry(entry({ path: "c:\\program files\\dispenser\\dispenser.exe" }));
  assert.equal(one.ok, true);
  assert.deepEqual(one.ok ? one.entry : null, { key: "app:dispenser", kind: "application", name: "Dispenser", root: "C:\\program files\\dispenser", file: "dispenser.exe", serviceName: null });
  assert.equal(entryPath(entriesOf([entry()])[0]!), "C:\\Program Files\\Dispenser\\dispenser.exe");
});

test("a service is pinned by its name as well as its path, and an application must not carry a name it does not need", () => {
  const svc = normalizeEntry(entry({ kind: "service", key: "app:spooler", serviceName: "Spooler", path: "C:\\Windows\\System32\\spoolsv.exe" }));
  assert.equal(svc.ok, true);
  assert.equal(svc.ok ? svc.entry.serviceName : null, "Spooler");
  assert.equal(svc.ok ? svc.entry.kind : null, "service");
  const noName = normalizeEntry(entry({ kind: "service", serviceName: undefined, key: "app:spooler" }));
  assert.equal(noName.ok, false);
  assert.equal(noName.ok ? "" : noName.reason, "service_name_not_text");
  // The service name is text only: never a path, never a command line.
  assert.equal(reason(entry({ kind: "service", serviceName: "Spooler & calc.exe" })), "service_name_not_text");
});

test("an entry with a hostile, relative or non-executable path is refused with a reason", () => {
  assert.equal(reason(entry({ path: "dispenser.exe" })), "path_not_absolute");
  assert.equal(reason(entry({ path: "C:\\Program Files\\Dispenser\\..\\Other\\dispenser.exe" })), "path_traversal");
  assert.equal(reason(entry({ path: "C:\\Program Files\\Dispenser\\*.exe" })), "path_wildcard");
  assert.equal(reason(entry({ path: "C:\\Program Files\\Dispenser\\dispenser.dll" })), "path_not_an_executable");
  assert.equal(reason(entry({ path: "\\\\server\\share\\dispenser.exe" })), "path_unc");
  // A command line or an argument is just a path that does not name one program.
  assert.equal(reason(entry({ path: "C:\\Program Files\\Dispenser\\dispenser.exe --silent" })), "path_not_an_executable");
});

test("an entry with a hostile key, kind or name is refused with a reason", () => {
  assert.equal(reason(entry({ key: "svc:spooler" })), "key_not_a_name");
  assert.equal(reason(entry({ key: "app:a\\b" })), "key_not_a_name");
  assert.equal(reason(entry({ key: "" })), "key_empty");
  assert.equal(reason(entry({ kind: "process" })), "kind_not_known");
  assert.equal(reason(entry({ name: "Dispenser\\..\\evil" })), "name_not_text");
  assert.equal(reason(entry({ name: "" })), "name_not_text");
  assert.equal(reason(null), "not_an_entry");
  assert.equal(reason(["app:dispenser"]), "not_an_entry");
});

test("a list is at most 32 entries, one per key, and comes out in key order", () => {
  const many = Array.from({ length: MAX_APPS + 1 }, (_, i) => entry({ key: `app:tool${i}`, path: `C:\\Tools\\tool${i}.exe` }));
  assert.equal(normalizeEntries(many).ok, false);
  assert.equal(normalizeEntries([]).ok, true);
  assert.equal(normalizeEntries("app:dispenser").ok, false);
  const dupes = normalizeEntries([entry(), entry()]);
  assert.equal(dupes.ok, false);
  assert.equal(dupes.ok ? "" : dupes.reason, "duplicate_key");
  const sorted = entriesOf([entry({ key: "app:zebra", path: "C:\\Tools\\zebra.exe" }), entry({ key: "app:alpha", path: "C:\\Tools\\alpha.exe" })]);
  assert.deepEqual(sorted.map(e => e.key), ["app:alpha", "app:zebra"]);
});

test("a stored list is used only when it describes its own entries", () => {
  const entries = entriesOf([entry(), entry({ key: "app:spooler", kind: "service", serviceName: "Spooler", path: "C:\\Windows\\System32\\spoolsv.exe" })]);
  const good = verifyStored(stored(entries));
  assert.equal(good?.version, 3);
  assert.equal(good?.entries.length, 2);
  // The column holds the owner's form, the path whole, so the agent and any other tool can read it.
  assert.deepEqual(JSON.parse(stored(entries)).entries[0], { key: "app:dispenser", kind: "application", name: "Dispenser", path: "C:\\Program Files\\Dispenser\\dispenser.exe" });
  // Edited outside the platform: the entries and the hash disagree, so the level is not used at all.
  assert.equal(verifyStored(stored(entries, { hash: "0".repeat(64) })), null);
  assert.equal(verifyStored(stored(entriesOf([entry({ path: "C:\\Tools\\other.exe" })]), { hash: appsHash(entries) })), null);
  assert.equal(verifyStored(stored(entries, { version: 0 })), null);
  assert.equal(verifyStored(stored(entries, { version: "three" })), null);
  assert.equal(verifyStored("not json"), null);
  assert.equal(verifyStored(null), null);
  assert.equal(verifyStored({ version: 1, entries: [], hash: "0".repeat(64) }), null);
  // A list read back out of the column as a parsed object works the same way as the text.
  assert.equal(verifyStored(JSON.parse(stored(entries)))?.entries.length, 2);
});

test("the most specific level with a list wins whole, and a rejected level is reported", () => {
  const cabinet = stored(entriesOf([entry()]));
  const fleet = stored(entriesOf([entry({ key: "app:alpha", path: "C:\\Tools\\alpha.exe" })]));
  const over = { cabinet, site: null, client: null, fleet };
  const levels = resolveLevels(over);
  assert.equal(levels.source, "cabinet");
  assert.deepEqual(levels.effective?.entries.map(e => e.key), ["app:dispenser"]);
  // An empty list at a level is a decision: it wins over the level above and approves nothing.
  const none = resolveLevels({ cabinet: stored([]), site: null, client: null, fleet });
  assert.equal(none.source, "cabinet");
  assert.deepEqual(none.effective?.entries, []);
  // Nothing at any level.
  const bare = resolveLevels({ cabinet: null, site: null, client: null, fleet: null });
  assert.equal(bare.source, "none");
  assert.equal(bare.effective, null);
  // A cabinet whose own value was edited outside the platform falls back, and says which level was rejected.
  const rejected = resolveLevels({ cabinet: stored(entriesOf([entry()]), { hash: "0".repeat(64) }), site: null, client: null, fleet });
  assert.equal(rejected.source, "fleet");
  assert.deepEqual(rejected.rejected, ["cabinet"]);
  assert.deepEqual(rejected.effective?.entries.map(e => e.key), ["app:alpha"]);
});

test("only a server administrator approves a program, and a scope id is a scope id", () => {
  assertOwner("admin");
  throwsRefused(() => assertOwner("tier2"), "forbidden");
  throwsRefused(() => assertOwner("tier1"), "forbidden");
  assert.equal(scopeKey("fleet", "whatever"), "");
  assert.equal(scopeKey("cabinet", " 0F1C8F0E-0000-4000-8000-000000000001 "), "0f1c8f0e-0000-4000-8000-000000000001");
  throwsRefused(() => scopeKey("cabinet", "1"), "invalid_params");
  throwsRefused(() => scopeKey("site", null), "invalid_params");
});

test("the list's fingerprint is the canonical form of its entries, so it does not depend on the order they were written in", () => {
  const a = entriesOf([entry(), entry({ key: "app:spooler", kind: "service", serviceName: "Spooler", path: "C:\\Windows\\System32\\spoolsv.exe" })]);
  const b = entriesOf([entry({ key: "app:spooler", kind: "service", serviceName: "Spooler", path: "C:\\Windows\\System32\\spoolsv.exe" }), entry()]);
  assert.equal(appsHash(a), appsHash(b));
  // The path is kept exactly as it was configured, case included: that is what the agent compares against what Windows reports.
  assert.notEqual(appsHash(a), appsHash(entriesOf([entry(), entry({ key: "app:spooler", kind: "service", serviceName: "Spooler", path: "c:\\windows\\system32\\spoolsv.exe" })])));
  assert.notEqual(appsHash(a), appsHash(entriesOf([entry({ name: "Dispenser two" })])));
  assert.match(appsHash(a), /^[0-9a-f]{64}$/);
  assert.deepEqual(appItems(a).find(i => i.key === "app:spooler")?.values, { kind: "service", path: "C:\\Windows\\System32\\spoolsv.exe", serviceName: "Spooler" });
});

test("an empty list is a level of its own: it approves nothing and still wins over the fleet", () => {
  const levels = resolveLevels({ fleet: stored(entriesOf([entry()])), cabinet: stored(entriesOf([])) });
  assert.equal(levels.source, "cabinet");
  assert.deepEqual(levels.effective?.entries, []);
  assert.deepEqual(levels.rejected, []);
  // null is the other thing entirely: nothing set here, so the fleet applies.
  const inherited = resolveLevels({ fleet: stored(entriesOf([entry()])), cabinet: null });
  assert.equal(inherited.source, "fleet");
  assert.equal(inherited.effective?.entries.length, 1);
});

test("the level names, the column and the step-up actions are the ones the rest of the platform reads", () => {
  assert.equal(APPS_SETTING_KEY, "apps.approved");
  assert.equal(APPS_COLUMN, "approved_apps");
  assert.deepEqual(APPS_SET_ACTION, { fleet: "settings.apps", client: "client.apps", site: "site.apps", cabinet: "cabinet.apps" });
});
