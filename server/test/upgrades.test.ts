// Milestone 7 on the server: the update store (signature, hash, versions only go up), staged rollouts (batches, the
// success rate, automatic pause, timeouts, offline cabinets), offers and downloads only to offered cabinets, the
// console's Upgrades routes by role and step-up, and the whole channel with the real agent code.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
import { buildAgentApi } from "../src/agent-api/server.js";
import { approveEnrollment, createBootstrapToken, pendingRequests } from "../src/services/enrollment.js";
import { listCabinets } from "../src/services/cabinets.js";
import { addRelease, compareVersions, isVersion, listReleases, receiveReleasePackage, releaseForAgent, releasePackageForAgent, ReleaseKeys, type ReleaseStore } from "../src/services/releases.js";
import { changeRollout, checkRollouts, listRollouts, offerFor, recordUpgradeStatus, rolloutTargets, setInOffice, startRollout } from "../src/services/rollouts.js";
import { Refused } from "../src/services/errors.js";
import { verifyAuditChain } from "../src/db/db.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";
import { agentPackage, keysFolder, makeRelease, releaseKey, type Release } from "./release-kit.js";
import { TestPki } from "./package-pki.js";

const ORIGIN = "https://console.test";
const key = releaseKey();
const otherKey = releaseKey();
let db: TestDatabase;
let store: ReleaseStore;
let admin: string;

const refusedWith = (code: string) => (e: unknown) => { assert.ok(e instanceof Refused, String(e)); assert.equal(e.code, code, e.message); return true; };
const upload = (r: Release, by = admin) => addRelease(db.app, store.keys, by, r.manifest, r.signature, null);
const ready = async (r: Release) => { await upload(r); await receiveReleasePackage(db.app, store, admin, r.version, Readable.from([r.zip])); };

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
                        VALUES ($1, $2, $3, 'standalone', 'active', $4, $5, CASE WHEN $6 THEN now() ELSE now() - interval '2 hours' END)`,
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
  // The repository's own file holds no key until the production KMS key exists: such a server accepts no release.
  assert.equal(ReleaseKeys.fromFolder().count, 0);

  const before = (await db.app.query("SELECT count(*)::int AS n FROM security_alerts WHERE kind = 'signature_failure'")).rows[0].n;
  // Signed by a key the agents do not hold.
  await assert.rejects(upload(makeRelease(otherKey, "0.2.0")), refusedWith("signature_invalid"));
  // A manifest changed after signing.
  const good = makeRelease(key, "0.2.0");
  const changed = Buffer.from(good.manifestBytes.toString().replace("0.0.1", "0.0.0"));
  await assert.rejects(addRelease(db.app, store.keys, admin, changed.toString("base64"), good.signature, null), refusedWith("signature_invalid"));
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM security_alerts WHERE kind = 'signature_failure'")).rows[0].n, before + 2, "one open alert per key, each attempt folded into it");
  // Signed, but not a manifest the agent would read.
  await assert.rejects(upload(makeRelease(key, "0.2.0", agentPackage(), { product: "other" })), refusedWith("invalid_manifest"));
  await assert.rejects(upload(makeRelease(key, "0.2.0", agentPackage(), { postInstall: "cmd /c calc" })), refusedWith("invalid_manifest"));
  await assert.rejects(upload(makeRelease(key, "0.2.0", agentPackage(), { minimumVersion: "0.2.0" })), refusedWith("invalid_manifest"));
  await assert.rejects(addRelease(db.app, store.keys, admin, good.manifest.replace(/=*$/, "") + "@@", good.signature, null), refusedWith("invalid_manifest"));
  await assert.rejects(addRelease(db.app, store.keys, admin, Buffer.alloc(5000, 32).toString("base64"), good.signature, null), refusedWith("invalid_manifest"));

  // The right manifest, then a package that is not the one it names: refused, and the version may be added again.
  await upload(good);
  const wrong = Buffer.from(good.zip); wrong[wrong.length >> 1]! ^= 0xff;
  await assert.rejects(receiveReleasePackage(db.app, store, admin, "0.2.0", Readable.from([wrong])), refusedWith("hash_mismatch"));
  await assert.rejects(receiveReleasePackage(db.app, store, admin, "0.2.0", Readable.from([good.zip, Buffer.from("x")])), refusedWith("not_awaiting_package"));
  assert.equal((await listReleases(db.app)).find(r => r.version === "0.2.0")!.state, "refused");
  await upload(good);
  const larger = Buffer.concat([good.zip, Buffer.from("trailing")]);
  await assert.rejects(receiveReleasePackage(db.app, store, admin, "0.2.0", Readable.from([larger])), refusedWith("hash_mismatch"));
  await upload(good);
  await receiveReleasePackage(db.app, store, admin, "0.2.0", Readable.from([good.zip]));
  assert.equal((await listReleases(db.app)).find(r => r.version === "0.2.0")!.state, "ready");
  await assert.rejects(receiveReleasePackage(db.app, store, admin, "0.2.0", Readable.from([good.zip])), refusedWith("not_awaiting_package"));

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
  await assert.rejects(startRollout(db.app, admin, { version: "0.3.0", pilotCabinetId: ids.current!, successRatePercent: 95, failureLimitPercent: 5 }, null), refusedWith("pilot_not_eligible"));
  await assert.rejects(startRollout(db.app, admin, { version: "9.9.9", pilotCabinetId: ids.pilot!, successRatePercent: 95, failureLimitPercent: 5 }, null), refusedWith("not_found"));
  const id = await startRollout(db.app, admin, { version: "0.3.0", pilotCabinetId: ids.pilot!, successRatePercent: 95, failureLimitPercent: 5 }, null);
  await assert.rejects(startRollout(db.app, admin, { version: "0.3.0", pilotCabinetId: ids.pilot!, successRatePercent: 95, failureLimitPercent: 5 }, null), refusedWith("rollout_active"));

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
  // Batch 4: 37 succeed and one stays offline for the whole batch. 37 of 37 counted is 100%: complete, the offline one skipped later.
  const last = (await rolloutTargets(db.app, id)).filter(t => t.batch === 4);
  const offline = last.find(t => t.cabinet !== "unknown")!;
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = now() - interval '2 hours' WHERE id = $1", [offline.cabinetId]);
  for (const t of last.filter(t => t.cabinetId !== offline.cabinetId)) { await offerFor(db.app, t.cabinetId, "0.1.0"); await report(t.cabinetId, "0.3.0", "succeeded"); }
  const done = await rolloutOf(id);
  assert.equal(done.state, "completed");
  assert.deepEqual(done.batches.map(b => [b.batch, b.total, b.succeeded]), [[1, 1, 1], [2, 2, 2], [3, 2, 2], [4, 38, 37]]);
  // A report for a version nobody offered is not taken.
  assert.equal(await report(ids.current!, "0.9.0", "succeeded"), false);
  const audited = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY seq", [id])).rows.map(r => r.action);
  assert.deepEqual(audited, ["rollout.start", "rollout.batch", "rollout.batch", "rollout.batch", "rollout.complete"]);
});

test("a failure above the limit pauses the rollout on its own; resuming accepts it; a refused release reports its exact check", async () => {
  const r = makeRelease(key, "0.4.0");
  await ready(r);
  const ids = await fleet([{ name: "p", version: "0.3.0" }, { name: "f", version: "0.3.0" }, ...Array.from({ length: 4 }, (_, i) => ({ name: `o${i}`, version: "0.3.0", inOffice: true }))]);
  const id = await startRollout(db.app, admin, { version: "0.4.0", pilotCabinetId: ids.p!, successRatePercent: 75, failureLimitPercent: 20 }, null);
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
  const id = await startRollout(db.app, admin, { version: "0.5.0", pilotCabinetId: ids.silent!, successRatePercent: 95, failureLimitPercent: 50 }, null);
  await offerFor(db.app, ids.silent!, "0.4.0");
  await checkRollouts(db.app);
  assert.equal((await targetOf(id, ids.silent!)).state, "offered");
  await db.app.query("UPDATE rollout_targets SET offered_at = now() - interval '31 minutes' WHERE cabinet_id = $1", [ids.silent]);
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
  const stream = new ResultStream(db.appUrl, db.app);
  await stream.start();
  const app: FastifyInstance = await buildConsoleApi({ pool: db.app, secrets, issuingKey: key2, origin: ORIGIN, stream, releases: store, logger: false, now: () => clock });
  const account = async (role: "tier2" | "admin") => {
    const a = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple", secret: totp.newSecret() };
    await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc) VALUES ($1, $2, $3, $4, $5, false, true, $6)`,
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
  const stepUp = async (a: A, cookie: string, action: string, target: string) => {
    const r = await call("POST", "/api/auth/step-up", { code: code(a), action, target }, cookie);
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
    assert.equal((await call("POST", "/api/admin/rollouts", { version: "0.6.0", pilotCabinetId: ids.c1, successRatePercent: 95, failureLimitPercent: 5, stepUpToken: "A".repeat(43) }, tc)).status, 403);

    const r = makeRelease(key, "0.6.0");
    // A token for another action is refused; hostile bodies are refused before anything reads them.
    assert.equal((await call("POST", "/api/admin/releases", { manifest: r.manifest, signature: r.signature, stepUpToken: await stepUp(boss, bc, "rollout.start", "fleet") }, bc)).status, 403);
    assert.equal((await call("POST", "/api/admin/releases", { manifest: r.manifest, signature: { ...r.signature, path: "C:/x" }, stepUpToken: "A".repeat(43) }, bc)).status, 400);
    const added = await call("POST", "/api/admin/releases", { manifest: r.manifest, signature: r.signature, stepUpToken: await stepUp(boss, bc, "release.add", "fleet") }, bc);
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal((await call("PUT", "/api/admin/releases/0.6.0/package", undefined, oc, r.zip)).status, 403, "only the Admin who added it uploads its package");
    assert.equal((await call("PUT", "/api/admin/releases/..%2F..%2Fx/package", undefined, bc, r.zip)).status, 404);
    assert.equal((await call("PUT", "/api/admin/releases/0.6.0/package", { x: 1 }, bc)).status, 415);
    const pkg = await call("PUT", "/api/admin/releases/0.6.0/package", undefined, bc, r.zip);
    assert.equal(pkg.body.state, "ready", JSON.stringify(pkg.body));

    // In office, with a step-up bound to the cabinet.
    assert.equal((await call("PUT", `/api/admin/cabinets/${ids.c1}/in-office`, { inOffice: true, stepUpToken: await stepUp(boss, bc, "cabinet.in_office", randomUUID()) }, bc)).status, 403);
    assert.equal((await call("PUT", `/api/admin/cabinets/${ids.c1}/in-office`, { inOffice: true, stepUpToken: await stepUp(boss, bc, "cabinet.in_office", ids.c1!) }, bc)).status, 200);
    assert.equal((await call("GET", "/api/admin/upgrade-candidates", undefined, bc)).body.find((c: { id: string }) => c.id === ids.c1).inOffice, true);

    // Start, then pause, resume and stop, each with its own token for this rollout.
    assert.equal((await call("POST", "/api/admin/rollouts", { version: "0.6.0", pilotCabinetId: ids.c1, successRatePercent: 10, failureLimitPercent: 5, stepUpToken: "A".repeat(43) }, bc)).status, 400, "no success bar below 50%");
    const started = await call("POST", "/api/admin/rollouts", { version: "0.6.0", pilotCabinetId: ids.c1, successRatePercent: 95, failureLimitPercent: 5,
      stepUpToken: await stepUp(boss, bc, "rollout.start", "fleet") }, bc);
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
    await stream.stop();
  }
});

// ---- The whole channel with the real agent code (agent/tests/Cabinet.Agent.TestAgent) ------------------------------

const dll = process.env.TEST_AGENT_DLL;

async function withAgent(env: Record<string, string>, body: (ctx: { cabinetId: string; lines: string[]; until: (what: string, check: () => boolean | Promise<boolean>, ms?: number) => Promise<void>;
  db: TestDatabase; store: ReleaseStore; admin: string }) => Promise<void>): Promise<void> {
  const db2 = await createTestDatabase();
  const dir = tempDir();
  const issuing = await developmentIssuingKey(dir);
  const notifier = new CommandNotifier(db2.appUrl);
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
    await notifier.stop();
    await db2.drop();
  }
}

test("done-when on the real agent code: a signed upgrade rolls out to a test batch; a tampered package is refused at its hash and pauses the rollout",
  { skip: !dll && "set TEST_AGENT_DLL to run", timeout: 180_000 }, async () => {
  const pki = new TestPki();
  const signer = pki.signer("Mashura Agent Code Signing", "Mashura");
  const trustDir = keysFolder([key], pki, signer);
  await withAgent({ TEST_UPGRADE_TRUST_DIR: trustDir, TEST_AGENT_VERSION: "0.1.0" }, async ({ cabinetId, lines, until, db: d, store: s, admin: a }) => {
    const ok = makeRelease(key, "0.1.1");
    await addRelease(d.app, s.keys, a, ok.manifest, ok.signature, null);
    await receiveReleasePackage(d.app, s, a, "0.1.1", Readable.from([ok.zip]));
    const id = await startRollout(d.app, a, { version: "0.1.1", pilotCabinetId: cabinetId, successRatePercent: 95, failureLimitPercent: 5 }, null);
    await until("the upgrade to succeed", async () => (await rolloutTargets(d.app, id))[0]!.state === "succeeded");
    assert.ok(lines.some(l => l.includes("passed every check")), lines.join("\n"));
    assert.equal((await listRollouts(d.app)).find(r => r.id === id)!.state, "completed", "the test batch was the only batch");
    const downloads = (await d.app.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'release.download'")).rows[0].n;
    assert.equal(downloads, 1);

    // The next release, then someone with access to the server's store swaps its package for one of the same size.
    const next = makeRelease(key, "0.1.2");
    await addRelease(d.app, s.keys, a, next.manifest, next.signature, null);
    await receiveReleasePackage(d.app, s, a, "0.1.2", Readable.from([next.zip]));
    const file = join(s.dir, "agent-0.1.2.zip");
    const tampered = Buffer.from(next.zip); tampered[tampered.length >> 1]! ^= 0xff;
    chmodSync(file, 0o644); writeFileSync(file, tampered);
    const id2 = await startRollout(d.app, a, { version: "0.1.2", pilotCabinetId: cabinetId, successRatePercent: 95, failureLimitPercent: 5 }, null);
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
    const unsigned = makeRelease(key, "0.1.1", agentPackage("MZ|signed:agent-signer", [["Cabinet.Agent.Network/extra.dll", Buffer.from("MZ|unsigned")]]));
    await addRelease(d.app, s.keys, a, unsigned.manifest, unsigned.signature, null);
    await receiveReleasePackage(d.app, s, a, "0.1.1", Readable.from([unsigned.zip]));
    const id = await startRollout(d.app, a, { version: "0.1.1", pilotCabinetId: cabinetId, successRatePercent: 95, failureLimitPercent: 5 }, null);
    await until("the Authenticode refusal", async () => (await rolloutTargets(d.app, id))[0]!.state === "failed");
    assert.deepEqual([(await rolloutTargets(d.app, id))[0]!.outcome, (await rolloutTargets(d.app, id))[0]!.check], ["refused", "authenticode"]);
    await until("the signature alert", async () => (await d.app.query("SELECT 1 FROM security_alerts WHERE kind = 'signature_failure' AND cabinet_id = $1", [cabinetId])).rows.length === 1);
    await changeRollout(d.app, a, id, "stop", null);

    const good = makeRelease(key, "0.1.2");
    await addRelease(d.app, s.keys, a, good.manifest, good.signature, null);
    await receiveReleasePackage(d.app, s, a, "0.1.2", Readable.from([good.zip]));
    const id2 = await startRollout(d.app, a, { version: "0.1.2", pilotCabinetId: cabinetId, successRatePercent: 95, failureLimitPercent: 5 }, null);
    await until("the rolled-back report", async () => (await rolloutTargets(d.app, id2))[0]!.state === "failed");
    const t = (await rolloutTargets(d.app, id2))[0]!;
    assert.deepEqual([t.outcome, t.check], ["rolled_back", "check_in"]);
    assert.match(t.message!, /0\.1\.0 was restored/);
  });
});
