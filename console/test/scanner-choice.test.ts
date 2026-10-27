import test from "node:test";
import assert from "node:assert/strict";
import { choiceFrom, EMPTY_FIELDS } from "../src/lib/scanner-choice.ts";
import { entryKey } from "../src/lib/approved-apps.ts";

test("the scanner choice needs a service key name and a program; hardware IDs are optional", () => {
  assert.equal(choiceFrom(EMPTY_FIELDS), null);
  assert.equal(choiceFrom({ ...EMPTY_FIELDS, serviceName: "BioScanSvc" }), null);
  assert.deepEqual(choiceFrom({ ...EMPTY_FIELDS, serviceName: " BioScanSvc ", path: "C:\\Program Files\\BioScan\\BioScanSvc.exe" }), {
    enabled: true, service: { key: "app:BioScanSvc", kind: "service", name: "Fingerprint scanner", path: "C:\\Program Files\\BioScan\\BioScanSvc.exe", serviceName: "BioScanSvc" } });
  const withIds = choiceFrom({ ...EMPTY_FIELDS, serviceName: "BioScanSvc", path: "C:\\x.exe", hardwareIds: " USB\\VID_1234 , ,USB\\VID_9 " });
  assert.deepEqual(withIds?.hardwareIds, ["USB\\VID_1234", "USB\\VID_9"]);
});

test("the key follows the approved-programs editor's rule, from the service's key name, so two clients' default display names never share one", () => {
  const a = choiceFrom({ ...EMPTY_FIELDS, serviceName: "BioScanSvc", path: "C:\\a.exe" });
  const b = choiceFrom({ ...EMPTY_FIELDS, serviceName: "FingerSvc", path: "C:\\b.exe" });
  assert.equal(a!.service!.key, entryKey("BioScanSvc"));
  assert.notEqual(a!.service!.key, b!.service!.key);
  assert.ok(choiceFrom({ ...EMPTY_FIELDS, serviceName: "S".repeat(80), path: "C:\\x.exe" })!.service!.key.length <= 64);
});
