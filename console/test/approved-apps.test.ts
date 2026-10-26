// The approved-programs editor: the key a request names an entry by, and what an entry needs before it can be added.
import test from "node:test";
import assert from "node:assert/strict";
import { documentBytes, entryKey, entryProblem, readSignatureFile, type AppEntry } from "../src/lib/approved-apps.ts";

const app = (over: Partial<AppEntry> = {}): AppEntry => ({ key: entryKey(over.name ?? "Scanner"), kind: "application", name: "Scanner", path: "C:\\Program Files\\Vendor\\scan.exe", ...over });

test("the key is app: and the name", () => {
  assert.equal(entryKey(" Scanner "), "app:Scanner");
});

test("a name the server would refuse is refused on the page", () => {
  for (const name of ["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b", "tab\there"]) assert.match(entryProblem(app({ name }), [])!, /cannot contain/, name);
  assert.match(entryProblem(app({ name: "x".repeat(60) }), [])!, /59/);
  assert.match(entryProblem(app({ name: "Scanner." }), [])!, /dot or a space/);
});

test("an entry needs a name, a full .exe path, a service name for a service, and no duplicate", () => {
  assert.equal(entryProblem(app(), []), null);
  assert.match(entryProblem(app({ name: " " }), [])!, /name/);
  for (const path of ["scan.exe", "C:\\Vendor\\scan.bat", "\\\\server\\share\\scan.exe", "C:\\Vendor\\..\\scan.exe", "C:\\Ven<dor\\scan.exe",
    "C:\\scan.exe", "C:\\a\\\\scan.exe", "C:\\Vendor.\\scan.exe", "C:\\Vendor \\scan.exe"])
    assert.match(entryProblem(app({ path }), [])!, /full path/, path);
  assert.match(entryProblem(app({ kind: "service" }), [])!, /service/);
  assert.equal(entryProblem(app({ kind: "service", serviceName: "BioScanSvc" }), []), null);
  assert.match(entryProblem(app({ kind: "service", serviceName: "bad;name" }), [])!, /service/);
  assert.match(entryProblem(app(), [app()])!, /already/);
  assert.match(entryProblem(app({ name: "New" }), Array.from({ length: 32 }, (_, i) => app({ name: `P${i}` })))!, /at most 32/);
});

test("a signature file is read only when it is exactly what the signing script writes", () => {
  const good = { keyId: "a".repeat(64), algorithm: "ecdsa-p256-sha256", signature: "MEUCIQDmtyghZi/0kPBIkP/bnL8sYgONIiXn+MOwyJ+WQeHB/A==" };
  const read = readSignatureFile(JSON.stringify(good));
  assert.equal(read.ok, true);
  const problem = (text: string) => { const r = readSignatureFile(text); assert.equal(r.ok, false, text); return r.ok ? "" : r.problem; };
  assert.match(problem("not json"), /not JSON/);
  assert.match(problem("[]"), /not a signature file/);
  assert.match(problem(JSON.stringify({ product: "mashura-approved-list", entries: [] })), /the list itself/);
  assert.match(problem(JSON.stringify({ ...good, extra: 1 })), /not a signature file/);
  assert.match(problem(JSON.stringify({ ...good, algorithm: "rsa-pss-sha256" })), /algorithm/);
  assert.match(problem(JSON.stringify({ ...good, keyId: "A".repeat(64) })), /names no key/);
  assert.match(problem(JSON.stringify({ ...good, signature: "<script>" })), /damaged/);
});

test("the downloaded document holds exactly the bytes the server offered", () => {
  const original = Buffer.from('{"product":"mashura-approved-list","name":"König"}', "utf8");
  assert.deepEqual(Buffer.from(documentBytes(original.toString("base64"))), original);
});
