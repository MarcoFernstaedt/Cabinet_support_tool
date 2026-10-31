// The signed approved list's format and check (services/approved-list-signing.ts), against the vectors the agent is tested
// with too, and the two PowerShell scripts an Admin uses: New-ApprovedListTrust.ps1 makes the key and the trust file, and
// Sign-ApprovedList.ps1 signs a list the server wrote. Whatever the script signs, the server's check must accept, and nothing
// else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import { listDocumentBytes, ListSigningKeys, MAX_LIST_DOCUMENT_BYTES, openSignedList } from "../src/services/approved-list-signing.js";
import type { ApprovedListSignature } from "../src/contracts.js";

const repo = join(dirname(SCHEMA_DIR), "..");
const vectors = JSON.parse(readFileSync(join(dirname(SCHEMA_DIR), "vectors", "approved-list-vectors.json"), "utf8")) as {
  keys: unknown; cases: { name: string; document: string; signature: ApprovedListSignature; accept: boolean; reason?: string }[];
};

function keysFolder(keys: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "list-keys-"));
  writeFileSync(join(dir, "approved-list-keys.json"), JSON.stringify(keys));
  return dir;
}

const site = { level: "site" as const, scopeId: "6f1c2a8e-4b7d-4c1e-9a3f-2d5e8b7c1a90", version: 4, issuedAt: "2026-10-26T12:00:00.000Z",
  entries: [{ key: "app:kiosk", kind: "application" as const, name: "Kiosk", path: "C:\\Program Files\\Vendor\\Kiosk\\kiosk.exe" }] };

test("every shared vector is accepted or refused, for the reason the agent refuses it too", () => {
  const keys = ListSigningKeys.fromFolder(keysFolder(vectors.keys));
  for (const c of vectors.cases) {
    const opened = openSignedList(keys, c.document, c.signature);
    assert.equal(opened.ok, c.accept, c.name);
    if (!opened.ok) assert.equal(opened.reason, c.reason, c.name);
  }
});

test("the repository's trust file loads, and with no key in it nothing verifies", () => {
  const keys = ListSigningKeys.fromFolder();
  if (keys.count > 0) return; // once a real key is committed, the vectors above cover it
  const good = vectors.cases.find(c => c.accept)!;
  const opened = openSignedList(keys, good.document, good.signature);
  assert.equal(opened.ok, false);
  assert.equal(!opened.ok && opened.reason, "key");
});

test("a trust file whose keyId is not the key's hash, or whose key is not P-256, is refused when it is loaded", () => {
  const entry = (vectors.keys as { keys: { keyId: string; name: string; publicKey: string }[] }).keys[0]!;
  assert.throws(() => ListSigningKeys.fromFolder(keysFolder({ version: 1, keys: [{ ...entry, keyId: "a".repeat(64) }] })), /not the hash of the key/);
  assert.throws(() => ListSigningKeys.fromFolder(keysFolder({ version: 1, keys: [entry, entry, entry] })), /contract|maxItems|keys/);
  assert.throws(() => ListSigningKeys.fromFolder(keysFolder({ version: 1, keys: [], privateKey: "x" })));
});

test("the document the server writes is the contract's shape, and refuses what the contract refuses", () => {
  const bytes = listDocumentBytes(site);
  const parsed = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(Object.keys(parsed), ["product", "level", "scopeId", "version", "issuedAt", "entries"]);
  assert.equal(parsed.product, "mashura-approved-list");
  assert.throws(() => listDocumentBytes({ ...site, level: "fleet" }), "a fleet list never names a scope");
  assert.throws(() => listDocumentBytes({ ...site, entries: [{ ...site.entries[0]!, path: "C:\\Tools\\run.ps1" }] }), "only programs");
  assert.throws(() => listDocumentBytes({ ...site, version: 0 }));
});

test("hostile input to the check: non-canonical base64, oversize, empty, and malformed signatures are refused before any parse", () => {
  const keys = ListSigningKeys.fromFolder(keysFolder(vectors.keys));
  const good = vectors.cases.find(c => c.accept)!;
  const refuse = (doc: string, sig: unknown, reason: string) => {
    const opened = openSignedList(keys, doc, sig as ApprovedListSignature);
    assert.equal(opened.ok, false);
    assert.equal(!opened.ok && opened.reason, reason, doc.slice(0, 20));
  };
  refuse("", good.signature, "document");
  refuse(good.document.replace(/=*$/, "") + "\n", good.signature, "document");
  refuse(` ${good.document}`, good.signature, "document");
  refuse(Buffer.alloc(MAX_LIST_DOCUMENT_BYTES + 1, 0x20).toString("base64"), good.signature, "document");
  refuse(good.document, { ...good.signature, algorithm: "rsa-pss-sha256" }, "signature");
  refuse(good.document, { ...good.signature, signature: "!!!!" }, "signature");
  refuse(good.document, { ...good.signature, extra: 1 }, "signature");
  refuse(good.document, null, "signature");
  refuse(good.document, { ...good.signature, keyId: "0".repeat(64) }, "key");
});

// ---- The Admin's scripts ------------------------------------------------------------------------------

const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
const havePwsh = pwsh.status === 0 && Number(pwsh.stdout.trim()) >= 7;
const script = (name: string) => join(repo, "agent", "install", name);
const passphrase = "correct horse battery staple";

function ps(name: string, args: string, cwd: string) {
  const command = `$p = ConvertTo-SecureString '${passphrase}' -AsPlainText -Force; & '${script(name)}' ${args} -Passphrase $p`;
  return spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd, encoding: "utf8", timeout: 120_000 });
}

test("New-ApprovedListTrust makes a passphrase-protected key and a trust file; Sign-ApprovedList signs a list the server then accepts", { skip: !havePwsh && "pwsh 7 is not installed" }, () => {
  const work = mkdtempSync(join(tmpdir(), "list-sign-"));
  try {
    const keyFile = join(work, "list-signing-key.pem");
    const made = ps("New-ApprovedListTrust.ps1", `-NewKey '${keyFile}' -OutDir '${join(work, "trust")}'`, work);
    assert.equal(made.status, 0, made.stderr + made.stdout);
    assert.match(readFileSync(keyFile, "utf8"), /^-----BEGIN ENCRYPTED PRIVATE KEY-----/, "the key file is encrypted with the passphrase");
    assert.equal(statSync(keyFile).mode & 0o077, 0, "only its owner can read the key file");
    assert.ok(!readFileSync(join(work, "trust", "approved-list-keys.json"), "utf8").includes("PRIVATE"), "the trust file holds the public half only");
    const keys = ListSigningKeys.fromFolder(join(work, "trust"));
    assert.equal(keys.count, 1);

    const listFile = join(work, "approved-list-site-v4.json");
    writeFileSync(listFile, listDocumentBytes(site));
    const signed = ps("Sign-ApprovedList.ps1", `-ListFile '${listFile}' -KeyFile '${keyFile}' -Yes`, work);
    assert.equal(signed.status, 0, signed.stderr + signed.stdout);
    assert.match(signed.stdout, /Kiosk/, "the person signing sees what the list approves");
    assert.match(signed.stdout, /kiosk\.exe/);
    const signature = JSON.parse(readFileSync(join(work, "approved-list-site-v4.signature.json"), "utf8")) as ApprovedListSignature;
    const opened = openSignedList(keys, readFileSync(listFile).toString("base64"), signature);
    assert.ok(opened.ok, !opened.ok ? opened.why : "");
    assert.deepEqual(opened.ok && opened.document.entries, site.entries);

    // The same signature over a list changed by one character is refused.
    const changed = Buffer.from(readFileSync(listFile, "utf8").replace("kiosk.exe", "kiosx.exe"));
    assert.equal(openSignedList(keys, changed.toString("base64"), signature).ok, false);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("the scripts refuse: a key inside the repository, an existing key file, a short passphrase, a file that is not a list, and hidden characters", { skip: !havePwsh && "pwsh 7 is not installed" }, () => {
  const work = mkdtempSync(join(tmpdir(), "list-sign-"));
  try {
    const inRepo = ps("New-ApprovedListTrust.ps1", `-NewKey '${join(repo, "server", "oops.pem")}' -OutDir '${join(work, "t")}'`, work);
    assert.notEqual(inRepo.status, 0);
    assert.match(inRepo.stderr + inRepo.stdout, /never be written inside the repository/);
    assert.ok(!existsSync(join(repo, "server", "oops.pem")));

    const keyFile = join(work, "k.pem");
    assert.equal(ps("New-ApprovedListTrust.ps1", `-NewKey '${keyFile}' -OutDir '${join(work, "t")}'`, work).status, 0);
    // The refusal itself, not its wording: pwsh 7.4 wraps and colours the error text, so a phrase match fails on some hosts.
    const keyBefore = readFileSync(keyFile);
    const again = ps("New-ApprovedListTrust.ps1", `-NewKey '${keyFile}' -OutDir '${join(work, "t")}'`, work);
    assert.notEqual(again.status, 0, "an existing key file is refused");
    assert.deepEqual(readFileSync(keyFile), keyBefore, "and keeps its bytes");

    const short = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
      `$p = ConvertTo-SecureString 'short' -AsPlainText -Force; & '${script("New-ApprovedListTrust.ps1")}' -NewKey '${join(work, "s.pem")}' -OutDir '${join(work, "t")}' -Passphrase $p`], { encoding: "utf8" });
    assert.match(short.stderr + short.stdout, /at least 12 characters/);
    assert.ok(!existsSync(join(work, "s.pem")));

    const notList = join(work, "manifest.json");
    writeFileSync(notList, JSON.stringify({ product: "mashura-cabinet-agent", version: "1.0.0" }));
    const refused = ps("Sign-ApprovedList.ps1", `-ListFile '${notList}' -KeyFile '${keyFile}' -Yes`, work);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr + refused.stdout, /not an approved list/);
    assert.ok(!existsSync(join(work, "manifest.signature.json")));

    const hidden = join(work, "hidden.json");
    const doc = JSON.parse(listDocumentBytes(site).toString("utf8"));
    doc.entries[0].name = "Kiosk\u202e";
    writeFileSync(hidden, JSON.stringify(doc));
    const spoof = ps("Sign-ApprovedList.ps1", `-ListFile '${hidden}' -KeyFile '${keyFile}' -Yes`, work);
    assert.match(spoof.stderr + spoof.stdout, /hidden character/);

    const noSigner = ps("Sign-ApprovedList.ps1", `-ListFile '${notList}'`, work);
    assert.match(noSigner.stderr + noSigner.stdout, /exactly one key/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
