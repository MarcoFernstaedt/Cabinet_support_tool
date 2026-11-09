// The read request and its budgets (docs/platform/archive/improvement-plan.md section 5): how a list becomes a fixed plan of named paths,
// and the caps a cabinet is held to. Pure, no database.
import test from "node:test";
import assert from "node:assert/strict";
import { CAPS, RATE_WINDOW_SECONDS, buildPlan, overBudget, parsePlan, planEntry, requestOf, withinRateLimit, type Caps } from "../src/services/filefacts-request.js";
import { allowlistHash, type AllowlistContent, type AllowlistEntry } from "../src/services/filefacts-allowlist.js";
import { Refused } from "../src/services/errors.js";
import { MAX_ELAPSED_MS, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "../src/services/filefacts-path.js";

const caps: Caps = { maxFiles: 3, maxFileBytes: 1024, maxTotalBytes: 2048, maxElapsedMs: 1000, maxPerHour: 2 };
const one = (key: string, maxBytes = 512): AllowlistEntry => ({ key, root: "C:\\App", name: `${key.slice(4)}.exe`, includeSha256: false, maxBytes });
const content = (entries: AllowlistEntry[], version = 4): AllowlistContent => ({ version, entries, hash: allowlistHash(entries), setBy: "user", setAt: "2026-10-01T00:00:00.000Z" });
const throwsRefused = (fn: () => unknown, code: string): void => {
  try {
    fn();
    assert.fail(`expected a refusal (${code})`);
  } catch (e) {
    assert.ok(e instanceof Refused, `expected Refused, got ${String(e)}`);
    assert.equal((e as Refused).code, code);
  }
};

test("a plan carries the list's version, its own caps, and nothing else", () => {
  const plan = buildPlan(content([one("app:a"), one("app:b")]), caps);
  assert.equal(plan.allowlistVersion, 4);
  assert.equal(plan.caps, caps);
  assert.equal(plan.truncated, false);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.entries, [
    { key: "app:a", root: "C:\\App", name: "a.exe", includeSha256: false, maxBytes: 512 },
    { key: "app:b", root: "C:\\App", name: "b.exe", includeSha256: false, maxBytes: 512 },
  ]);
});

test("a plan takes at most maxFiles and says what it left out", () => {
  const plan = buildPlan(content([one("app:a"), one("app:b"), one("app:c"), one("app:d"), one("app:e")]), caps);
  assert.deepEqual(plan.entries.map(e => e.key), ["app:a", "app:b", "app:c"]);
  assert.deepEqual(plan.skipped, [{ key: "app:d", reason: "over_file_cap" }, { key: "app:e", reason: "over_file_cap" }]);
  assert.equal(plan.truncated, true);
});

test("an entry may never claim more than the platform's per-file cap", () => {
  const plan = buildPlan(content([{ ...one("app:a"), maxBytes: 999_999 }]), caps);
  assert.equal(plan.entries[0]?.maxBytes, caps.maxFileBytes);
});

test("the aggregate byte budget stops the plan, not the cabinet", () => {
  const plan = buildPlan(content([{ ...one("app:a", 1024) }, { ...one("app:b", 1024) }, { ...one("app:c", 1024) }]), caps);
  assert.deepEqual(plan.entries.map(e => e.key), ["app:a", "app:b"]);
  assert.deepEqual(plan.skipped, [{ key: "app:c", reason: "over_total_bytes" }]);
  assert.equal(plan.truncated, true);
});

test("the same list always gives the same plan", () => {
  const entries = [one("app:a"), one("app:b")];
  assert.deepEqual(buildPlan(content(entries), caps).entries, buildPlan(content([...entries]), caps).entries);
  assert.equal(planEntry(buildPlan(content(entries), caps), "app:b")?.name, "b.exe");
  assert.equal(planEntry(buildPlan(content(entries), caps), "app:zzz"), undefined);
  assert.equal(planEntry(buildPlan(content(entries), caps), null), undefined);
  assert.equal(planEntry(buildPlan(content(entries), caps), 42), undefined);
});

test("a report that claims more than the caps is refused as over budget, whatever it contains", () => {
  assert.equal(overBudget({ files: 3, totalBytes: 2048, elapsedMs: 1000 }, caps), null);
  assert.equal(overBudget({ files: 4, totalBytes: 1, elapsedMs: 1 }, caps), "file_count_over_cap");
  assert.equal(overBudget({ files: 1, totalBytes: 2049, elapsedMs: 1 }, caps), "total_bytes_over_cap");
  assert.equal(overBudget({ files: 1, totalBytes: 1, elapsedMs: 1001 }, caps), "elapsed_over_cap");
});

test("a cabinet is asked at most maxPerHour times an hour", () => {
  assert.doesNotThrow(() => withinRateLimit(0, caps));
  assert.doesNotThrow(() => withinRateLimit(1, caps));
  throwsRefused(() => withinRateLimit(2, caps), "rate_limited");
  assert.equal(RATE_WINDOW_SECONDS, 3600);
});

test("the platform's own caps are the numbers the contracts carry", () => {
  assert.equal(CAPS.maxFiles, MAX_FILES);
  assert.equal(CAPS.maxFileBytes, MAX_FILE_BYTES);
  assert.equal(CAPS.maxTotalBytes, MAX_TOTAL_BYTES);
  assert.equal(CAPS.maxElapsedMs, MAX_ELAPSED_MS);
  assert.equal(CAPS.maxFiles, 32);
  assert.equal(CAPS.maxTotalBytes, 64 * 1024 * 1024);
  assert.equal(CAPS.maxFileBytes * CAPS.maxFiles >= CAPS.maxTotalBytes, true);
});

test("a request says what was asked for, and reading it back gives the same plan", () => {
  const plan = buildPlan(content([one("app:a"), one("app:b")]), caps);
  const asked = requestOf(plan);
  assert.deepEqual(Object.keys(asked).sort(), ["allowlistVersion", "caps", "entries"]);
  assert.deepEqual(asked.caps, { maxFiles: caps.maxFiles, maxFileBytes: caps.maxFileBytes, maxTotalBytes: caps.maxTotalBytes, maxElapsedMs: caps.maxElapsedMs });
  assert.equal((asked.caps as Record<string, unknown>).maxPerHour, undefined, "the rate limit is the platform's business, not the cabinet's");
  const back = parsePlan(JSON.parse(JSON.stringify(asked)), caps);
  assert.deepEqual(back?.entries, plan.entries);
  assert.equal(back?.allowlistVersion, 4);
  assert.equal(back?.caps.maxTotalBytes, caps.maxTotalBytes, "the plan carries the platform's caps, never the cabinet's");
});

test("a stored request that is not a plan this platform could have sent is not one", () => {
  const asked = requestOf(buildPlan(content([one("app:a")]), caps));
  const cases: [string, unknown][] = [
    ["not an object", "C:\\App\\a.exe"],
    ["an array", [asked]],
    ["no entries", { ...asked, entries: undefined }],
    ["a UNC root", { ...asked, entries: [{ ...asked.entries[0], root: "\\\\server\\share\\App" }] }],
    ["a device path root", { ...asked, entries: [{ ...asked.entries[0], root: "\\\\.\\C:\\App" }] }],
    ["traversal in the name", { ...asked, entries: [{ ...asked.entries[0], name: "..\\..\\Windows\\System32\\cmd.exe" }] }],
    ["an alternate data stream", { ...asked, entries: [{ ...asked.entries[0], name: "app.exe:payload" }] }],
    ["an absolute name", { ...asked, entries: [{ ...asked.entries[0], name: "D:\\elsewhere\\app.exe" }] }],
    ["a key that is not a key", { ...asked, entries: [{ ...asked.entries[0], key: "  " }] }],
    ["no version", { ...asked, allowlistVersion: 0 }],
    ["a version that is not a number", { ...asked, allowlistVersion: "4" }],
    ["no caps", { ...asked, caps: undefined }],
    ["cap jumps the file limit", { ...asked, caps: { ...asked.caps, maxFiles: caps.maxFiles + 1 } }],
    ["cap jumps the byte limit", { ...asked, caps: { ...asked.caps, maxTotalBytes: caps.maxTotalBytes * 2 } }],
    ["entry over the per-file cap", { ...asked, entries: [{ ...asked.entries[0], maxBytes: caps.maxFileBytes + 1 }] }],
    ["entries over the total cap", { ...asked, entries: [one("app:a", caps.maxTotalBytes) , one("app:b", caps.maxFileBytes)] }],
    ["more entries than the cap allows", { ...asked, entries: [one("app:a"), one("app:b"), one("app:c"), one("app:d")] }],
  ];
  for (const [what, raw] of cases) {
    assert.equal(parsePlan(raw, caps), null, what);
  }
  assert.equal(parsePlan(JSON.parse(JSON.stringify(asked)), caps)?.entries.length, 1, "the request this platform sent is still a plan");
});

test("a stored request never lets a report answer for a path no list named", () => {
  const asked = requestOf(buildPlan(content([one("app:a", 256)]), caps));
  const back = parsePlan(JSON.parse(JSON.stringify(asked)), caps);
  assert.ok(back);
  assert.equal(planEntry(back, "app:a")?.root, "C:\\App");
  assert.equal(planEntry(back, "app:b"), undefined);
  assert.equal(planEntry(back, 7), undefined);
});
