import test from "node:test";
import assert from "node:assert/strict";
import { choiceFrom, EMPTY_FIELDS } from "../src/lib/scanner-choice.ts";

test("the scanner choice needs a service key name and a program; hardware IDs are optional", () => {
  assert.equal(choiceFrom(EMPTY_FIELDS), null);
  assert.equal(choiceFrom({ ...EMPTY_FIELDS, serviceName: "BioScanSvc" }), null);
  assert.deepEqual(choiceFrom({ ...EMPTY_FIELDS, serviceName: " BioScanSvc ", path: "C:\\Program Files\\BioScan\\BioScanSvc.exe" }), {
    enabled: true, service: { key: "app:bioscansvc", kind: "service", name: "Fingerprint scanner", path: "C:\\Program Files\\BioScan\\BioScanSvc.exe", serviceName: "BioScanSvc" } });
  const withIds = choiceFrom({ ...EMPTY_FIELDS, serviceName: "BioScanSvc", path: "C:\\x.exe", hardwareIds: " USB\\VID_1234 , ,USB\\VID_9 " });
  assert.deepEqual(withIds?.hardwareIds, ["USB\\VID_1234", "USB\\VID_9"]);
});

test("a long service name still makes a key within the contract's 64 characters", () => {
  const c = choiceFrom({ ...EMPTY_FIELDS, serviceName: "S".repeat(80), path: "C:\\x.exe" });
  assert.ok(c!.service!.key.length <= 64);
});
