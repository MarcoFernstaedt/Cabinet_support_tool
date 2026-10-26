// Signing the approved list, on a real SQL Server (docs/spec/09-open-decisions.md "Signing the approved list"): with an Admin
// list-signing key set up, a saved list waits for its signature while the list in force stays in force; only a signature over the
// exact document the server offers, from a key the agents hold, puts it in force; and the heartbeat answer then carries the signed
// document. Without a key, nothing changes from before signing existed.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";
import { APPS_SET_ACTION, appLevels, discardPendingApps, listToSign, readLevelState, setApprovedApps, signApprovedApps } from "../src/services/approved-apps.js";
import { knowsSignedList, ListSigningKeys, openSignedList } from "../src/services/approved-list-signing.js";
import { paramsHash } from "../src/auth/canonical.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { recordHeartbeat } from "../src/services/cabinets.js";
import { Refused } from "../src/services/errors.js";
import type { ApprovedListSignature } from "../src/contracts.js";

const admin = { userId: randomUUID(), role: "admin" };
const tier2 = { userId: randomUUID(), role: "tier2" };
const id = { client: randomUUID(), site: randomUUID(), cabinet: randomUUID() };
const KIOSK = { key: "app:kiosk", kind: "application", name: "Kiosk", path: "C:\\Program Files\\Vendor\\Kiosk\\kiosk.exe" };
const SCANNER = { key: "app:scanner", kind: "service", name: "Scanner", path: "C:\\Program Files\\Vendor\\BioScan\\BioScanSvc.exe", serviceName: "BioScanSvc" };

function makeKey(): { privateKey: KeyObject; folder: string; keys: ListSigningKeys; keyId: string } {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  const keyId = createHash("sha256").update(der).digest("hex");
  const folder = mkdtempSync(join(tmpdir(), "list-trust-"));
  writeFileSync(join(folder, "approved-list-keys.json"), JSON.stringify({ version: 1, keys: [{ keyId, name: "Test list key", publicKey: der.toString("base64") }] }));
  return { privateKey: pair.privateKey, folder, keys: ListSigningKeys.fromFolder(folder), keyId };
}
const signWith = (key: { privateKey: KeyObject; keyId: string }, documentBase64: string): ApprovedListSignature => ({
  keyId: key.keyId, algorithm: "ecdsa-p256-sha256",
  signature: sign("sha256", Buffer.from(documentBase64, "base64"), { key: key.privateKey, dsaEncoding: "der" }).toString("base64"),
});

let db: TestDatabase;
type Level = "fleet" | "site";
const save = async (level: Level, entries: unknown[] | null, signing?: ListSigningKeys) => {
  const target = level === "fleet" ? null : id.site;
  const token = await issueStepUpToken(db.app, admin.userId, APPS_SET_ACTION[level], level === "fleet" ? "fleet" : id.site, paramsHash({ level, id: target, entries }));
  return setApprovedApps(db.app, admin, level, target, entries, token, undefined, signing);
};
const beat = () => recordHeartbeat(db.app, id.cabinet, { agentVersion: "0.3.0", uptimeSeconds: 100, readOnlyMode: false });
const refused = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof Refused && e.code === code, `expected ${code}`);
};

test("signing the approved list: waiting, offered, signed, carried, and refused when anything is off", async t => {
  db = await createTestDatabase();
  t.after(async () => { await db.drop(); });
  await db.app.query(`INSERT INTO users ([id],[username],[name],[role]) VALUES ($1,'sign.owner','Sign Owner','admin'), ($2,'sign.tier2','Sign Tier2','tier2')`, [admin.userId, tier2.userId]);
  await db.app.query(`INSERT INTO clients ([id],[name]) VALUES ($1,$2)`, [id.client, "Signing client"]);
  await db.app.query(`INSERT INTO sites ([id],[client_id],[name]) VALUES ($1,$2,$3)`, [id.site, id.client, "Signing site"]);
  await db.app.query(`INSERT INTO cabinets ([id],[site_id],[name],[role],[status]) VALUES ($1,$2,$3,$4,$5)`, [id.cabinet, id.site, "Signing cabinet", "standalone", "active"]);
  const key = makeKey();
  const stranger = makeKey();
  const noKeys = mkdtempSync(join(tmpdir(), "no-list-keys-"));
  writeFileSync(join(noKeys, "approved-list-keys.json"), JSON.stringify({ version: 1, keys: [] }));
  const none = ListSigningKeys.fromFolder(noKeys);

  // Before signing is set up: a fleet list saved without a key goes into force at once, unsigned, as before.
  assert.equal((await save("fleet", [KIOSK], none))?.version, 1);
  assert.deepEqual((await beat()).approved.map(e => e.key), ["app:kiosk"]);
  assert.equal((await beat()).approvedSigned, null);
  await refused(signApprovedApps(db.app, admin, "fleet", null, 1, signWith(key, "AAAA"), none), "signing_off");

  // Signing set up. The unsigned fleet list in force is offered for signing as it is, same version; nothing waits.
  const offered = (await listToSign(db.app, "fleet", null))!;
  assert.equal(offered.version, 1);
  assert.equal(offered.waiting, false);
  assert.match(offered.fileName, /^approved-list-fleet-v1\.json$/);
  assert.equal(openSignedList(key.keys, offered.document, signWith(key, offered.document)).ok, true, "the offered bytes are an approved-list document");

  // A first site list saved with signing on waits: the site has nothing in force yet, so the fleet list still applies.
  assert.equal(await save("site", [KIOSK, SCANNER], key.keys), null);
  let site = await readLevelState(db.app, "site", id.site);
  assert.equal(site.list, null);
  assert.equal(site.rejected, false, "a level with only a waiting change is not damaged");
  assert.equal(site.pending?.version, 1);
  assert.equal((await appLevels(db.app, id.cabinet)).source, "fleet");
  assert.deepEqual((await beat()).approved.map(e => e.key), ["app:kiosk"]);

  // The document to sign is the waiting change.
  const toSign = (await listToSign(db.app, "site", id.site))!;
  assert.equal(toSign.waiting, true);
  assert.equal(toSign.entries, 2);
  const doc = JSON.parse(Buffer.from(toSign.document, "base64").toString("utf8"));
  assert.deepEqual({ product: doc.product, level: doc.level, scopeId: doc.scopeId, version: doc.version }, { product: "mashura-approved-list", level: "site", scopeId: id.site, version: 1 });

  // Refused, audited, and nothing changes: another key, a signature over other bytes, the wrong version, and a Tier 2 account.
  await refused(signApprovedApps(db.app, admin, "site", id.site, 1, signWith(stranger, toSign.document), key.keys), "signature_invalid");
  await refused(signApprovedApps(db.app, admin, "site", id.site, 1, signWith(key, offered.document), key.keys), "signature_invalid");
  await refused(signApprovedApps(db.app, admin, "site", id.site, 2, signWith(key, toSign.document), key.keys), "conflict");
  await refused(signApprovedApps(db.app, tier2, "site", id.site, 1, signWith(key, toSign.document), key.keys), "forbidden");
  assert.equal((await readLevelState(db.app, "site", id.site)).list, null);
  const audited = (await db.app.query<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'site.apps.sign' AND outcome = 'refused'`)).rows[0]!.n;
  assert.equal(Number(audited), 2, "each bad signature is audited");

  // The right signature puts it in force, and the heartbeat answer carries the signed document.
  const signature = signWith(key, toSign.document);
  const live = await signApprovedApps(db.app, admin, "site", id.site, 1, signature, key.keys);
  assert.equal(live.version, 1);
  assert.deepEqual(live.signed?.signature, signature);
  site = await readLevelState(db.app, "site", id.site);
  assert.equal(site.pending, null);
  assert.equal(site.list?.entries.length, 2);
  const answer = await beat();
  assert.deepEqual(answer.approved.map(e => e.key), ["app:kiosk", "app:scanner"]);
  assert.equal(answer.approvedSigned?.document, toSign.document);
  assert.equal(openSignedList(key.keys, answer.approvedSigned!.document, answer.approvedSigned!.signature).ok, true);
  assert.equal(await listToSign(db.app, "site", id.site), null, "nothing left to sign");

  // A change saved now waits; the signed list stays in force and on the wire until the change is signed.
  assert.equal((await save("site", [KIOSK], key.keys))?.version, 1, "the list in force comes back, not the waiting one");
  assert.equal((await readLevelState(db.app, "site", id.site)).pending?.version, 2);
  assert.equal((await beat()).approvedSigned?.document, toSign.document);
  // Dropped: the signed list stays, and nothing waits any more.
  await discardPendingApps(db.app, admin, "site", id.site);
  assert.equal((await readLevelState(db.app, "site", id.site)).pending, null);
  assert.equal((await readLevelState(db.app, "site", id.site)).list?.version, 1);
  await refused(discardPendingApps(db.app, admin, "site", id.site), "not_found");

  // Signing the fleet list in force keeps the fleet change that is waiting beside it.
  await save("fleet", [SCANNER], key.keys);
  const fleetNow = (await listToSign(db.app, "fleet", null))!;
  assert.equal(fleetNow.waiting, true, "the waiting change is what is offered first");
  await signApprovedApps(db.app, admin, "fleet", null, 2, signWith(key, fleetNow.document), key.keys);
  assert.deepEqual((await readLevelState(db.app, "fleet", null)).list?.entries.map(e => e.key), ["app:scanner"]);

  // A stored signed document that no longer says what its list says makes the level damaged: it denies, it never falls through.
  await asOwner(db, c => c.query(`UPDATE sites SET approved_apps = JSON_MODIFY(approved_apps, '$.entries[0].path', 'C:\\Windows\\evil.exe') WHERE id = $1`, [id.site]));
  const damaged = await appLevels(db.app, id.cabinet);
  assert.deepEqual(damaged.rejected, ["site"]);
  assert.deepEqual(damaged.effective?.entries, []);
  assert.equal((await beat()).approvedSigned, null);

  // Removing the site's list needs no signature: it takes effect at once, and the fleet's signed list applies.
  await save("site", null, key.keys);
  assert.equal((await appLevels(db.app, id.cabinet)).source, "fleet");
  assert.notEqual((await beat()).approvedSigned, null);
});

test("only agents that know the signed list are sent it", () => {
  assert.equal(knowsSignedList("0.2.0"), false);
  assert.equal(knowsSignedList("0.2.9"), false);
  assert.equal(knowsSignedList("0.3.0-dev.1"), true);
  assert.equal(knowsSignedList("0.3.0"), true);
  assert.equal(knowsSignedList("1.0.0"), true);
  assert.equal(knowsSignedList("not a version"), false);
});
