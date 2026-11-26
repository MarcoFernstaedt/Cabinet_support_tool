// How a difference from a baseline reads (decision-log D155): a process item says when the process list it was judged on was taken,
// a limit reads as an amount, and no stored object is ever shown as "[object Object]". The editor's check of a new process item.
import test from "node:test";
import assert from "node:assert/strict";
import { fieldName, isNow, processExpects, processItem, processProblem, shouldBe, valueText } from "../src/lib/drift-text.ts";

const when = (iso: string) => `at ${iso.slice(11, 16)}`;
const at = "2026-11-26T08:00:00.000Z";

test("a process that must run and does not, one over its CPU limit, and one that must not run", () => {
  const missing = { category: "processes", field: "", mode: "present", expected: true, actual: { running: false, takenAt: at } };
  assert.equal(shouldBe(missing), "Running");
  assert.equal(isNow(missing, when), "Not running, in the process list of at 08:00");
  const busy = { category: "processes", field: "cpuPercent", mode: "match", expected: { atMost: 25 }, actual: { value: 31.5, takenAt: at } };
  assert.equal(shouldBe(busy), "At most 25% CPU");
  assert.equal(isNow(busy, when), "31.5% CPU, in the process list of at 08:00");
  assert.equal(fieldName("processes", "cpuPercent"), "CPU");
  assert.equal(fieldName("processes", "workingSetMb"), "Memory");
  const heavy = { category: "processes", field: "workingSetMb", mode: "match", expected: { atMost: 1024 }, actual: { value: 1200, takenAt: at } };
  assert.equal(`${shouldBe(heavy)} / ${isNow(heavy, when)}`, "At most 1024 MB of memory / 1200 MB of memory, in the process list of at 08:00");
  const banned = { category: "processes", field: "", mode: "absent", expected: false, actual: { running: true, takenAt: at } };
  assert.equal(`${shouldBe(banned)} / ${isNow(banned, when)}`, "Not running / Running, in the process list of at 08:00");
});

test("the configuration categories read as before, and an object or a damaged value never shows as [object Object]", () => {
  assert.equal(shouldBe({ category: "network", field: "dnsServers", mode: "match", expected: ["10.0.0.1", "10.0.0.2"], actual: ["8.8.8.8"] }), "10.0.0.1, 10.0.0.2");
  assert.equal(isNow({ category: "services", field: "", mode: "present", expected: true, actual: false }, when), "Missing");
  assert.equal(shouldBe({ category: "services", field: "", mode: "match", expected: { startType: "automatic" }, actual: null }), "Present, as the baseline says");
  assert.equal(valueText({ startType: "automatic", delayed: false }), "startType: automatic, delayed: no");
  assert.equal(valueText([{ a: 1 }, null]), "a: 1, none");
  for (const actual of [null, "text", 42, [], { takenAt: 7 }, { value: "a lot" }]) {
    const text = isNow({ category: "processes", field: "cpuPercent", mode: "match", expected: "x", actual }, when) + shouldBe({ category: "processes", field: "cpuPercent", mode: "match", expected: actual, actual });
    assert.doesNotMatch(text, /object Object|undefined|NaN/, JSON.stringify(actual));
  }
});

test("what a process item expects, as the editor and the baseline in force list it", () => {
  assert.equal(processExpects("present"), "Must be running");
  assert.equal(processExpects("present", { cpuPercent: 25, workingSetMb: 1024 }), "Must be running, using at most 25% CPU and 1024 MB of memory");
  assert.equal(processExpects("absent", { cpuPercent: 25 }), "Must not be running");
});

test("the editor refuses a process item the server would refuse, and adds the item the contract takes", () => {
  const existing = [{ category: "processes", key: "process:SyncService.exe" }, { category: "services", key: "service:Other.exe" }];
  assert.match(processProblem("  ", "", "", existing)!, /Name the program/);
  assert.match(processProblem("<script>", "", "", existing)!, /angle brackets/);
  assert.match(processProblem("Sync\u0000.exe", "", "", existing)!, /control characters/);
  assert.match(processProblem("x".repeat(181), "", "", existing)!, /180/);
  assert.match(processProblem("syncservice.EXE", "", "", existing)!, /already/, "the same program in another case");
  assert.equal(processProblem("Other.exe", "", "", existing), null, "a service of that name is not a process item");
  for (const cpu of ["0", "-5", "101", "abc", "1e3", "Infinity"]) assert.match(processProblem("A.exe", cpu, "", existing)!, /CPU limit/, cpu);
  for (const mb of ["0", "1.5", "2000000", "10; DROP TABLE cabinets"]) assert.match(processProblem("A.exe", "", mb, existing)!, /memory limit/, mb);
  assert.equal(processProblem("A.exe", "12.5", "512", existing), null);

  assert.deepEqual(processItem(" A.exe ", true, "12.5", "512", true, "major"),
    { category: "processes", key: "process:A.exe", mode: "present", limits: { cpuPercent: 12.5, workingSetMb: 512 }, required: true, severity: "major" });
  assert.deepEqual(processItem("A.exe", true, "", "", false, "minor"), { category: "processes", key: "process:A.exe", mode: "present", required: false, severity: "minor" });
  assert.deepEqual(processItem("A.exe", false, "50", "100", false, "minor"), { category: "processes", key: "process:A.exe", mode: "absent", required: false, severity: "minor" },
    "a program that must not run takes no limits");
});
