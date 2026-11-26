// Package rollouts (plan item 2.12, decision-log D162): an approved software-library package goes to a target in batches on the rollout
// engine. Batch 1 is the canary; each cabinet of a batch reached, and in contact, is sent package.install with the package's type and
// hash from the library; the next batch waits for the success rate; a refusal by the cabinet's own checks pauses it. A package rollout
// runs beside an agent rollout, never offers an agent version, and stops sending once the package is retired or writes are paused.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { consoleBodies } from "../src/contracts.js";
import { changeRollout, checkRollouts, listRollouts, offerFor, rolloutTargets, startPackageRollout, type PackageRolloutRequest } from "../src/services/rollouts.js";
import { Refused } from "../src/services/errors.js";
import { addRelease, receiveReleasePackage, ReleaseKeys } from "../src/services/releases.js";
import { startRollout } from "../src/services/rollouts.js";
import { Readable } from "node:stream";
import { tempDir } from "./helpers.js";
import { keysFolder, makeRelease, releaseKey } from "./release-kit.js";
import { createTestDatabase, type TestDatabase } from "./database.js";

let db: TestDatabase;
let admin: string, uploader: string;
const refusedWith = (code: string) => (e: unknown) => { assert.ok(e instanceof Refused, String(e)); assert.equal(e.code, code, e.message); return true; };
const SHA = "ab".repeat(32);

test.before(async () => {
  db = await createTestDatabase();
  [admin, uploader] = [randomUUID(), randomUUID()];
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'pr.admin', 'Package Admin', 'admin'), ($2, 'pr.uploader', 'Uploader', 'admin')", [admin, uploader]);
  // An agent release, for the agent rollout a package rollout runs beside.
  const key = releaseKey(), store = { dir: tempDir(), maxBytes: 1024 * 1024, keys: ReleaseKeys.fromFolder(keysFolder([key])) };
  const r = makeRelease(key, "0.4.0");
  await addRelease(db.app, store.keys, admin, r.manifest, r.signature, r.architecture, null);
  await receiveReleasePackage(db.app, store, admin, r.version, r.architecture, Readable.from([r.zip]));
});
test.after(async () => { await db.drop(); });
test.afterEach(async () => {
  for (const r of await listRollouts(db.app)) if (r.state === "running" || r.state === "paused") await changeRollout(db.app, admin, r.id, "stop", null);
  await db.app.query("DELETE FROM settings WHERE [key] = 'writes.paused'");
});

async function pkg(state = "approved", type = "driver"): Promise<string> {
  const id = randomUUID();
  await db.app.query(`INSERT INTO packages (id, name, version, vendor, type, state, sha256, size_bytes, signer, uploaded_by, approved_by, approved_at)
                      VALUES ($1, $2, '1.0.0', 'Vendor', $3, $4, $5, 1000, 'CN=Vendor', $6, $7, SYSUTCDATETIME())`,
    [id, `Scanner driver ${id.slice(0, 6)}`, type, state, SHA, uploader, admin]);
  return id;
}
/** Two sites of one client, each cabinet online unless named offline; earlier tests' cabinets are removed. */
async function fleet(siteA: number, siteB: number, offline: number[] = []) {
  await db.app.query("UPDATE cabinets SET status = 'removed'");
  const client = randomUUID(), a = randomUUID(), b = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $3, 'A'), ($2, $3, 'B')", [a, b, client]);
  const make = async (site: string, n: number, tag: string) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = randomUUID(); ids.push(id);
      await db.app.query(`INSERT INTO cabinets (id, site_id, name, role, status, agent_version, read_only, last_heartbeat_at)
                          VALUES ($1, $2, $3, 'standalone', 'active', '0.3.1', 0, CASE WHEN $4 = 1 THEN DATEADD(hour, -3, SYSUTCDATETIME()) ELSE SYSUTCDATETIME() END)`,
        [id, site, `${tag}${i}`, tag === "A" && offline.includes(i) ? 1 : 0]);
    }
    return ids;
  };
  return { client, siteA: a, siteB: b, a: await make(a, siteA, "A"), b: await make(b, siteB, "B") };
}
const start = (packageId: string, pilot: string, over: Partial<PackageRolloutRequest> = {}) =>
  startPackageRollout(db.app, admin, { packageId, pilotCabinetId: pilot, successRatePercent: 100, failureLimitPercent: 0, ...over }, null);
const installs = async (rolloutId: string) => (await db.app.query<{ id: string; cabinet_id: string; params: Record<string, unknown>; issued_by: string }>(
  "SELECT id, cabinet_id, params, issued_by FROM commands WHERE operation = 'package.install' AND bulk_id = $1", [rolloutId])).rows;
/** What the cabinet's answer does to its command (storeResult's part, which this test does not need the agent for). */
const answer = (commandId: string, status: "succeeded" | "failed" | "rejected", code?: string) => db.app.query(
  "UPDATE commands SET status = $2, result = $3, result_at = SYSUTCDATETIME() WHERE id = $1",
  [commandId, status, JSON.stringify({ commandId, status, ...(code ? { error: { code, message: `refused: ${code}` } } : {}) })]);
const rollout = async (id: string) => (await listRollouts(db.app)).find(r => r.id === id)!;

test("a site's package rollout sends the canary its install from the library, then the rest of the site once it succeeds, and nothing outside it", async () => {
  const f = await fleet(4, 2, [3]);
  const p = await pkg();
  const id = await start(p, f.a[0]!, { target: { kind: "site", id: f.siteA }, batches: [{ cabinets: 3 }] });
  const first = await installs(id);
  assert.deepEqual(first.map(c => c.cabinet_id.toLowerCase()), [f.a[0]!.toLowerCase()], "only the canary, before anything else");
  assert.deepEqual(first[0]!.params, { packageId: p, packageType: "driver", sha256: SHA }, "the type and hash come from the library");
  assert.equal(first[0]!.issued_by.toLowerCase(), admin, "issued in the starter's name");
  assert.deepEqual((await rollout(id)).package, { id: p, name: `Scanner driver ${p.slice(0, 6)}`, version: "1.0.0" });
  assert.equal((await rollout(id)).kind, "package");

  await answer(first[0]!.id, "succeeded");
  await checkRollouts(db.app);
  assert.equal((await rollout(id)).currentBatch, 2);
  const second = (await installs(id)).map(c => c.cabinet_id.toLowerCase()).sort();
  assert.deepEqual(second, [f.a[0]!, f.a[1]!, f.a[2]!].map(x => x.toLowerCase()).sort(), "batch 2's cabinets in contact; the offline one waits");
  assert.ok((await installs(id)).every(c => !f.b.map(x => x.toLowerCase()).includes(c.cabinet_id.toLowerCase())), "site B is sent nothing");
  for (const b of f.b) assert.equal(await offerFor(db.app, b, "0.3.1"), null, "a package rollout never offers an agent version");
});

test("a refusal by the cabinet's own checks pauses the rollout, recorded as refused with its check", async () => {
  const f = await fleet(3, 0);
  const id = await start(await pkg(), f.a[0]!, { target: { kind: "site", id: f.siteA } });
  const [canary] = await installs(id);
  await answer(canary!.id, "rejected", "signature_invalid");
  await checkRollouts(db.app);
  const r = await rollout(id);
  assert.equal(r.state, "paused");
  assert.match(r.pausedReason!, /batch 1 \(One cabinet\)/);
  const t = (await rolloutTargets(db.app, id)).find(x => x.cabinetId.toLowerCase() === f.a[0]!.toLowerCase())!;
  assert.deepEqual([t.state, t.outcome], ["failed", "refused"]);
  assert.equal((await installs(id)).length, 1, "nothing more was sent");
});

test("one package rollout at a time, beside an agent rollout; only an approved package; the canary inside the target; and not while writes are paused", async () => {
  const f = await fleet(2, 1);
  const p = await pkg();
  const agent = await startRollout(db.app, admin, { version: "0.4.0", architecture: "windows-x64", pilotCabinetId: f.b[0]!, successRatePercent: 100, failureLimitPercent: 0 }, null);
  const first = await start(p, f.a[0]!, { target: { kind: "site", id: f.siteA } });
  assert.deepEqual([(await rollout(agent)).state, (await rollout(first)).state], ["running", "running"], "a package rollout beside an agent rollout");
  await assert.rejects(start(await pkg(), f.b[0]!), refusedWith("rollout_active"));
  await changeRollout(db.app, admin, first, "stop", null);
  await changeRollout(db.app, admin, agent, "stop", null);
  await assert.rejects(start(await pkg("retired"), f.a[0]!), refusedWith("package_not_approved"));
  await assert.rejects(start(await pkg("uploaded"), f.a[0]!), refusedWith("package_not_approved"));
  await assert.rejects(start(randomUUID(), f.a[0]!), refusedWith("package_not_approved"));
  await assert.rejects(start(p, f.b[0]!, { target: { kind: "site", id: f.siteA } }), refusedWith("pilot_outside_target"));
  await db.app.query("INSERT INTO settings ([key], [value], changed_by) VALUES ('writes.paused', '{\"paused\":true,\"reason\":\"test\",\"by\":null,\"at\":null}', $1)", [admin]);
  await assert.rejects(start(p, f.a[0]!), refusedWith("writes_paused"));
  assert.equal((await db.app.query("SELECT 1 FROM rollouts WHERE kind = 'package' AND state IN ('running', 'paused')")).rowCount, 0);
});

test("a package retired during its rollout is sent no further, and the cabinets still waiting are closed with the reason", async () => {
  const f = await fleet(3, 0);
  const p = await pkg();
  const id = await start(p, f.a[0]!, { target: { kind: "site", id: f.siteA } });
  await db.app.query("UPDATE packages SET state = 'retired', retired_by = $2, retired_at = SYSUTCDATETIME() WHERE id = $1", [p, admin]);
  await answer((await installs(id))[0]!.id, "succeeded");
  await checkRollouts(db.app);
  assert.equal((await installs(id)).length, 1, "only the canary's install was ever sent");
  const waiting = (await rolloutTargets(db.app, id)).filter(t => t.cabinetId.toLowerCase() !== f.a[0]!.toLowerCase());
  assert.ok(waiting.length > 0 && waiting.every(t => t.state === "skipped" && /retired/.test(t.message ?? "")), JSON.stringify(waiting));
});

test("the contract takes a package and the rollout's target and batches, and refuses a release, a raw file or a path in their place", () => {
  const body = { packageId: randomUUID(), pilotCabinetId: randomUUID(), successRatePercent: 95, failureLimitPercent: 5, stepUpToken: "A".repeat(43) };
  assert.equal(consoleBodies.packageRolloutStart.is({ ...body, target: { kind: "client", id: randomUUID() }, batches: [{ percent: 10 }] }), true);
  for (const bad of [{ version: "0.4.0" }, { file: "TVqQAAMAAAAE" }, { packageId: "..\\..\\evil.sys" }, { packageId: "'; DROP TABLE packages; --" },
    { target: { kind: "site" } }, { batches: [{ cabinets: 0 }] }, { stepUpToken: undefined }])
    assert.equal(consoleBodies.packageRolloutStart.is({ ...body, ...bad }), false, JSON.stringify(bad));
});
