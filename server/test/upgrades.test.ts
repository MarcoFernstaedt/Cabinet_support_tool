// Milestone 7 on the server: the update store (signature, hash, versions only go up), staged rollouts (batches, the
// success rate, automatic pause, timeouts, offline cabinets), offers and downloads only to offered cabinets, the
// console's Upgrades routes by role and step-up, and the whole channel with the real agent code.
import test from "node:test";
import { paramsHash } from "../src/auth/canonical.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey, developmentServerCertificate } from "../src/pki/issuing.js";
import { CommandNotifier } from "../src/agent-api/notifier.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { buildAgentApi } from "../src/agent-api/server.js";
import { approveEnrollment, createBootstrapToken, pendingRequests } from "../src/services/enrollment.js";
import { listCabinets } from "../src/services/cabinets.js";
import { addRelease, compareVersions, isVersion, listReleases, receiveReleasePackage, releaseForAgent, releasePackageForAgent, ReleaseKeys, type ReleaseStore } from "../src/services/releases.js";
import { changeRollout, checkRollouts, listRollouts, offerFor, recordUpgradeStatus, rolloutTargets, startRollout } from "../src/services/rollouts.js";
import { Refused } from "../src/services/errors.js";
import { verifyAuditChain } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";
import { agentPackage, keysFolder, makeRelease, releaseKey, type Release } from "./release-kit.js";
import { TestPki } from "./package-pki.js";

const ORIGIN = "https://console.test";
/** The two Windows the store knows (docs/platform/archive/second-architecture.md): a release, a rollout and the cabinets it may reach
 *  are all one of these. x64 is the one the fleet runs today, so it is what every test means unless it says otherwise. */
const X64 = "windows-x64";
const X86 = "windows-x86";
const key = releaseKey();
const otherKey = releaseKey();
let db: TestDatabase;
let store: ReleaseStore;
let admin: string;

const refusedWith = (code: string) => (e: unknown) => { assert.ok(e instanceof Refused, String(e)); assert.equal(e.code, code, e.message); return true; };
const upload = (r: Release, by = admin) => addRelease(db.app, store.keys, by, r.manifest, r.signature, r.architecture, null);
const ready = async (r: Release) => { await upload(r); await receiveReleasePackage(db.app, store, admin, r.version, r.architecture, Readable.from([r.zip])); };

/** A client with cabinets: name → { version, inOffice, online }. */
async function fleet(spec: { name: string; version: string | null; inOffice?: boolean; online?: boolean }[]): Promise<Record<string, string>> {
  // Each test's fleet is the whole fleet: earlier tests' cabinets are removed first.
  await db.app.query("UPDATE cabinets SET status = 'removed'");
  const client = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `Client ${client.slice(0, 8)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Main')", [site, client]);
  const ids: Record<string, string> = {};
  for (const c of spec) {
    ids[c.name] = randomUUID();
    await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, agent_version, in_office, last_heartbeat_at)
                        VALUES ($1, $2, $3, 'standalone', 'active', $4, $5, CASE WHEN $6 = 1 THEN SYSUTCDATETIME() ELSE DATEADD(hour, -2, SYSUTCDATETIME()) END)`,
      [ids[c.name], site, c.name, c.version, c.inOffice ?? false, c.online ?? true]);
  }
  return ids;
}
const rolloutOf = async (id: string) => (await listRollouts(db.app)).find(r => r.id === id)!;
const targetOf = async (id: string, cabinet: string) => (await rolloutTargets(db.app, id)).find(t => t.cabinetId === cabinet)!;
const report = (cabinet: string, version: string, outcome: "succeeded" | "refused" | "rolled_back" | "failed", check?: string) =>
  recordUpgradeStatus(db.app, cabinet, { version, fromVersion: "0.1.0", outcome, ...(check ? { check: check as never } : {}), message: `${outcome} in a test` });

test.before(async () => {
  db = await createTestDatabase();
  store = { dir: tempDir(), maxBytes: 1024 * 1024, keys: ReleaseKeys.fromFolder(keysFolder([key])) };
  admin = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'up.admin', 'Upgrade Admin', 'admin')", [admin]);
});
test.after(async () => { await db.drop(); });

test("versions order by semantic versioning, and only agent versions are accepted", () => {
  assert.ok(compareVersions("0.1.0", "0.1.1") < 0 && compareVersions("0.10.0", "0.9.9") > 0 && compareVersions("1.0.0-rc.1", "1.0.0") < 0);
  assert.ok(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10") < 0 && compareVersions("2.0.0", "2.0.0") === 0);
  for (const bad of ["", "1.0", "01.0.0", "1.0.0-", "1.0.0-a..b", "../../etc", "1.0.0;rm", 7, null]) assert.equal(isVersion(bad), false, String(bad));
});

test("the update store takes only releases signed by a release key, with the exact package, and versions only go up", async () => {
  // Release keys the server knows of: keyId must be the key's own hash.
  const bad = keysFolder([key]);
  writeFileSync(join(bad, "upgrade-keys.json"), JSON.stringify({ version: 1, publishers: [], keys: [{ keyId: "0".repeat(64), name: "liar", publicKey: key.spki.toString("base64") }] }));
  assert.throws(() => ReleaseKeys.fromFolder(bad), /keyId/);
  // A server whose trust file lists no key accepts no release. The repository's own file has held the operator's release
  // key since it was provisioned, so this asks the question of a folder with no keys, not of whatever the repository ships.
  assert.equal(ReleaseKeys.fromFolder(keysFolder([])).count, 0);

  const before = (await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM security_alerts WHERE kind = 'signature_failure'")).rows[0]!.n;
  // Signed by a key the agents do not hold.
  await assert.rejects(upload(makeRelease(otherKey, "0.2.0")), refusedWith("signature_invalid"));
  // A manifest changed after signing.
  const good = makeRelease(key, "0.2.0");
  const changed = Buffer.from(good.manifestBytes.toString().replace("0.0.1", "0.0.0"));
  await assert.rejects(addRelease(db.app, store.keys, admin, changed.toString("base64"), good.signature, X64, null), refusedWith("signature_invalid"));
  assert.equal((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM security_alerts WHERE kind = 'signature_failure'")).rows[0]!.n, before + 2, "one open alert per key, each attempt folded into it");
  // Signed, but not a manifest the agent would read.
  await assert.rejects(upload(makeRelease(key, "0.2.0", agentPackage(), { product: "other" })), refusedWith("invalid_manifest"));
  await assert.rejects(upload(makeRelease(key, "0.2.0", agentPackage(), { postInstall: "cmd /c calc" })), refusedWith("invalid_manifest"));
  await assert.rejects(upload(makeRelease(key, "0.2.0", agentPackage(), { minimumVersion: "0.2.0" })), refusedWith("invalid_manifest"));
  await assert.rejects(addRelease(db.app, store.keys, admin, good.manifest.replace(/=*$/, "") + "@@", good.signature, X64, null), refusedWith("invalid_manifest"));
  await assert.rejects(addRelease(db.app, store.keys, admin, Buffer.alloc(5000, 32).toString("base64"), good.signature, X64, null), refusedWith("invalid_manifest"));

  // The right manifest, then a package that is not the one it names: refused, and the version may be added again.
  await upload(good);
  const wrong = Buffer.from(good.zip); wrong[wrong.length >> 1]! ^= 0xff;
  await assert.rejects(receiveReleasePackage(db.app, store, admin, "0.2.0", X64, Readable.from([wrong])), refusedWith("hash_mismatch"));
  await assert.rejects(receiveReleasePackage(db.app, store, admin, "0.2.0", X64, Readable.from([good.zip, Buffer.from("x")])), refusedWith("not_awaiting_package"));
  assert.equal((await listReleases(db.app)).find(r => r.version === "0.2.0")!.state, "refused");
  await upload(good);
  const larger = Buffer.concat([good.zip, Buffer.from("trailing")]);
  await assert.rejects(receiveReleasePackage(db.app, store, admin, "0.2.0", X64, Readable.from([larger])), refusedWith("hash_mismatch"));
  await upload(good);
  await receiveReleasePackage(db.app, store, admin, "0.2.0", X64, Readable.from([good.zip]));
  assert.equal((await listReleases(db.app)).find(r => r.version === "0.2.0")!.state, "ready");
  await assert.rejects(receiveReleasePackage(db.app, store, admin, "0.2.0", X64, Readable.from([good.zip])), refusedWith("not_awaiting_package"));

  // No reuse and no going back: a rollback is a new release with a higher version.
  await assert.rejects(upload(makeRelease(key, "0.2.0")), refusedWith("version_exists"));
  await assert.rejects(upload(makeRelease(key, "0.1.9")), refusedWith("version_not_newer"));
  await assert.rejects(upload(makeRelease(key, "0.2.0-rc.1")), refusedWith("version_not_newer"));
  assert.equal((await verifyAuditChain(db.app)).ok, true);
});

test("a staged rollout: one cabinet, then the office, then about 5 percent, then everyone; never a cabinet that is already up to date", async () => {
  const r = makeRelease(key, "0.3.0");
  await ready(r);
  const spec = [{ name: "pilot", version: "0.1.0" }, { name: "office-1", version: "0.1.0", inOffice: true }, { name: "office-2", version: "0.2.0", inOffice: true },
    { name: "current", version: "0.3.0" }, { name: "newer", version: "0.4.0", inOffice: true }, { name: "unknown", version: null },
    ...Array.from({ length: 39 }, (_, i) => ({ name: `field-${i}`, version: "0.1.0" }))];
  const ids = await fleet(spec);
  await assert.rejects(startRollout(db.app, admin, { version: "0.3.0", architecture: X64, pilotCabinetId: ids.current!, successRatePercent: 95, failureLimitPercent: 5 }, null), refusedWith("pilot_not_eligible"));
  await assert.rejects(startRollout(db.app, admin, { version: "9.9.9", architecture: X64, pilotCabinetId: ids.pilot!, successRatePercent: 95, failureLimitPercent: 5 }, null), refusedWith("not_found"));
  const id = await startRollout(db.app, admin, { version: "0.3.0", architecture: X64, pilotCabinetId: ids.pilot!, successRatePercent: 95, failureLimitPercent: 5 }, null);
  await assert.rejects(startRollout(db.app, admin, { version: "0.3.0", architecture: X64, pilotCabinetId: ids.pilot!, successRatePercent: 95, failureLimitPercent: 5 }, null), refusedWith("rollout_active"));

  const targets = await rolloutTargets(db.app, id);
  const byBatch = (b: number) => targets.filter(t => t.batch === b).map(t => t.cabinet).sort();
  assert.deepEqual(byBatch(1), ["pilot"]);
  assert.deepEqual(byBatch(2), ["office-1", "office-2"]);
  assert.equal(byBatch(3).length, 2, "5% of the 40 field cabinets, rounded up");
  assert.equal(byBatch(4).length, 38);
  assert.ok(!targets.some(t => ["current", "newer"].includes(t.cabinet)), "up-to-date cabinets are left out");
  assert.ok(targets.some(t => t.cabinet === "unknown"), "a cabinet that never reported a version is included");

  // Only the pilot is offered; the store serves the release only to it.
  assert.equal(await offerFor(db.app, ids["office-1"]!, "0.1.0"), null);
  assert.equal(await releaseForAgent(db.app, ids.pilot!, "0.3.0"), null, "not before the offer");
  assert.equal(await offerFor(db.app, ids.pilot!, "0.1.0"), "0.3.0");
  const served = await releaseForAgent(db.app, ids.pilot!, "0.3.0");
  assert.equal(served!.manifest, r.manifest, "the manifest exactly as signed");
  assert.ok(await releasePackageForAgent(db.app, store, ids.pilot!, "0.3.0"));
  assert.equal(await releaseForAgent(db.app, ids["office-1"]!, "0.3.0"), null);
  assert.equal(await releasePackageForAgent(db.app, store, ids["office-1"]!, "0.3.0"), null);
  assert.equal(await releaseForAgent(db.app, ids.pilot!, "../../etc/passwd"), null);

  // The pilot comes back on the new version (its heartbeat says so): batch 2 starts.
  assert.equal(await offerFor(db.app, ids.pilot!, "0.3.0"), null);
  assert.equal((await targetOf(id, ids.pilot!)).state, "succeeded");
  assert.equal((await rolloutOf(id)).currentBatch, 2);
  assert.equal(await offerFor(db.app, ids["office-1"]!, "0.1.0"), "0.3.0");
  assert.equal(await offerFor(db.app, ids["office-2"]!, "0.2.0"), "0.3.0");
  assert.equal(await report(ids["office-1"]!, "0.3.0", "succeeded"), true);
  assert.equal((await rolloutOf(id)).currentBatch, 2, "one of two is 50%, below the 95% success rate");
  assert.equal(await report(ids["office-2"]!, "0.3.0", "succeeded"), true);
  assert.equal((await rolloutOf(id)).currentBatch, 3);

  // Batch 3: both succeed; then batch 4.
  for (const t of (await rolloutTargets(db.app, id)).filter(t => t.batch === 3)) { await offerFor(db.app, t.cabinetId, "0.1.0"); await report(t.cabinetId, "0.3.0", "succeeded"); }
  assert.equal((await rolloutOf(id)).currentBatch, 4);
  // Batch 4: 37 succeed and one stays offline for the whole batch. 37 of 37 counted is 100%: complete, and the offline one is closed as
  // skipped at completion (D80).
  const last = (await rolloutTargets(db.app, id)).filter(t => t.batch === 4);
  const offline = last.find(t => t.cabinet !== "unknown")!;
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(hour, -2, SYSUTCDATETIME()) WHERE id = $1", [offline.cabinetId]);
  for (const t of last.filter(t => t.cabinetId !== offline.cabinetId)) { await offerFor(db.app, t.cabinetId, "0.1.0"); await report(t.cabinetId, "0.3.0", "succeeded"); }
  const done = await rolloutOf(id);
  assert.equal(done.state, "completed");
  assert.deepEqual(done.batches.map(b => [b.batch, b.total, b.succeeded]), [[1, 1, 1], [2, 2, 2], [3, 2, 2], [4, 38, 37]]);
  assert.deepEqual([(await targetOf(id, offline.cabinetId)).state, (await targetOf(id, offline.cabinetId)).outcome], ["skipped", "offline"]);
  // A report for a version nobody offered is not taken.
  assert.equal(await report(ids.current!, "0.9.0", "succeeded"), false);
  const audited = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY seq", [id])).rows.map(r => r.action);
  assert.deepEqual(audited, ["rollout.start", "rollout.batch", "rollout.batch", "rollout.batch", "rollout.complete"]);
});

test("a failure above the limit pauses the rollout on its own; resuming accepts it; a refused release reports its exact check", async () => {
  const r = makeRelease(key, "0.4.0");
  await ready(r);
  const ids = await fleet([{ name: "p", version: "0.3.0" }, { name: "f", version: "0.3.0" }, ...Array.from({ length: 4 }, (_, i) => ({ name: `o${i}`, version: "0.3.0", inOffice: true }))]);
  const id = await startRollout(db.app, admin, { version: "0.4.0", architecture: X64, pilotCabinetId: ids.p!, successRatePercent: 75, failureLimitPercent: 20 }, null);
  await offerFor(db.app, ids.p!, "0.3.0");
  await report(ids.p!, "0.4.0", "succeeded");
  assert.equal((await rolloutOf(id)).currentBatch, 2);
  for (let i = 0; i < 4; i++) await offerFor(db.app, ids[`o${i}`]!, "0.3.0");

  // One of four failed is 25%, above 20%: paused automatically, and no more offers.
  await report(ids.o0!, "0.4.0", "refused", "package_hash");
  const paused = await rolloutOf(id);
  assert.equal(paused.state, "paused");
  assert.match(paused.pausedReason!, /Paused automatically: 1 of 4 cabinets in batch 2/);
  const t = await targetOf(id, ids.o0!);
  assert.deepEqual([t.state, t.outcome, t.check], ["failed", "refused", "package_hash"]);
  assert.equal(await offerFor(db.app, ids.o1!, "0.3.0"), null, "a paused rollout offers nothing");
  assert.ok(await releaseForAgent(db.app, ids.o1!, "0.4.0"), "a cabinet already offered may still download while paused");

  // Resume accepts the failure so far; three of four succeed (75%) and batch 3 starts.
  await changeRollout(db.app, admin, id, "resume", null);
  assert.equal((await rolloutOf(id)).state, "running");
  for (const n of ["o1", "o2"]) await report(ids[n]!, "0.4.0", "succeeded");
  assert.equal((await rolloutOf(id)).currentBatch, 2);
  await report(ids.o3!, "0.4.0", "succeeded");
  assert.equal((await rolloutOf(id)).currentBatch, 3);

  // Pause, resume and stop by hand; illegal moves are refused.
  await assert.rejects(changeRollout(db.app, admin, id, "resume", null), refusedWith("not_allowed"));
  await changeRollout(db.app, admin, id, "pause", null);
  await changeRollout(db.app, admin, id, "stop", null);
  await assert.rejects(changeRollout(db.app, admin, id, "resume", null), refusedWith("not_allowed"));
  assert.equal((await rolloutOf(id)).state, "stopped");
  const actions = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY seq", [id])).rows.map(r => r.action);
  assert.deepEqual(actions, ["rollout.start", "rollout.batch", "rollout.auto_pause", "rollout.resume", "rollout.batch", "rollout.pause", "rollout.stop"]);
});

test("an offered cabinet that never reports counts as failed after 30 minutes, and a rolled-back upgrade is a failure", async () => {
  const r = makeRelease(key, "0.5.0");
  await ready(r);
  const ids = await fleet([{ name: "silent", version: "0.4.0" }, { name: "x", version: "0.4.0", inOffice: true }, { name: "y", version: "0.4.0", inOffice: true }]);
  const id = await startRollout(db.app, admin, { version: "0.5.0", architecture: X64, pilotCabinetId: ids.silent!, successRatePercent: 95, failureLimitPercent: 50 }, null);
  await offerFor(db.app, ids.silent!, "0.4.0");
  await checkRollouts(db.app);
  assert.equal((await targetOf(id, ids.silent!)).state, "offered");
  await db.app.query("UPDATE rollout_targets SET offered_at = DATEADD(minute, -31, SYSUTCDATETIME()) WHERE cabinet_id = $1", [ids.silent]);
  await checkRollouts(db.app);
  const t = await targetOf(id, ids.silent!);
  assert.deepEqual([t.state, t.outcome], ["failed", "timed_out"]);
  assert.equal((await rolloutOf(id)).state, "paused", "one cabinet in batch 1 failing is above any limit");
  await changeRollout(db.app, admin, id, "stop", null);
});

test("the console's Upgrades routes: Admin only, step-up bound to each action and target, every body checked", async () => {
  const secrets = new SecretBox(randomBytes(32).toString("base64"));
  let clock = Date.now();
  const key2 = await developmentIssuingKey(tempDir());
  const feed = new NotificationFeed(db.app, 50);
  await feed.start();
  const stream = new ResultStream(feed, db.app);
  await stream.start();
  const app: FastifyInstance = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key2, origin: ORIGIN, stream, releases: store, logger: false, now: () => clock });
  const account = async (role: "tier2" | "admin") => {
    const a = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple", secret: totp.newSecret() };
    await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc) VALUES ($1, $2, $3, $4, $5, 0, 1, $6)`,
      [a.id, a.username, "Test " + a.username, role, await hashPassword(a.password), secrets.seal(a.secret)]);
    return a;
  };
  type A = Awaited<ReturnType<typeof account>>;
  const code = (a: A) => { clock += 30_000; return totp.code(a.secret, totp.stepAt(clock)); };
  const call = async (method: "GET" | "POST" | "PUT", url: string, body?: unknown, cookie?: string, raw?: Buffer) => {
    const headers: Record<string, string> = { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(raw ? { "content-type": "application/octet-stream" } : body !== undefined ? { "content-type": "application/json" } : {}) };
    const r = await app.inject({ method, url, headers, ...(raw ? { payload: raw } : body === undefined ? {} : { payload: JSON.stringify(body) }) });
    let parsed: any = r.body; try { parsed = JSON.parse(r.body); } catch { /* raw */ }
    return { status: r.statusCode, body: parsed };
  };
  const signIn = async (a: A) => {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ username: a.username, password: a.password }) });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    assert.equal((await call("POST", "/api/auth/totp", { code: code(a) }, cookie)).body.stage, "complete");
    return cookie;
  };
  const stepUp = async (a: A, cookie: string, action: string, target: string, params?: unknown) => {
    const r = await call("POST", "/api/auth/step-up", { code: code(a), action, target, ...(params !== undefined ? { paramsHash: paramsHash(params) } : {}) }, cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.token as string;
  };
  try {
    const boss = await account("admin"), other = await account("admin"), tier2 = await account("tier2");
    const [bc, oc, tc] = [await signIn(boss), await signIn(other), await signIn(tier2)];
    const ids = await fleet([{ name: "c1", version: "0.5.0" }]);

    // Tier 2 cannot see or do any of it, even with a token.
    for (const [m, u] of [["GET", "/api/admin/releases"], ["GET", "/api/admin/rollouts"], ["GET", "/api/admin/upgrade-candidates"]] as const)
      assert.equal((await call(m, u, undefined, tc)).status, 403, u);
    assert.equal((await call("POST", "/api/admin/rollouts", { version: "0.6.0", architecture: X64, pilotCabinetId: ids.c1, successRatePercent: 95, failureLimitPercent: 5, stepUpToken: "A".repeat(43) }, tc)).status, 403);

    const r = makeRelease(key, "0.6.0");
    // A token for another action is refused; hostile bodies are refused before anything reads them.
    assert.equal((await call("POST", "/api/admin/releases", { manifest: r.manifest, signature: r.signature, architecture: X64, stepUpToken: await stepUp(boss, bc, "rollout.start", "fleet", { manifest: r.manifest, signature: r.signature, architecture: X64 }) }, bc)).status, 403);
    assert.equal((await call("POST", "/api/admin/releases", { manifest: r.manifest, signature: { ...r.signature, path: "C:/x" }, architecture: X64, stepUpToken: "A".repeat(43) }, bc)).status, 400);
    const added = await call("POST", "/api/admin/releases", { manifest: r.manifest, signature: r.signature, architecture: X64, stepUpToken: await stepUp(boss, bc, "release.add", "fleet", { manifest: r.manifest, signature: r.signature, architecture: X64 }) }, bc);
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal((await call("PUT", "/api/admin/releases/0.6.0/package?architecture=windows-x64", undefined, oc, r.zip)).status, 403, "only the Admin who added it uploads its package");
    assert.equal((await call("PUT", "/api/admin/releases/..%2F..%2Fx/package?architecture=windows-x64", undefined, bc, r.zip)).status, 404);
    assert.equal((await call("PUT", "/api/admin/releases/0.6.0/package?architecture=windows-x64", { x: 1 }, bc)).status, 415);
    const pkg = await call("PUT", "/api/admin/releases/0.6.0/package?architecture=windows-x64", undefined, bc, r.zip);
    assert.equal(pkg.body.state, "ready", JSON.stringify(pkg.body));

    // In office, with a step-up bound to the cabinet.
    assert.equal((await call("PUT", `/api/admin/cabinets/${ids.c1}/in-office`, { inOffice: true, stepUpToken: await stepUp(boss, bc, "cabinet.in_office", randomUUID()) }, bc)).status, 403);
    assert.equal((await call("PUT", `/api/admin/cabinets/${ids.c1}/in-office`, { inOffice: true, stepUpToken: await stepUp(boss, bc, "cabinet.in_office", ids.c1!, { inOffice: true }) }, bc)).status, 200);
    assert.equal((await call("GET", "/api/admin/upgrade-candidates", undefined, bc)).body.find((c: { id: string }) => c.id === ids.c1).inOffice, true);

    // Start, then pause, resume and stop, each with its own token for this rollout.
    assert.equal((await call("POST", "/api/admin/rollouts", { version: "0.6.0", architecture: X64, pilotCabinetId: ids.c1, successRatePercent: 10, failureLimitPercent: 5, stepUpToken: "A".repeat(43) }, bc)).status, 400, "no success bar below 50%");
    const started = await call("POST", "/api/admin/rollouts", { version: "0.6.0", architecture: X64, pilotCabinetId: ids.c1, successRatePercent: 95, failureLimitPercent: 5,
      stepUpToken: await stepUp(boss, bc, "rollout.start", "fleet", { version: "0.6.0", architecture: X64, pilotCabinetId: ids.c1, successRatePercent: 95, failureLimitPercent: 5 }) }, bc);
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const rid = started.body.rolloutId as string;
    assert.equal((await call("POST", `/api/admin/rollouts/${rid}/pause`, { stepUpToken: await stepUp(boss, bc, "rollout.pause", randomUUID()) }, bc)).status, 403);
    assert.equal((await call("POST", `/api/admin/rollouts/${rid}/pause`, { stepUpToken: await stepUp(other, oc, "rollout.pause", rid) }, oc)).status, 200);
    assert.equal((await call("POST", `/api/admin/rollouts/${rid}/resume`, { stepUpToken: await stepUp(boss, bc, "rollout.resume", rid) }, bc)).status, 200);
    const detail = await call("GET", `/api/admin/rollouts/${rid}`, undefined, bc);
    assert.equal(detail.body.targets.find((t: { cabinetId: string }) => t.cabinetId === ids.c1).batch, 1);
    assert.equal((await call("POST", `/api/admin/rollouts/${rid}/stop`, { stepUpToken: await stepUp(boss, bc, "rollout.stop", rid) }, bc)).status, 200);
    assert.equal((await call("GET", `/api/admin/rollouts/${rid}`, undefined, bc)).body.state, "stopped");
  } finally {
    await app.close();
    await stream.stop(); feed.stop();
  }
});

// ---- The whole channel with the real agent code (agent/tests/Cabinet.Agent.TestAgent) ------------------------------

const dll = process.env.TEST_AGENT_DLL;

async function withAgent(env: Record<string, string>, body: (ctx: { cabinetId: string; lines: string[]; until: (what: string, check: () => boolean | Promise<boolean>, ms?: number) => Promise<void>;
  db: TestDatabase; store: ReleaseStore; admin: string }) => Promise<void>): Promise<void> {
  const db2 = await createTestDatabase();
  const dir = tempDir();
  const issuing = await developmentIssuingKey(dir);
  const feed2 = new NotificationFeed(db2.app, 50);
  await feed2.start();
  const notifier = new CommandNotifier(feed2);
  await notifier.start();
  const store2: ReleaseStore = { dir: join(dir, "releases"), maxBytes: 1024 * 1024, keys: ReleaseKeys.fromFolder(env.TEST_UPGRADE_TRUST_DIR) };
  mkdirSync(store2.dir);
  const api = await buildAgentApi({ pool: db2.app, issuingKey: issuing, notifier, releases: store2, tls: await developmentServerCertificate(issuing, dir, ["localhost"]), longPollMs: 3000, logger: false });
  await api.listen({ host: "127.0.0.1", port: 0 });
  const port = (api.server.address() as { port: number }).port;
  const admin2 = randomUUID();
  await db2.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'e2e.admin', 'E2E Admin', 'admin')", [admin2]);
  const state = join(dir, "agent-state");
  mkdirSync(state);
  const caPath = join(dir, "platform-ca.pem");
  writeFileSync(caPath, issuing.certificatePem);
  writeFileSync(join(state, "bootstrap-token"), (await createBootstrapToken(db2.app, admin2)).token);
  const lines: string[] = [];
  const agent: ChildProcess = spawn("dotnet", [dll!, `https://localhost:${port}`, caPath, state], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  agent.stdout!.on("data", d => lines.push(...String(d).split("\n").filter(Boolean)));
  agent.stderr!.on("data", d => lines.push(...String(d).split("\n").filter(Boolean)));
  const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 200))) if (await check()) return;
    assert.fail(`timed out waiting for ${what}. Agent log:\n${lines.join("\n")}`);
  };
  try {
    await until("the enrollment request", () => lines.some(l => l.includes("waiting for an administrator")));
    const [pending] = await pendingRequests(db2.app);
    const { cabinetId } = await approveEnrollment(db2.app, issuing, pending!.id, { clientName: "E2E", siteName: "Lab", cabinetName: "Upgrading", role: "standalone" }, admin2);
    await until("the cabinet online", async () => (await listCabinets(db2.app)).some(c => c.id === cabinetId && c.online));
    await body({ cabinetId, lines, until, db: db2, store: store2, admin: admin2 });
    assert.equal((await verifyAuditChain(db2.app)).ok, true);
  } finally {
    agent.kill("SIGINT");
    await api.close();
    await notifier.stop(); feed2.stop();
    await db2.drop();
  }
}

test("cabinets older than a release's minimum version are left out of its rollout instead of failing it", async () => {
  const r = makeRelease(key, "0.7.0", agentPackage(), { minimumVersion: "0.5.0" });
  await ready(r);
  const ids = await fleet([{ name: "ok", version: "0.5.0" }, { name: "too-old", version: "0.2.0" }, { name: "office", version: "0.5.1", inOffice: true }]);
  await assert.rejects(startRollout(db.app, admin, { version: "0.7.0", architecture: X64, pilotCabinetId: ids["too-old"]!, successRatePercent: 95, failureLimitPercent: 5 }, null),
    refusedWith("pilot_not_eligible"));
  const id = await startRollout(db.app, admin, { version: "0.7.0", architecture: X64, pilotCabinetId: ids.ok!, successRatePercent: 95, failureLimitPercent: 5 }, null);
  assert.deepEqual((await rolloutTargets(db.app, id)).map(t => t.cabinet).sort(), ["office", "ok"]);
  const audited = (await db.app.query<{ details: { belowMinimumVersion: number } }>("SELECT details FROM audit_log WHERE action = 'rollout.start' AND target_id = $1", [id])).rows[0]!;
  assert.equal(audited.details.belowMinimumVersion, 1);
  await changeRollout(db.app, admin, id, "stop", null);
});

test("done-when on the real agent code: a signed upgrade rolls out to a test batch; a tampered package is refused at its hash and pauses the rollout",
  { skip: !dll && "set TEST_AGENT_DLL to run", timeout: 180_000 }, async () => {
  const pki = new TestPki();
  const signer = pki.signer("Mashura Agent Code Signing", "Mashura");
  const trustDir = keysFolder([key], pki, signer);
  await withAgent({ TEST_UPGRADE_TRUST_DIR: trustDir, TEST_AGENT_VERSION: "0.1.0" }, async ({ cabinetId, lines, until, db: d, store: s, admin: a }) => {
    const ok = makeRelease(key, "0.1.1");
    await addRelease(d.app, s.keys, a, ok.manifest, ok.signature, X64, null);
    await receiveReleasePackage(d.app, s, a, "0.1.1", X64, Readable.from([ok.zip]));
    const id = await startRollout(d.app, a, { version: "0.1.1", architecture: X64, pilotCabinetId: cabinetId, successRatePercent: 95, failureLimitPercent: 5 }, null);
    await until("the upgrade to succeed", async () => (await rolloutTargets(d.app, id))[0]!.state === "succeeded");
    assert.ok(lines.some(l => l.includes("passed every check")), lines.join("\n"));
    assert.equal((await listRollouts(d.app)).find(r => r.id === id)!.state, "completed", "the test batch was the only batch");
    const downloads = (await d.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'release.download'")).rows[0]!.n;
    assert.equal(downloads, 1);

    // The next release, then someone with access to the server's store swaps its package for one of the same size.
    const next = makeRelease(key, "0.1.2");
    await addRelease(d.app, s.keys, a, next.manifest, next.signature, X64, null);
    await receiveReleasePackage(d.app, s, a, "0.1.2", X64, Readable.from([next.zip]));
    const file = join(s.dir, "agent-0.1.2-windows-x64.zip");
    const tampered = Buffer.from(next.zip); tampered[tampered.length >> 1]! ^= 0xff;
    chmodSync(file, 0o644); writeFileSync(file, tampered);
    const id2 = await startRollout(d.app, a, { version: "0.1.2", architecture: X64, pilotCabinetId: cabinetId, successRatePercent: 95, failureLimitPercent: 5 }, null);
    await until("the refusal", async () => (await rolloutTargets(d.app, id2))[0]!.state === "failed");
    const t = (await rolloutTargets(d.app, id2))[0]!;
    assert.deepEqual([t.outcome, t.check], ["refused", "package_hash"]);
    assert.equal((await listRollouts(d.app)).find(r => r.id === id2)!.state, "paused", "the failure paused the rollout on its own");
    await until("the security alert", async () => (await d.app.query("SELECT 1 FROM security_alerts WHERE kind = 'package_refused' AND cabinet_id = $1", [cabinetId])).rows.length === 1);
  });
});

test("done-when on the real agent code: a release that fails Authenticode is refused, and an upgrade that does not check in is reported rolled back",
  { skip: !dll && "set TEST_AGENT_DLL to run", timeout: 180_000 }, async () => {
  const pki = new TestPki();
  const signer = pki.signer("Mashura Agent Code Signing", "Mashura");
  const trustDir = keysFolder([key], pki, signer);
  await withAgent({ TEST_UPGRADE_TRUST_DIR: trustDir, TEST_AGENT_VERSION: "0.1.0", TEST_UPGRADE_OUTCOME: "rollback" }, async ({ cabinetId, until, db: d, store: s, admin: a }) => {
    // Properly signed manifest over a package whose network service binary is unsigned.
    const unsigned = makeRelease(key, "0.1.1", agentPackage(X64, [["Cabinet.Agent.Network/extra.dll", Buffer.from("MZ|unsigned")]]));
    await addRelease(d.app, s.keys, a, unsigned.manifest, unsigned.signature, X64, null);
    await receiveReleasePackage(d.app, s, a, "0.1.1", X64, Readable.from([unsigned.zip]));
    const id = await startRollout(d.app, a, { version: "0.1.1", architecture: X64, pilotCabinetId: cabinetId, successRatePercent: 95, failureLimitPercent: 5 }, null);
    await until("the Authenticode refusal", async () => (await rolloutTargets(d.app, id))[0]!.state === "failed");
    assert.deepEqual([(await rolloutTargets(d.app, id))[0]!.outcome, (await rolloutTargets(d.app, id))[0]!.check], ["refused", "authenticode"]);
    await until("the signature alert", async () => (await d.app.query("SELECT 1 FROM security_alerts WHERE kind = 'signature_failure' AND cabinet_id = $1", [cabinetId])).rows.length === 1);
    await changeRollout(d.app, a, id, "stop", null);

    const good = makeRelease(key, "0.1.2");
    await addRelease(d.app, s.keys, a, good.manifest, good.signature, X64, null);
    await receiveReleasePackage(d.app, s, a, "0.1.2", X64, Readable.from([good.zip]));
    const id2 = await startRollout(d.app, a, { version: "0.1.2", architecture: X64, pilotCabinetId: cabinetId, successRatePercent: 95, failureLimitPercent: 5 }, null);
    await until("the rolled-back report", async () => (await rolloutTargets(d.app, id2))[0]!.state === "failed");
    const t = (await rolloutTargets(d.app, id2))[0]!;
    assert.deepEqual([t.outcome, t.check], ["rolled_back", "check_in"]);
    assert.match(t.message!, /0\.1\.0 was restored/);
  });
});

// ---- The second architecture (docs/platform/archive/second-architecture.md) -----------------------------------------------

test("a release is one version for one architecture: each architecture has its own versions, and they only go up on their own", async () => {
  // The x86 line is empty: nothing has ever been built for it, so its first release can be any version.
  await ready(makeRelease(key, "0.9.0", agentPackage(X86), {}, X86));
  // The same version for x64 is a different release, not a duplicate of it.
  await ready(makeRelease(key, "0.9.0"));
  assert.deepEqual((await listReleases(db.app)).filter(r => r.version === "0.9.0").map(r => `${r.version} ${r.architecture}`).sort(),
    ["0.9.0 windows-x64", "0.9.0 windows-x86"]);
  // The x64 line moves ahead of the x86 one, and the x86 line's next version is still an increase for it...
  await ready(makeRelease(key, "0.9.3"));
  await ready(makeRelease(key, "0.9.1", agentPackage(X86), {}, X86));
  assert.equal((await listReleases(db.app)).find(r => r.version === "0.9.1" && r.architecture === X86)!.state, "ready");
  // ...while the same version is below the x64 line's newest, so it is refused there and the refusal names the architecture.
  await assert.rejects(upload(makeRelease(key, "0.9.1")), (e: unknown) => {
    assert.equal((e as Refused).code, "version_not_newer");
    assert.match((e as Error).message, /windows-x64/);
    return true;
  });
  // Inside one line the old rules hold: no reuse of a version, and no going back.
  await assert.rejects(upload(makeRelease(key, "0.9.0", agentPackage(X86), {}, X86)), refusedWith("version_exists"));
  await assert.rejects(upload(makeRelease(key, "0.9.0-rc.1", agentPackage(X86), {}, X86)), refusedWith("version_not_newer"));
});

test("a package whose programs are built for the other architecture is refused when its bytes arrive, and is not stored", async () => {
  // The pipeline declares x64 and signs a manifest over the x86 build. The manifest and its hash are honest, so only the
  // programs inside the package can catch it - which is exactly why the store reads them (releases.ts receiveReleasePackage).
  const lying = makeRelease(key, "0.9.5", agentPackage(X86), {}, X64);
  await upload(lying);
  await assert.rejects(receiveReleasePackage(db.app, store, admin, "0.9.5", X64, Readable.from([lying.zip])), (e: unknown) => {
    assert.equal((e as Refused).code, "architecture_mismatch");
    assert.match((e as Error).message, /built for windows-x86/);
    return true;
  });
  assert.equal((await listReleases(db.app)).find(r => r.version === "0.9.5" && r.architecture === X64)!.state, "refused",
    "the release goes back with the reason, so the right package can be added to it");
  assert.equal(existsSync(join(store.dir, "agent-0.9.5-windows-x64.zip")), false, "the other architecture's package is never kept");
  // The x86 package is the x86 release's package, and arrives there without complaint.
  await ready(makeRelease(key, "0.9.4", agentPackage(X86), {}, X86));
  // And the release that was refused takes the package that really is its own.
  const right = makeRelease(key, "0.9.5");
  await upload(right);
  await receiveReleasePackage(db.app, store, admin, "0.9.5", X64, Readable.from([right.zip]));
  assert.equal((await listReleases(db.app)).find(r => r.version === "0.9.5" && r.architecture === X64)!.state, "ready");
});

test("a rollout offers its release only to cabinets that can run it, counts the ones it leaves out, and never hands out the other architecture's package", async () => {
  const ids = await fleet([{ name: "x64-pilot", version: "0.1.0" }, { name: "x64-office", version: "0.1.0", inOffice: true },
    { name: "x86-office", version: "0.1.0", inOffice: true }, { name: "quiet-office", version: "0.1.0", inOffice: true }]);
  // One cabinet's agent reported the second architecture; one has never reported an architecture at all.
  await db.app.query("UPDATE cabinets SET architecture = 'windows-x86' WHERE id = $1", [ids["x86-office"]]);
  assert.deepEqual((await db.app.query<{ architecture: string | null }>("SELECT architecture FROM cabinets WHERE id = $1", [ids["quiet-office"]])).rows, [{ architecture: null }]);

  await ready(makeRelease(key, "0.9.6", agentPackage(X86), {}, X86));
  // A cabinet whose agent is built for x64 cannot be the first cabinet of an x86 rollout, and is told why.
  await assert.rejects(startRollout(db.app, admin, { version: "0.9.6", architecture: X86, pilotCabinetId: ids["x64-pilot"]!, successRatePercent: 95, failureLimitPercent: 5 }, null), (e: unknown) => {
    assert.equal((e as Refused).code, "pilot_not_eligible");
    assert.match((e as Error).message, /built for windows-x64, not windows-x86/);
    return true;
  });
  const x86Run = await startRollout(db.app, admin, { version: "0.9.6", architecture: X86, pilotCabinetId: ids["x86-office"]!, successRatePercent: 95, failureLimitPercent: 5 }, null);
  assert.deepEqual((await rolloutTargets(db.app, x86Run)).map(t => t.cabinet), ["x86-office"], "an x86 release reaches only the x86 cabinet");
  const started = (await db.app.query<{ details: { wrongArchitecture: number; belowMinimumVersion: number } }>("SELECT details FROM audit_log WHERE action = 'rollout.start' AND target_id = $1", [x86Run])).rows[0]!;
  assert.deepEqual([started.details.wrongArchitecture, started.details.belowMinimumVersion], [3, 0],
    "the three cabinets that cannot run an x86 program are counted apart, and none of them is offered it");
  await changeRollout(db.app, admin, x86Run, "stop", null);

  // The other way round: the x64 release reaches the x64 cabinets and the one cabinet whose agent reported x86 is left out.
  await ready(makeRelease(key, "0.9.7"));
  const x64Run = await startRollout(db.app, admin, { version: "0.9.7", architecture: X64, pilotCabinetId: ids["x64-pilot"]!, successRatePercent: 95, failureLimitPercent: 5 }, null);
  assert.deepEqual((await rolloutTargets(db.app, x64Run)).map(t => t.cabinet).sort(), ["quiet-office", "x64-office", "x64-pilot"]);
  const x64Started = (await db.app.query<{ details: { wrongArchitecture: number } }>("SELECT details FROM audit_log WHERE action = 'rollout.start' AND target_id = $1", [x64Run])).rows[0]!;
  assert.equal(x64Started.details.wrongArchitecture, 1, "only the cabinet whose agent reported x86 is left out of it");
  // A cabinet whose agent has never reported an architecture is a win-x64 one by construction (only that build ever shipped),
  // so it keeps updating exactly as before: it can be offered this release, and is served both manifest and package.
  assert.equal(await offerFor(db.app, ids["x64-pilot"]!, "0.1.0"), "0.9.7");
  assert.ok(await releaseForAgent(db.app, ids["x64-pilot"]!, "0.9.7"), "a cabinet with no architecture yet is served the x64 release");
  assert.equal((await releasePackageForAgent(db.app, store, ids["x64-pilot"]!, "0.9.7"))!.path, join(store.dir, "agent-0.9.7-windows-x64.zip"));
  // And the x86 cabinet is never offered the x64 release, nor handed it or its package.
  assert.equal(await offerFor(db.app, ids["x86-office"]!, "0.1.0"), null);
  assert.equal(await releaseForAgent(db.app, ids["x86-office"]!, "0.9.7"), null);
  assert.equal(await releasePackageForAgent(db.app, store, ids["x86-office"]!, "0.9.7"), null);
  await changeRollout(db.app, admin, x64Run, "stop", null);
});

test("a rollout completes only once the offers of every batch it reached have an outcome, and closes every target still pending, offline or not", async () => {
  // Fleet audit finding 4, decision-log D80: completion looked only at the last batch, so an earlier batch's open offer and every pending
  // target, offline or not, were left pending or offered for good once the rollout had completed.
  const r = makeRelease(key, "0.9.8");
  await ready(r);
  const ids = await fleet([{ name: "pilot", version: "0.1.0" }, { name: "office-1", version: "0.1.0", inOffice: true }, { name: "office-2", version: "0.1.0", inOffice: true },
    { name: "office-3", version: "0.1.0", inOffice: true, online: false }, ...Array.from({ length: 4 }, (_, i) => ({ name: `field-${i}`, version: "0.1.0" }))]);
  const id = await startRollout(db.app, admin, { version: "0.9.8", architecture: X64, pilotCabinetId: ids.pilot!, successRatePercent: 50, failureLimitPercent: 50 }, null);
  const upgrade = async (cabinet: string) => { assert.equal(await offerFor(db.app, cabinet, "0.1.0"), "0.9.8"); assert.equal(await report(cabinet, "0.9.8", "succeeded"), true); };
  await upgrade(ids.pilot!);
  // Batch 2: one upgrades, one takes the offer and has not reported yet, one is offline. 1 of the 2 counted is the 50% rate: batch 3 starts.
  await upgrade(ids["office-1"]!);
  assert.equal(await offerFor(db.app, ids["office-2"]!, "0.1.0"), "0.9.8");
  assert.equal((await rolloutOf(id)).currentBatch, 3);
  const inBatch = async (b: number) => (await rolloutTargets(db.app, id)).filter(t => t.batch === b);
  for (const t of await inBatch(3)) await upgrade(t.cabinetId);
  assert.equal((await rolloutOf(id)).currentBatch, 4);
  // The last batch: one offline, one online that never takes the offer, the rest upgrade; every one counted succeeds.
  const last = await inBatch(4);
  assert.equal(last.length, 3);
  const [quiet, idle, ...rest] = last;
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(hour, -2, SYSUTCDATETIME()) WHERE id = $1", [quiet!.cabinetId]);
  for (const t of rest) await upgrade(t.cabinetId);
  await checkRollouts(db.app);
  void idle;
  assert.equal((await rolloutOf(id)).state, "running", "batch 2's open offer is waited for");
  // That offer times out after 30 minutes (a failure in batch 2): now the rollout completes.
  await db.app.query("UPDATE rollout_targets SET offered_at = DATEADD(minute, -31, SYSUTCDATETIME()) WHERE rollout_id = $1 AND cabinet_id = $2", [id, ids["office-2"]]);
  await checkRollouts(db.app);
  const done = await rolloutOf(id);
  assert.equal(done.state, "completed");
  const targets = await rolloutTargets(db.app, id);
  assert.deepEqual(targets.filter(t => t.state === "pending" || t.state === "offered"), [], "nothing is left waiting");
  const of = (cabinet: string) => targets.find(t => t.cabinetId === cabinet)!;
  assert.deepEqual([of(ids["office-2"]!).state, of(ids["office-2"]!).outcome], ["failed", "timed_out"]);
  for (const cabinet of [ids["office-3"]!, quiet!.cabinetId]) assert.deepEqual([of(cabinet).state, of(cabinet).outcome], ["skipped", "offline"]);
  assert.deepEqual([of(idle!.cabinetId).state, of(idle!.cabinetId).outcome], ["skipped", null]);
  assert.ok(of(idle!.cabinetId).message, "a cabinet skipped with no outcome still says why");
  const complete = (await db.app.query<{ details: { closedOffline: number; closedNotReached: number } }>(
    "SELECT details FROM audit_log WHERE target_id = $1 AND action = 'rollout.complete'", [id])).rows;
  assert.deepEqual(complete.map(c => [c.details.closedOffline, c.details.closedNotReached]), [[2, 1]], "completed once, saying what it closed");
  // Completed is final: a cabinet that comes back is not offered the version.
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME() WHERE id = $1", [ids["office-3"]]);
  assert.equal(await offerFor(db.app, ids["office-3"]!, "0.1.0"), null);
});

test("a batch whose every cabinet stays offline moves on once they are skipped, so the rollout completes and the next can start", async () => {
  // Decision-log D82, found in review of #268: nothing in such a batch can be counted, so its rate was never reached; the day-offline
  // skip only moved the cabinets to skipped, and the rollout stayed running for good, refusing every later rollout with rollout_active.
  const r = makeRelease(key, "0.9.9");
  await ready(r);
  const ids = await fleet([{ name: "pilot", version: "0.1.0" }, { name: "office-a", version: "0.1.0", inOffice: true, online: false },
    { name: "office-b", version: "0.1.0", inOffice: true, online: false }, { name: "field-a", version: "0.1.0" }]);
  const id = await startRollout(db.app, admin, { version: "0.9.9", architecture: X64, pilotCabinetId: ids.pilot!, successRatePercent: 95, failureLimitPercent: 5 }, null);
  assert.equal(await offerFor(db.app, ids.pilot!, "0.1.0"), "0.9.9");
  assert.equal(await report(ids.pilot!, "0.9.9", "succeeded"), true);
  assert.equal((await rolloutOf(id)).currentBatch, 2, "batch 2 is the two offline office cabinets");
  // Within the day the batch waits for them, as before.
  await checkRollouts(db.app);
  assert.equal((await rolloutOf(id)).currentBatch, 2);
  // A day later they are skipped as offline, and the batch moves on instead of holding the rollout open.
  await db.app.query("UPDATE rollouts SET batch_started_at = DATEADD(hour, -25, SYSUTCDATETIME()) WHERE id = $1", [id]);
  await checkRollouts(db.app);
  const moved = await rolloutOf(id);
  assert.equal(moved.state, "running");
  assert.ok(moved.currentBatch > 2, `the rollout left batch 2 (now ${moved.currentBatch})`);
  for (const cabinet of [ids["office-a"]!, ids["office-b"]!]) assert.deepEqual([(await targetOf(id, cabinet)).state, (await targetOf(id, cabinet)).outcome], ["skipped", "offline"]);
  const batch = (await db.app.query<{ details: { finishedBatch: number; counted: number } }>(
    "SELECT details FROM audit_log WHERE target_id = $1 AND action = 'rollout.batch' ORDER BY seq", [id])).rows.map(a => a.details);
  assert.deepEqual(batch.map(b => [b.finishedBatch, b.counted]), [[1, 1], [2, 0]], "the move past batch 2 is audited, saying nothing in it was counted");
  // The last cabinet upgrades: the rollout completes, and the fleet can start another one.
  assert.equal(await offerFor(db.app, ids["field-a"]!, "0.1.0"), "0.9.9");
  assert.equal(await report(ids["field-a"]!, "0.9.9", "succeeded"), true);
  assert.equal((await rolloutOf(id)).state, "completed");
  const next = makeRelease(key, "1.0.0");
  await ready(next);
  const second = await startRollout(db.app, admin, { version: "1.0.0", architecture: X64, pilotCabinetId: ids["field-a"]!, successRatePercent: 95, failureLimitPercent: 5 }, null);
  assert.ok(second, "a second rollout starts instead of being refused with rollout_active");
  await changeRollout(db.app, admin, second, "stop", null);
});
