// Rollouts with a target, a canary and batches (plan item 2.11, decision-log D161): a rollout can be for a client, a site or chosen
// cabinets, and is never offered outside them; batch 1 is the canary, and the next batch is not offered before it reaches the rate; the
// batches after it are the sizes and shares the person set, with whatever is left as one more; a rollout of one cabinet completes on
// that cabinet alone. A rollout started without a target or batches is the four fixed batches, as before (upgrades.test.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { consoleBodies } from "../src/contracts.js";
import { addRelease, receiveReleasePackage, ReleaseKeys, type ReleaseStore } from "../src/services/releases.js";
import { changeRollout, listRollouts, offerFor, recordUpgradeStatus, rolloutTargets, startRollout, type RolloutRequest } from "../src/services/rollouts.js";
import { Refused } from "../src/services/errors.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";
import { keysFolder, makeRelease, releaseKey } from "./release-kit.js";

let db: TestDatabase;
let store: ReleaseStore;
let admin: string;
const key = releaseKey();
const X64 = "windows-x64";
const refusedWith = (code: string) => (e: unknown) => { assert.ok(e instanceof Refused, String(e)); assert.equal(e.code, code, e.message); return true; };

test.before(async () => {
  db = await createTestDatabase();
  store = { dir: tempDir(), maxBytes: 1024 * 1024, keys: ReleaseKeys.fromFolder(keysFolder([key])) };
  admin = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'rs.admin', 'Rollout Admin', 'admin')", [admin]);
  for (const v of ["0.5.0", "0.6.0", "0.7.0", "0.8.0", "0.9.0"]) {
    const r = makeRelease(key, v);
    await addRelease(db.app, store.keys, admin, r.manifest, r.signature, r.architecture, null);
    await receiveReleasePackage(db.app, store, admin, r.version, r.architecture, Readable.from([r.zip]));
  }
});
test.after(async () => { await db.drop(); });
// One rollout runs at a time, so a test that fails part way never leaves its rollout to refuse the next one's.
test.afterEach(async () => { for (const r of await listRollouts(db.app)) if (r.state === "running" || r.state === "paused") await changeRollout(db.app, admin, r.id, "stop", null); });

/** A fresh fleet: each client's sites and their cabinet counts, every cabinet on agent 0.1.0. Earlier tests' cabinets are removed. */
async function fleet(clients: number[][]): Promise<{ clients: string[]; sites: string[][]; cabinets: string[][][] }> {
  await db.app.query("UPDATE cabinets SET status = 'removed'");
  const out = { clients: [] as string[], sites: [] as string[][], cabinets: [] as string[][][] };
  for (const [ci, sites] of clients.entries()) {
    const client = randomUUID(); out.clients.push(client); out.sites.push([]); out.cabinets.push([]);
    await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `Client ${ci} ${client.slice(0, 6)}`]);
    for (const [si, n] of sites.entries()) {
      const site = randomUUID(); out.sites[ci]!.push(site); out.cabinets[ci]!.push([]);
      await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [site, client, `Site ${si}`]);
      for (let k = 0; k < n; k++) {
        const id = randomUUID(); out.cabinets[ci]![si]!.push(id);
        await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, agent_version, last_heartbeat_at)
                            VALUES ($1, $2, $3, 'standalone', 'active', '0.1.0', SYSUTCDATETIME())`, [id, site, `K${ci}-${si}-${k}`]);
      }
    }
  }
  return out;
}
const start = (version: string, pilot: string, over: Partial<RolloutRequest> = {}) =>
  startRollout(db.app, admin, { version, architecture: X64, pilotCabinetId: pilot, successRatePercent: 100, failureLimitPercent: 0, ...over }, null);
const succeed = async (cabinet: string, version: string) => { await offerFor(db.app, cabinet, "0.1.0"); await recordUpgradeStatus(db.app, cabinet, { version, fromVersion: "0.1.0", outcome: "succeeded", message: "ok" }); };
const rollout = async (id: string) => (await listRollouts(db.app)).find(r => r.id === id)!;
const stop = (id: string) => changeRollout(db.app, admin, id, "stop", null);

test("a rollout for one site is never offered outside it, and its next batch waits for the canary", async () => {
  const f = await fleet([[3, 2]]);
  const [siteA, siteB] = f.sites[0]!;
  const [canary, a1, a2] = f.cabinets[0]![0]!;
  const id = await start("0.5.0", canary!, { target: { kind: "site", id: siteA! } });
  const targets = await rolloutTargets(db.app, id);
  assert.deepEqual(targets.map(t => t.cabinetId).sort(), [canary!, a1!, a2!].sort(), "only site A's cabinets");
  for (const b of f.cabinets[0]![1]!) assert.equal(await offerFor(db.app, b, "0.1.0"), null, "site B is never offered it");
  assert.equal(await offerFor(db.app, a1!, "0.1.0"), null, "not before the canary has succeeded");
  assert.equal(await offerFor(db.app, canary!, "0.1.0"), "0.5.0");
  await recordUpgradeStatus(db.app, canary!, { version: "0.5.0", fromVersion: "0.1.0", outcome: "succeeded", message: "ok" });
  const now = (await rollout(id)).currentBatch;
  assert.notEqual(now, 1);
  // Without batches the rest is split at random between the 5% batch and everyone else: whichever is in the batch reached is offered.
  const next = (await rolloutTargets(db.app, id)).filter(t => t.batch === now).map(t => t.cabinetId);
  assert.ok(next.length > 0 && next.every(k => [a1!, a2!].includes(k)));
  for (const k of next) assert.equal(await offerFor(db.app, k, "0.1.0"), "0.5.0", "now the rest of the site");
  assert.deepEqual((await rollout(id)).target, { kind: "site", id: siteA });
  void siteB;
  await stop(id);
});

test("a client's rollout takes the batches as set, whatever is left as the last, and names each batch", async () => {
  const f = await fleet([[6, 4], [3]]);
  const ours = f.cabinets[0]!.flat();
  const canary = ours[0]!;
  const id = await start("0.6.0", canary, { target: { kind: "client", id: f.clients[0]! }, batches: [{ cabinets: 2 }, { percent: 50 }] });
  const targets = await rolloutTargets(db.app, id);
  assert.ok(targets.every(t => ours.includes(t.cabinetId)), "the other client's cabinets are not in it");
  const sizes = [1, 2, 3, 4, 5].map(b => targets.filter(t => t.batch === b).length);
  assert.deepEqual(sizes, [1, 2, 5, 2, 0], "the canary, 2 cabinets, 50% of the 9 left rounded up, then the remaining 2");
  assert.deepEqual((await rollout(id)).batches.map(b => [b.batch, b.label]),
    [[1, "One cabinet"], [2, "2 cabinets"], [3, "50% of the rest"], [4, "Everyone else"]]);
  await stop(id);
});

test("a rollout of one cabinet is one batch and completes on that cabinet alone", async () => {
  const f = await fleet([[3]]);
  const [only, other] = f.cabinets[0]![0]!;
  const id = await start("0.7.0", only!, { target: { kind: "cabinets", cabinetIds: [only!] } });
  assert.deepEqual((await rolloutTargets(db.app, id)).map(t => t.cabinetId), [only]);
  assert.equal(await offerFor(db.app, other!, "0.1.0"), null);
  await succeed(only!, "0.7.0");
  const r = await rollout(id);
  assert.equal(r.state, "completed");
  assert.deepEqual(r.batches.map(b => [b.batch, b.label, b.total, b.succeeded]), [[1, "One cabinet", 1, 1]]);
});

test("a failure pauses the rollout with the batch's own name", async () => {
  const f = await fleet([[4]]);
  const [canary, ...rest] = f.cabinets[0]![0]!;
  const id = await start("0.8.0", canary!, { target: { kind: "site", id: f.sites[0]![0]! }, batches: [{ cabinets: 3 }] });
  await succeed(canary!, "0.8.0");
  await offerFor(db.app, rest[0]!, "0.1.0");
  await recordUpgradeStatus(db.app, rest[0]!, { version: "0.8.0", fromVersion: "0.1.0", outcome: "failed", message: "no" });
  const r = await rollout(id);
  assert.equal(r.state, "paused");
  assert.match(r.pausedReason!, /in batch 2 \(3 cabinets\) failed/);
  await stop(id);
});

test("what a rollout is refused for: a canary outside its target, a client, site or cabinet that does not exist, and a hostile body", async () => {
  const f = await fleet([[2, 1]]);
  const [inA] = f.cabinets[0]![0]!; const [inB] = f.cabinets[0]![1]!;
  await assert.rejects(start("0.9.0", inB!, { target: { kind: "site", id: f.sites[0]![0]! } }), refusedWith("pilot_outside_target"));
  await assert.rejects(start("0.9.0", inA!, { target: { kind: "cabinets", cabinetIds: [inB!] } }), refusedWith("pilot_outside_target"));
  await assert.rejects(start("0.9.0", inA!, { target: { kind: "site", id: randomUUID() } }), refusedWith("not_found"));
  await assert.rejects(start("0.9.0", inA!, { target: { kind: "client", id: randomUUID() } }), refusedWith("not_found"));
  await assert.rejects(start("0.9.0", inA!, { target: { kind: "cabinets", cabinetIds: [inA!, randomUUID()] } }), refusedWith("target_not_found"));
  await assert.rejects(start("0.9.0", inA!, { batches: Array.from({ length: 9 }, () => ({ cabinets: 1 })) }), refusedWith("invalid_request"));
  assert.equal((await db.app.query("SELECT 1 FROM rollouts WHERE state IN ('running', 'paused')")).rowCount, 0, "nothing was started by any of them");

  const body = { version: "0.9.0", architecture: X64, pilotCabinetId: inA!, successRatePercent: 95, failureLimitPercent: 5, stepUpToken: "A".repeat(43) };
  assert.equal(consoleBodies.rolloutStart.is({ ...body, target: { kind: "site", id: f.sites[0]![0]! }, batches: [{ percent: 25 }] }), true);
  for (const bad of [
    { target: { kind: "region", id: f.sites[0]![0]! } }, { target: { kind: "site" } }, { target: { kind: "fleet", id: f.sites[0]![0]! } },
    { target: { kind: "cabinets", cabinetIds: [] } }, { target: { kind: "cabinets", cabinetIds: [inA, inA] } },
    { target: { kind: "site", id: "'; DROP TABLE rollouts; --" } }, { batches: [{ percent: 0 }] }, { batches: [{ cabinets: 2, percent: 5 }] },
    { batches: [{ cabinets: "5; DROP TABLE rollouts" }] }, { batches: [] },
  ]) assert.equal(consoleBodies.rolloutStart.is({ ...body, ...bad }), false, JSON.stringify(bad));
});
