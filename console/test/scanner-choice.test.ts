import test from "node:test";
import assert from "node:assert/strict";
import { choiceFrom, EMPTY_FIELDS } from "../src/lib/scanner-choice.ts";
import { entryKey } from "../src/lib/approved-apps.ts";

test("the scanner choice needs a service key name and a program; hardware IDs are optional", () => {
  assert.equal(choiceFrom(EMPTY_FIELDS), null);
  assert.equal(choiceFrom({ ...EMPTY_FIELDS, serviceName: "BioScanSvc" }), null);
  assert.deepEqual(choiceFrom({ ...EMPTY_FIELDS, serviceName: " BioScanSvc ", path: "C:\\Program Files\\BioScan\\BioScanSvc.exe" }), {
    enabled: true, service: { key: "app:Fingerprint scanner", kind: "service", name: "Fingerprint scanner", path: "C:\\Program Files\\BioScan\\BioScanSvc.exe", serviceName: "BioScanSvc" } });
  const withIds = choiceFrom({ ...EMPTY_FIELDS, serviceName: "BioScanSvc", path: "C:\\x.exe", hardwareIds: " USB\\VID_1234 , ,USB\\VID_9 " });
  assert.deepEqual(withIds?.hardwareIds, ["USB\\VID_1234", "USB\\VID_9"]);
});

test("the key follows the approved-programs editor's rule, so one program is one entry whichever screen added it", () => {
  const c = choiceFrom({ ...EMPTY_FIELDS, name: " BioScan ", serviceName: "BioScanSvc", path: "C:\\x.exe" });
  assert.equal(c!.service!.key, entryKey("BioScan"));
});
