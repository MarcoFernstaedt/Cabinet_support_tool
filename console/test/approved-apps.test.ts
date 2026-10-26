// The approved-programs editor: the key a request names an entry by, and what an entry needs before it can be added.
import test from "node:test";
import assert from "node:assert/strict";
import { entryKey, entryProblem, type AppEntry } from "../src/lib/approved-apps.ts";

const app = (over: Partial<AppEntry> = {}): AppEntry => ({ key: entryKey(over.name ?? "Scanner"), kind: "application", name: "Scanner", path: "C:\\Program Files\\Vendor\\scan.exe", ...over });

test("the key is app: and the name, without characters a key may not hold", () => {
  assert.equal(entryKey("Scanner"), "app:Scanner");
  assert.equal(entryKey(' a/b\\c:d*e?f"g<h>i|j '), "app:abcdefghij");
  assert.equal(entryKey("x".repeat(200)).length, 63);
});

test("an entry needs a name, a full .exe path, a service name for a service, and no duplicate", () => {
  assert.equal(entryProblem(app(), []), null);
  assert.match(entryProblem(app({ name: " " }), [])!, /name/);
  for (const path of ["scan.exe", "C:\\Vendor\\scan.bat", "\\\\server\\share\\scan.exe", "C:\\Vendor\\..\\scan.exe", "C:\\Ven<dor\\scan.exe"])
    assert.match(entryProblem(app({ path }), [])!, /full path/, path);
  assert.match(entryProblem(app({ kind: "service" }), [])!, /service/);
  assert.equal(entryProblem(app({ kind: "service", serviceName: "BioScanSvc" }), []), null);
  assert.match(entryProblem(app({ kind: "service", serviceName: "bad;name" }), [])!, /service/);
  assert.match(entryProblem(app(), [app()])!, /already/);
  assert.match(entryProblem(app({ name: "New" }), Array.from({ length: 32 }, (_, i) => app({ name: `P${i}` })))!, /at most 32/);
});
