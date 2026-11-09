// The named-path rules of the file-facts read (docs/platform/archive/improvement-plan.md section 5): canonicalisation, and the refusals a
// hostile path gets. Pure, no database and no filesystem: these are the rules a configured path must satisfy before a cabinet is
// ever asked to open it.
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_FILE_BYTES, MAX_FILES, canonicalPath, canonicalRoot, insideRoot, joinWithinRoot, keyProblem, looksLikeVersion, matchesEntry, refusePath,
  type Canonical, type PathRefusalReason } from "../src/services/filefacts-path.js";

const refused = (got: Canonical, reason: PathRefusalReason): void => assert.deepEqual(got, { ok: false, reason }, `expected ${reason}`);
const path = (got: Canonical): string => {
  assert.equal(got.ok, true, `expected the path to be accepted, got ${JSON.stringify(got)}`);
  return got.ok ? got.path : "";
};

test("a canonical root keeps its own case and upper-cases only the drive letter", () => {
  assert.equal(path(canonicalRoot("C:\\Program Files\\Dispenser")), "C:\\Program Files\\Dispenser");
  assert.equal(path(canonicalRoot("c:\\app")), "C:\\app");
  assert.equal(path(canonicalRoot("C:\\App\\Dispenser App")), "C:\\App\\Dispenser App");
});

test("a root that is not one named directory is refused, never repaired", () => {
  refused(canonicalRoot("C:\\Program Files\\"), "empty_segment"); // a trailing separator is not a canonical root
  refused(canonicalRoot("C:\\"), "empty_segment"); // nor the root of a whole drive
  refused(canonicalRoot("C:\\App\\\\Sub"), "empty_segment"); // nor a doubled separator
  refused(canonicalRoot("\\\\server\\share\\App"), "unc"); // UNC: another machine's file, not this cabinet's
  refused(canonicalRoot("\\\\?\\C:\\App"), "device"); // device namespace
  refused(canonicalRoot("\\\\.\\C:\\App"), "device");
  refused(canonicalRoot("\\??\\C:\\App"), "device");
  refused(canonicalRoot("\\Windows\\System32"), "not_absolute"); // rooted on the current drive
  refused(canonicalRoot("Apps\\Dispenser"), "not_absolute");
  refused(canonicalRoot("C:/App"), "wrong_separator");
  refused(canonicalRoot("C:\\App\\..\\Windows"), "traversal");
  refused(canonicalRoot("C:\\App\\."), "traversal");
  refused(canonicalRoot("C:\\App\\.."), "traversal");
  refused(canonicalRoot("C:\\App "), "trailing_dot_or_space"); // Windows drops it, so it would name a different directory
  refused(canonicalRoot("C:\\App\\sub."), "trailing_dot_or_space");
  refused(canonicalRoot("C:\\App\\ap*p"), "wildcard");
  refused(canonicalRoot("C:\\App\\a<b"), "reserved_character");
  refused(canonicalRoot("C:\\App\\app.exe:stream"), "alternate_stream");
  refused(canonicalRoot("C:\\App\\a\u0001b"), "control_character");
  refused(canonicalRoot(`C:\\${"a".repeat(200)}`), "too_long");
  refused(canonicalRoot(""), "empty");
  refused(canonicalRoot(42), "not_text");
  refused(canonicalRoot(null), "not_text");
});

test("a file name is one segment taken exactly as configured", () => {
  assert.equal(path(joinWithinRoot("C:\\App", "dispenser.exe")), "C:\\App\\dispenser.exe");
  assert.equal(path(joinWithinRoot("c:\\app", "Dispenser.App.exe")), "C:\\app\\Dispenser.App.exe");
  refused(joinWithinRoot("C:\\App", "sub\\dispenser.exe"), "not_a_name"); // no recursion, no path the owner did not write
  refused(joinWithinRoot("C:\\App", "..\\windows\\cmd.exe"), "not_a_name");
  refused(joinWithinRoot("C:\\App", ".."), "traversal");
  refused(joinWithinRoot("C:\\App", "."), "traversal");
  refused(joinWithinRoot("C:\\App", "dispenser.exe:evil"), "alternate_stream");
  refused(joinWithinRoot("C:\\App", "dispenser.exe "), "trailing_dot_or_space");
  refused(joinWithinRoot("C:\\App", "dispenser.exe."), "trailing_dot_or_space");
  refused(joinWithinRoot("C:\\App", ""), "empty");
  refused(joinWithinRoot("C:\\App", 42), "not_text");
  refused(joinWithinRoot("C:\\App", `${"x".repeat(129)}.exe`), "too_long");
  refused(joinWithinRoot("\\\\server\\share", "dispenser.exe"), "unc");
});

test("containment is by name parts, not by a string prefix", () => {
  assert.equal(insideRoot("C:\\App", "C:\\App\\dispenser.exe"), true);
  assert.equal(insideRoot("C:\\app", "C:\\App\\dispenser.exe"), true); // Windows finds a directory whatever the case
  assert.equal(insideRoot("C:\\App", "C:\\App\\sub\\dispenser.exe"), false); // a nested file is not the named file
  assert.equal(insideRoot("C:\\App", "C:\\AppData\\dispenser.exe"), false); // "C:\App" is a prefix of this, and it is not inside
  assert.equal(insideRoot("C:\\App", "D:\\App\\dispenser.exe"), false);
  assert.equal(insideRoot("C:\\App", "\\\\server\\share\\dispenser.exe"), false);
  assert.equal(insideRoot("C:\\App", "C:\\App\\..\\Windows\\cmd.exe"), false);
});

test("the opened handle must be exactly the configured root and the configured name", () => {
  const entry = { root: "C:\\Program Files\\Dispenser", name: "dispenser.exe" };
  assert.equal(matchesEntry(entry, "C:\\Program Files\\Dispenser\\dispenser.exe"), true);
  assert.equal(matchesEntry(entry, "c:\\program files\\dispenser\\dispenser.exe"), true); // the directory, as Windows resolves it
  assert.equal(matchesEntry(entry, "C:\\Program Files\\Dispenser\\Dispenser.exe"), false); // wrong case: not the configured name
  assert.equal(matchesEntry(entry, "C:\\Program Files\\Dispenser\\dispenser.exe.exe"), false);
  assert.equal(matchesEntry(entry, "C:\\Program Files\\Dispenser\\other.exe"), false);
  assert.equal(matchesEntry(entry, "C:\\Program Files\\Dispenser\\sub\\dispenser.exe"), false);
  assert.equal(matchesEntry(entry, "C:\\Program Files\\Dispenser"), false);
  assert.equal(matchesEntry(entry, "\\\\server\\share\\dispenser.exe"), false);
  assert.equal(matchesEntry(entry, "\\\\?\\C:\\Program Files\\Dispenser\\dispenser.exe"), false);
  assert.equal(matchesEntry(entry, "C:\\Program Files\\Dispenser\\dispenser.exe:stream"), false);
  assert.equal(matchesEntry(entry, "C:\\Program Files\\Dispenser"), false);
  assert.equal(matchesEntry(entry, "C:\\Program Files\\Dispenser\\..\\Dispenser\\dispenser.exe"), false);
  assert.equal(matchesEntry(entry, "C:/Program Files/Dispenser/dispenser.exe"), false);
});

test("an application key is an app: name and nothing else", () => {
  assert.equal(keyProblem("app:dispenser"), null);
  assert.equal(keyProblem("app:Dispenser App"), null);
  assert.equal(keyProblem("app:"), "not_a_name");
  assert.equal(keyProblem("svc:spooler"), "not_a_name");
  assert.equal(keyProblem("app:a\\b"), "not_a_name");
  assert.equal(keyProblem("app:a/b"), "reserved_character");
  assert.equal(keyProblem("app:a:b"), "alternate_stream");
  assert.equal(keyProblem("app:a\u0000b"), "control_character");
  assert.equal(keyProblem(""), "empty");
  assert.equal(keyProblem(7), "not_text");
  assert.equal(keyProblem(`app:${"x".repeat(200)}`), "too_long");
});

test("a version is short single-line text and is never parsed", () => {
  assert.equal(looksLikeVersion("7.4.1"), true);
  assert.equal(looksLikeVersion("7.4.1.0 (build 22)"), true);
  assert.equal(looksLikeVersion(""), false);
  assert.equal(looksLikeVersion("7.4.1\n8.0.0"), false);
  assert.equal(looksLikeVersion("7.4.1\u007f"), false);
  assert.equal(looksLikeVersion("v".repeat(65)), false);
  assert.equal(looksLikeVersion(741), false);
  assert.equal(looksLikeVersion(null), false);
});

test("a full path is capped at the Windows path length", () => {
  assert.equal(path(canonicalPath(`C:\\${"a".repeat(255)}`)).length, 258);
  refused(canonicalPath(`C:\\${"a".repeat(258)}`), "too_long");
  refused(canonicalPath("C:\\App\\dispenser.exe:stream"), "alternate_stream");
});

test("a refusal carries a code and never the path back", () => {
  const err = refusePath("set file paths", "traversal");
  assert.equal(err.code, "invalid_params");
  assert.equal(err.status, 400);
  assert.match(err.message, /traversal/);
  assert.equal(err.message.includes(".."), false);
});

test("the caps the platform holds a read to are the numbers the contracts carry", () => {
  assert.equal(MAX_FILES, 32);
  assert.equal(MAX_FILE_BYTES, 8 * 1024 * 1024);
});
