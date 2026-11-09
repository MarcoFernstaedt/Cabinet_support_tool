// The path allowlist itself (docs/platform/archive/improvement-plan.md section 5): what may be stored, what a stored value has to prove
// before it is used, and which level wins for a cabinet. Pure: no database here, so the statements the storage layer runs are not
// exercised against a real SQL Server by this file.
import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWLIST_ACTION, ALLOWLIST_COLUMN, ALLOWLIST_SET_ACTION, ALLOWLIST_SETTING_KEY, assertOwner, allowlistHash, allowlistItems, normalizeEntries,
  normalizeEntry, resolveLevels, scopeKey, verifyStored, type AllowlistEntry } from "../src/services/filefacts-allowlist.js";
import { Refused } from "../src/services/errors.js";
import { MAX_FILE_BYTES } from "../src/services/filefacts-path.js";

const entry = (over: Record<string, unknown> = {}): unknown => ({ key: "app:dispenser", root: "C:\\Program Files\\Dispenser", name: "dispenser.exe", includeSha256: false, ...over });
/** A list that must be acceptable, so the test says what it means instead of repeating the union. */
const entriesOf = (raw: unknown): AllowlistEntry[] => {
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
const stored = (entries: readonly AllowlistEntry[], over: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 3, entries, hash: allowlistHash(entries), setBy: "0f1c8f0e-0000-4000-8000-000000000001", setAt: "2026-10-01T00:00:00.000Z", ...over });

test("an entry is canonicalised, and its maxBytes defaults to the platform cap", () => {
  const one = normalizeEntry(entry({ root: "c:\\program files\\dispenser" }));
  assert.equal(one.ok, true);
  assert.deepEqual(one.ok ? one.entry : null, { key: "app:dispenser", root: "C:\\program files\\dispenser", name: "dispenser.exe", includeSha256: false, maxBytes: MAX_FILE_BYTES });
  const capped = normalizeEntry(entry({ maxBytes: 4096 }));
  assert.equal(capped.ok ? capped.entry.maxBytes : -1, 4096);
});

test("an entry with a hostile or missing field is refused with a reason", () => {
  assert.equal(reason(entry({ key: "svc:spooler" })), "key_not_a_name");
  assert.equal(reason(entry({ key: "app:a\\b" })), "key_not_a_name");
  assert.equal(reason(entry({ key: "" })), "key_empty");
  assert.equal(reason(entry({ key: 7 })), "key_not_text");
  assert.equal(reason(entry({ root: "\\\\server\\share" })), "root_unc");
  assert.equal(reason(entry({ root: "\\\\?\\C:\\App" })), "root_device");
  assert.equal(reason(entry({ root: "\\\\.\\C:\\App" })), "root_device");
  assert.equal(reason(entry({ root: "C:\\App\\..\\Windows" })), "root_traversal");
  assert.equal(reason(entry({ root: "C:\\App\\" })), "root_empty_segment");
  assert.equal(reason(entry({ root: "C:/App" })), "root_wrong_separator");
  assert.equal(reason(entry({ root: "Apps" })), "root_not_absolute");
  assert.equal(reason(entry({ name: "..\\cmd.exe" })), "name_not_a_name");
  assert.equal(reason(entry({ name: ".." })), "name_traversal");
  assert.equal(reason(entry({ name: "dispenser.exe:evil" })), "name_alternate_stream");
  assert.equal(reason(entry({ name: "" })), "name_empty");
  assert.equal(reason(entry({ name: "dispenser.exe " })), "name_trailing_dot_or_space");
  assert.equal(reason(entry({ name: `${"x".repeat(129)}.exe` })), "name_too_long");
  assert.equal(reason(entry({ includeSha256: "yes" })), "include_sha256_not_boolean");
  assert.equal(reason(entry({ maxBytes: MAX_FILE_BYTES + 1 })), "max_bytes_out_of_range");
  assert.equal(reason(entry({ maxBytes: -1 })), "max_bytes_out_of_range");
  assert.equal(reason(entry({ maxBytes: 1.5 })), "max_bytes_out_of_range");
  assert.equal(reason("app:dispenser"), "not_an_entry");
  assert.equal(reason(null), "not_an_entry");
});

test("a list is keyed once, capped, and ordered so its hash does not depend on how it was written", () => {
  assert.deepEqual(entriesOf([entry({ key: "app:feeder", name: "feeder.exe" }), entry()]).map(e => e.key), ["app:dispenser", "app:feeder"]);
  assert.deepEqual(normalizeEntries([entry(), entry({ name: "other.exe" })]), { ok: false, reason: "duplicate_key" });
  assert.deepEqual(normalizeEntries([entry({ key: "app:x", name: "..\\evil.exe" })]), { ok: false, reason: "name_not_a_name" });
  assert.deepEqual(normalizeEntries("C:\\App"), { ok: false, reason: "not_a_list" });
  assert.deepEqual(normalizeEntries(Array.from({ length: 33 }, (_, i) => entry({ key: `app:a${i}` }))), { ok: false, reason: "too_many_entries" });
  assert.deepEqual(normalizeEntries([]), { ok: true, entries: [] });
});

test("the fingerprint of a list follows the entries and nothing else", () => {
  const one = entriesOf([entry()]);
  const other = entriesOf([entry({ root: "C:\\Other" })]);
  assert.match(allowlistHash(one), /^[0-9a-f]{64}$/);
  assert.equal(allowlistHash(one), allowlistHash(entriesOf([entry()])));
  assert.notEqual(allowlistHash(one), allowlistHash(other));
  assert.deepEqual(allowlistItems(one), [{ key: "app:dispenser", values: { root: "C:\\Program Files\\Dispenser", name: "dispenser.exe", includeSha256: false, maxBytes: MAX_FILE_BYTES } }]);
});

test("a stored row is used only when it describes its own entries", () => {
  const entries = entriesOf([entry()]);
  const content = verifyStored(stored(entries));
  assert.equal(content?.version, 3);
  assert.equal(content?.entries.length, 1);
  assert.equal(content?.setAt, "2026-10-01T00:00:00.000Z");
  assert.equal(content?.setBy, "0f1c8f0e-0000-4000-8000-000000000001");
  // Edited outside the platform: the entries no longer hash to the stored fingerprint.
  assert.equal(verifyStored(stored(entries, { entries: [{ ...entries[0], root: "C:\\Windows\\System32" }] })), null);
  assert.equal(verifyStored(stored(entries, { hash: "0".repeat(64) })), null);
  assert.equal(verifyStored(stored(entries, { hash: null })), null);
  assert.equal(verifyStored(stored(entries, { version: 0 })), null);
  assert.equal(verifyStored(stored(entries, { version: null })), null);
  assert.equal(verifyStored(stored(entries, { entries: "not json" })), null); // JSON in JSON: entries must be a list
  assert.equal(verifyStored(stored(entries, { entries: [{ key: "app:x", root: "\\\\server\\share", name: "x.exe" }] })), null);
  assert.equal(verifyStored(stored(entries, { entries: [{ ...entries[0], name: "..\\evil.exe" }] })), null);
  assert.equal(verifyStored(null), null);
  assert.equal(verifyStored({}), null);
});

test("the most specific level with a list wins, whole, and a rejected row is reported not used", () => {
  const fleet = entriesOf([entry({ key: "app:a", name: "a.exe" })]);
  const site = entriesOf([entry({ key: "app:b", name: "b.exe" })]);
  const found = { fleet: stored(fleet), client: null, site: stored(site), cabinet: null };
  const levels = resolveLevels(found);
  assert.equal(levels.source, "site");
  assert.deepEqual(levels.effective?.entries.map(e => e.key), ["app:b"]); // the site's list replaces the fleet's, it is not merged
  assert.deepEqual(levels.rejected, []);
  const tampered = { ...found, cabinet: stored(site, { entries: [{ ...site[0], name: "evil.exe" }] }) };
  const rejected = resolveLevels(tampered);
  assert.equal(rejected.cabinet, null);
  assert.deepEqual(rejected.rejected, ["cabinet"]);
  assert.equal(rejected.source, "site"); // the level below still applies
  const none = resolveLevels({ fleet: null, client: null, site: null, cabinet: null });
  assert.equal(none.source, "none");
  assert.equal(none.effective, null);
  assert.deepEqual(none.rejected, []);
});

test("only a server administrator may set the paths", () => {
  assert.doesNotThrow(() => assertOwner("admin"));
  for (const role of ["tier1", "tier2", "", "owner"]) throwsRefused(() => assertOwner(role), "forbidden");
});

test("a scope id is stored lower-case and the fleet has none", () => {
  assert.equal(scopeKey("fleet", null), "");
  assert.equal(scopeKey("fleet", "0F1C8F0E-0000-4000-8000-000000000001"), "");
  assert.equal(scopeKey("cabinet", " 0F1C8F0E-0000-4000-8000-000000000001 "), "0f1c8f0e-0000-4000-8000-000000000001");
  for (const bad of [null, "", "1", "0f1c8f0e-0000-4000-8000-00000000001", "../../etc/passwd", "0f1c8f0e-0000-4000-8000-00000000000z", "C:\\App"]) {
    throwsRefused(() => scopeKey("client", bad), "invalid_params");
  }
});

test("the action the settings are audited and bound to is fixed", () => {
  assert.equal(ALLOWLIST_ACTION, "filefacts.allowlist");
  assert.deepEqual(ALLOWLIST_SET_ACTION, { fleet: "settings.filefacts", client: "client.filefacts", site: "site.filefacts", cabinet: "cabinet.filefacts" });
});

test("where a level keeps its list follows the device-settings convention", () => {
  // The migration and the console route are written against these names; pinning them here is what keeps the three in step.
  assert.equal(ALLOWLIST_COLUMN, "filefacts_paths");
  assert.equal(ALLOWLIST_SETTING_KEY, "filefacts.paths");
});
