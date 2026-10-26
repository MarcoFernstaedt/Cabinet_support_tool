// Writes vectors/approved-list-vectors.json: signed approved-list documents that the server (TypeScript) and the agent (C#)
// must both accept or both refuse. Each run makes two throwaway P-256 keys in memory and keeps only their public halves, so
// no private key is ever written anywhere; rerunning it changes every signature, which is fine because the vectors carry the
// public keys they were made with.
//
//   node scripts/make-approved-list-vectors.mjs
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const spki = key => key.export({ format: "der", type: "spki" });
const keyId = der => createHash("sha256").update(der).digest("hex");
const make = () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = spki(pair.publicKey);
  return { privateKey: pair.privateKey, entry: { keyId: keyId(der), name: "Test list key", publicKey: der.toString("base64") } };
};
const pinned = make();
const stranger = make();
const sig = (key, bytes) => ({ keyId: key.entry.keyId, algorithm: "ecdsa-p256-sha256", signature: sign("sha256", bytes, { key: key.privateKey, dsaEncoding: "der" }).toString("base64") });
const doc = fields => Buffer.from(JSON.stringify({ product: "mashura-approved-list", level: "site", scopeId: "6f1c2a8e-4b7d-4c1e-9a3f-2d5e8b7c1a90", version: 3,
  issuedAt: "2026-10-26T12:00:00.000Z", entries: [
    { key: "app:scanner", kind: "service", name: "Scanner service", path: "C:\\Program Files\\Vendor\\BioScan\\BioScanSvc.exe", serviceName: "BioScanSvc" },
    { key: "app:kiosk", kind: "application", name: "Kiosk", path: "C:\\Program Files\\Vendor\\Kiosk\\kiosk.exe" },
  ], ...fields }), "utf8");

const good = doc({});
const fleet = doc({ level: "fleet", scopeId: null, version: 1, entries: [] });
const tampered = Buffer.from(good.toString("utf8").replace("kiosk.exe", "evil.exe"), "utf8");
const wrongProduct = doc({ product: "mashura-cabinet-agent" });
const extraField = Buffer.from(JSON.stringify({ ...JSON.parse(good.toString("utf8")), note: "added" }), "utf8");
const goodSig = sig(pinned, good);
const flipped = Buffer.from(goodSig.signature, "base64"); flipped[flipped.length - 1] ^= 1;

const b64 = b => b.toString("base64");
const cases = [
  { name: "a site list signed with the pinned key", document: b64(good), signature: goodSig, accept: true },
  { name: "an empty fleet list signed with the pinned key", document: b64(fleet), signature: sig(pinned, fleet), accept: true },
  { name: "one changed byte after signing", document: b64(tampered), signature: goodSig, accept: false, reason: "signature" },
  { name: "a signature with one bit flipped", document: b64(good), signature: { ...goodSig, signature: b64(flipped) }, accept: false, reason: "signature" },
  { name: "signed by a key the agent does not hold", document: b64(good), signature: sig(stranger, good), accept: false, reason: "key" },
  { name: "a stranger's signature relabelled with the pinned key's id", document: b64(good), signature: { ...sig(stranger, good), keyId: pinned.entry.keyId }, accept: false, reason: "signature" },
  { name: "validly signed, but for another product", document: b64(wrongProduct), signature: sig(pinned, wrongProduct), accept: false, reason: "document" },
  { name: "validly signed, but with a field the contract does not allow", document: b64(extraField), signature: sig(pinned, extraField), accept: false, reason: "document" },
  { name: "not JSON, validly signed", document: b64(Buffer.from("not json")), signature: sig(pinned, Buffer.from("not json")), accept: false, reason: "document" },
];

writeFileSync(join(here, "..", "vectors", "approved-list-vectors.json"), JSON.stringify({
  description: "Shared by the agent and the server (scripts/make-approved-list-vectors.mjs): each case is a signed approved-list document, base64 of its exact bytes, and the detached signature over them. accept says whether a verifier holding exactly these keys must take it; reason says which check refuses it (key: not a pinned key; signature: does not verify; document: verified but not an approved-list document).",
  keys: { version: 1, keys: [pinned.entry] },
  cases,
}, null, 1) + "\n");
console.log(`wrote ${cases.length} cases`);
