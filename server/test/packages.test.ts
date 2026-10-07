// The server's first gate for the software library: hash, signature, trusted publisher, with hostile input.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as der from "../src/pki/der.js";
import { catalogFilesOf, catalogMembers } from "../src/packages/driver.js";
import { fileDigests } from "../src/packages/pe.js";
import { OID, verifySignedData } from "../src/packages/signed-data.js";
import { TrustList } from "../src/packages/trust.js";
import { PackageRefused, verifyPackage } from "../src/packages/verify.js";
import { readZip, safeName } from "../src/packages/zip.js";
import { CompoundFile } from "../src/packages/cfb.js";
import { compoundFile, ctl, pe, TestPki, zip } from "./package-pki.js";

const pki = new TestPki();
const vendor = pki.signer("Scanner Vendor Inc", "Scanner Vendor");
const trust = TrustList.fromFolder(pki.trustFolder([{ cn: "Scanner Vendor Inc", o: "Scanner Vendor", types: ["driver", "msi"] }]));
const INF = Buffer.from("[Version]\r\nSignature=\"$WINDOWS NT$\"\r\nClass=Biometric ; the scanner\r\nCatalogFile = scanner.cat\r\n\r\n[Manufacturer]\r\n");
const SYS = pe("scanner driver code");
const goodDriver = (wrapped = false) => zip([["scanner.inf", INF], ["x64/scanner.sys", SYS], ["scanner.cat", pki.catalog(vendor, [INF, SYS], { wrapped })]]);

const refusal = (f: () => unknown): string => {
  try { f(); } catch (e) { if (e instanceof PackageRefused) return e.code; throw e; }
  return "accepted";
};

test("a signed driver package from a trusted publisher passes, in either signature layout", () => {
  for (const wrapped of [false, true]) {
    const r = verifyPackage(goodDriver(wrapped), "driver", trust);
    assert.equal(r.signer, "Scanner Vendor Inc");
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
    assert.match(r.detail, /3 files, 1 INF/);
  }
});

test("a changed file, an extra file, a missing or unsigned catalog are refused", () => {
  const tampered = Buffer.concat([SYS, Buffer.from("evil")]);
  assert.equal(refusal(() => verifyPackage(zip([["scanner.inf", INF], ["scanner.sys", tampered], ["scanner.cat", pki.catalog(vendor, [INF, SYS])]]), "driver", trust)), "signature_invalid");
  assert.equal(refusal(() => verifyPackage(zip([["scanner.inf", INF], ["scanner.sys", SYS], ["helper.dll", pe("x")], ["scanner.cat", pki.catalog(vendor, [INF, SYS])]]), "driver", trust)), "signature_invalid");
  assert.equal(refusal(() => verifyPackage(zip([["scanner.inf", INF], ["scanner.sys", SYS]]), "driver", trust)), "signature_invalid");
  assert.equal(refusal(() => verifyPackage(zip([["scanner.inf", Buffer.from("[Version]\r\n")], ["scanner.sys", SYS]]), "driver", trust)), "signature_invalid");
  assert.equal(refusal(() => verifyPackage(zip([["scanner.sys", SYS]]), "driver", trust)), "verification_failed");
  assert.equal(refusal(() => verifyPackage(zip([["scanner.inf", INF], ["scanner.sys", SYS], ["scanner.cat", ctl([])]]), "driver", trust)), "signature_invalid");
});

test("a catalog edited after signing is refused", () => {
  const evil = pe("evil");
  const cat = pki.sign(ctl([INF, SYS].map(f => Buffer.from(fileDigests(f)[0]!, "hex"))), OID.ctl, vendor, { tamper: () => ctl([INF, evil].map(f => Buffer.from(fileDigests(f)[0]!, "hex"))) });
  assert.equal(refusal(() => verifyPackage(zip([["scanner.inf", INF], ["scanner.sys", evil], ["scanner.cat", cat]]), "driver", trust)), "signature_invalid");
});

test("an unlisted signer, an impostor root and a driver-only publisher on an installer are refused", () => {
  const other = pki.signer("Someone Else", "Scanner Vendor");
  assert.equal(refusal(() => verifyPackage(zip([["scanner.inf", INF], ["scanner.sys", SYS], ["scanner.cat", pki.catalog(other, [INF, SYS])]]), "driver", trust)), "publisher_not_trusted");
  const impostor = pki.signer("Scanner Vendor Inc", "Scanner Vendor", pki.otherRoot);
  assert.equal(refusal(() => verifyPackage(zip([["scanner.inf", INF], ["scanner.sys", SYS], ["scanner.cat", pki.catalog(impostor, [INF, SYS], { chain: [pki.otherRoot] })]]), "driver", trust)), "publisher_not_trusted");
  const driverOnly = TrustList.fromFolder(pki.trustFolder([{ cn: "Scanner Vendor Inc", o: "Scanner Vendor", types: ["driver"] }]));
  assert.equal(driverOnly.match(vendor.cert, [pki.intermediate.cert], "msi"), null);
  assert.ok(driverOnly.match(vendor.cert, [pki.intermediate.cert], "driver"));
  // An expired signing certificate is still a known publisher; the timestamp is Windows' check on the cabinet.
  const expired = pki.signer("Scanner Vendor Inc", "Scanner Vendor", pki.intermediate, { from: new Date(Date.now() - 300 * 86_400_000), to: new Date(Date.now() - 86_400_000) });
  assert.ok(trust.match(expired.cert, [pki.intermediate.cert], "driver"));
});

test("SHA-1 signatures and garbage signatures are refused cleanly", () => {
  assert.equal(refusal(() => verifySignedData(pki.sign(ctl([]), OID.ctl, vendor, { digest: "sha1" }))), "signature_invalid");
  for (const junk of [Buffer.alloc(0), Buffer.from("not der"), Buffer.from([0x30, 0x84, 0xff, 0xff, 0xff, 0xff]), Buffer.alloc(4096, 0x30), der.sequence(der.oid(OID.signedData))])
    assert.equal(refusal(() => verifySignedData(junk)), "signature_invalid");
  let deep = der.nullValue();
  for (let i = 0; i < 5000; i++) deep = der.sequence(deep);
  const started = Date.now();
  assert.equal(refusal(() => verifySignedData(deep)), "signature_invalid");
  assert.ok(Date.now() - started < 1000);
});

test("catalogs with thousands of members are read", () => {
  const many = Array.from({ length: 5000 }, (_, i) => createHash("sha256").update(String(i)).digest());
  const signed = verifySignedData(pki.sign(ctl(many), OID.ctl, vendor));
  assert.equal(catalogMembers(signed).size, 5000);
});

test("hostile zips are refused: traversal, reserved names, duplicates, encryption, zip64, bombs, damage", () => {
  for (const name of ["../evil.dll", "x64/../../evil.dll", "C:/Windows/evil.dll", "/etc/passwd", "CON.inf", "a/aux.sys", "name.", "tab\there"]) {
    assert.equal(safeName(name), false, name);
    assert.equal(refusal(() => readZip(zip([["scanner.inf", INF], [name, SYS]]))), "verification_failed", name);
  }
  assert.equal(refusal(() => readZip(zip([["a.inf", INF], ["A.INF", INF]]))), "verification_failed");
  const encrypted = zip([["a.inf", INF]]); encrypted.writeUInt16LE(0x801, encrypted.length - 22 - 46 - 5 + 8); // central directory flags
  assert.equal(refusal(() => readZip(encrypted)), "verification_failed");
  const lying = zip([["a.inf", INF]]); lying.writeUInt32LE(INF.length + 5, lying.length - 22 - 46 - 5 + 24); // wrong uncompressed size
  assert.equal(refusal(() => readZip(lying)), "verification_failed");
  assert.equal(refusal(() => readZip(zip([["big.bin", Buffer.alloc(2000)]]), { entry: 1000, total: 10_000 })), "verification_failed");
  assert.equal(refusal(() => readZip(Buffer.from("PK\u0003\u0004 not a zip"))), "verification_failed");
  assert.equal(refusal(() => readZip(Buffer.alloc(100))), "verification_failed");
});

test("INF catalog names come from the [Version] section only", () => {
  assert.deepEqual(catalogFilesOf(INF), ["scanner.cat"]);
  assert.deepEqual(catalogFilesOf(Buffer.from("; CatalogFile=commented.cat\r\n[Strings]\r\nCatalogFile=wrong.cat\r\n[version]\r\nCatalogFile.NTamd64 = \"x64.cat\" ; amd64\r\n")), ["x64.cat"]);
  assert.deepEqual(catalogFilesOf(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("[Version]\r\nCatalogFile=u.cat\r\n", "utf16le")])), ["u.cat"]);
});

test("the executable checksum is outside the Authenticode hash, everything else is inside", () => {
  const other = Buffer.from(SYS); other[0x98 + 64] = 0x42;
  assert.equal(fileDigests(SYS)[0], fileDigests(other)[0]);
  assert.notEqual(fileDigests(SYS)[1], fileDigests(other)[1]);
  const body = Buffer.from(SYS); body[body.length - 1] = body[body.length - 1]! ^ 0xff;
  assert.notEqual(fileDigests(SYS)[0], fileDigests(body)[0]);
});

// ---- MSI ------------------------------------------------------------------------------------

/** The MSI digest, computed independently here: streams in UTF-16 name order, storages recursively, class IDs last. */
function msiDigest(file: Buffer): Buffer {
  const cfb = new CompoundFile(file);
  const h = createHash("sha256");
  const walk = (id: number, root: boolean) => {
    const e = cfb.entries[id]!;
    for (const c of cfb.childrenOf(e).sort((a, b) => Buffer.compare(a.name, b.name))) {
      if (root && c.name.toString("utf16le").startsWith("\u0005")) continue;
      if (c.type === 2) h.update(cfb.read(c)); else if (c.type === 1) walk(c.id, false);
    }
    h.update(e.clsid);
  };
  walk(0, true);
  return h.digest();
}

const STREAMS: [string, Buffer][] = [["\u4840\u3f3f\u4577", Buffer.alloc(300, 1)], ["Binary.Icon", Buffer.alloc(70, 2)], ["Empty", Buffer.alloc(0)], ["Z", Buffer.from("last")]];
const SUB: [string, [string, Buffer][]] = ["Sub", [["Data", Buffer.from("nested")]]];

/** Signs a test MSI the way Authenticode does: the digest of its streams goes into SpcIndirectDataContent. */
function signedMsi(streams = STREAMS, by = vendor, change?: (s: [string, Buffer][]) => [string, Buffer][]): Buffer {
  const digest = msiDigest(compoundFile(streams, SUB));
  const indirect = der.sequence(der.sequence(der.oid("1.3.6.1.4.1.311.2.1.30")), der.sequence(der.sequence(der.oid("2.16.840.1.101.3.4.2.1"), der.nullValue()), der.octetString(digest)));
  return compoundFile([...(change ? change(streams) : streams), ["\u0005DigitalSignature", pki.sign(indirect, OID.spcIndirectData, by)]], SUB);
}

test("an MSI signed by a trusted publisher passes; its streams and nested storages are all covered", () => {
  assert.equal(verifyPackage(signedMsi(), "msi", trust).signer, "Scanner Vendor Inc");
  assert.equal(refusal(() => verifyPackage(signedMsi(STREAMS, vendor, s => s.map(([n, d]) => [n, n === "Binary.Icon" ? Buffer.alloc(70, 3) : d])), "msi", trust)), "signature_invalid");
  assert.equal(refusal(() => verifyPackage(signedMsi(STREAMS, vendor, s => [...s, ["Extra", Buffer.from("x")]]), "msi", trust)), "signature_invalid");
});

test("an unsigned MSI, an unlisted signer and a damaged file are refused", () => {
  assert.equal(refusal(() => verifyPackage(compoundFile(STREAMS, SUB), "msi", trust)), "signature_invalid");
  assert.equal(refusal(() => verifyPackage(signedMsi(STREAMS, pki.signer("Evil Corp", "Evil")), "msi", trust)), "publisher_not_trusted");
  const good = signedMsi();
  for (const damage of [
    (b: Buffer) => b.subarray(0, 600),                       // truncated
    (b: Buffer) => { const c = Buffer.from(b); c.writeUInt32LE(5, 512 + 4); return c; },  // a FAT chain that loops
    (b: Buffer) => { const c = Buffer.from(b); c.writeUInt16LE(13, 0x1e); return c; },    // impossible sector size
    (b: Buffer) => Buffer.concat([Buffer.from("not a compound file"), b]),
  ]) assert.equal(refusal(() => verifyPackage(damage(good), "msi", trust)), "signature_invalid");
});

test("only driver packages and MSI installers exist", () => {
  assert.equal(refusal(() => verifyPackage(goodDriver(), "exe" as never, trust)), "verification_failed");
});

test("the real trusted publisher list is Microsoft only until the scanner vendor is added", () => {
  const real = TrustList.fromFolder();
  assert.ok(real.list.publishers.every(p => p.organization === "Microsoft Corporation"));
  assert.equal(real.match(vendor.cert, [pki.intermediate.cert], "driver"), null);
});
