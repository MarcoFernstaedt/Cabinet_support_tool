// Sync cabinets and satellites (docs/spec/05-server-spec.md "Sync cabinets and satellites"), against a real SQL Server.
// A site may have several sync cabinets; a satellite reaches the one it is linked to, and its enrollment is incomplete until it has one.
// Each sync cabinet's address comes from its own report unless an Admin set one. Every refusal leaves nothing behind.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "../src/auth/passwords.js";
import { issueStepUpToken } from "../src/auth/stepup.js";
import { NULL_BINARY } from "../src/db/db.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import type { IssuingKey } from "../src/pki/x509.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment, type Approval } from "../src/services/enrollment.js";
import { Refused } from "../src/services/errors.js";
import { configHash, type Item } from "../src/services/config-canonical.js";
import { ingestAndEvaluate } from "../src/services/config-service.js";
import { syncForCabinet } from "../src/services/device-settings.js";
import { cabinet, site as siteView } from "../src/services/fleet.js";
import { setCabinetRole } from "../src/services/admin.js";
import { revokeCabinet } from "../src/services/cabinets.js";
import { cabinetSync, setSyncAddress, setSyncCabinet } from "../src/services/sync-cabinets.js";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

let db: TestDatabase;
let key: IssuingKey;
let adminId: string;

test.before(async () => {
  db = await createTestDatabase();
  key = await developmentIssuingKey(tempDir());
  adminId = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, $2, $3, 'admin', $4, 0, 0, $5, 1)`,
    [adminId, "sync.admin", "Sync Admin", await hashPassword(randomBytes(12).toString("hex")), NULL_BINARY]);
});
test.after(async () => { await db.drop(); });

/** A pending enrollment request, as the installer would leave it. */
async function pending(): Promise<string> {
  const { token } = await createBootstrapToken(db.app, adminId);
  return submitEnrollment(db.app, {
    csr: csrFor(ecKey()), bootstrapToken: token,
    fingerprints: { hostname: "CAB-" + randomBytes(2).toString("hex"), serialNumber: "SN-" + randomBytes(3).toString("hex"), macAddresses: [],
      provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 10", agentVersion: "0.2.0" },
  }, "127.0.0.1");
}

const approve = async (approval: Approval): Promise<string> => (await approveEnrollment(db.app, key, await pending(), approval, adminId)).cabinetId;

/** The refusal an approval threw, checked to be a fixed-code one. */
async function refused(approval: Approval, requestId?: string): Promise<Refused> {
  try { await approveEnrollment(db.app, key, requestId ?? await pending(), approval, adminId); }
  catch (e) { if (e instanceof Refused) return e; throw e; }
  assert.fail(`the approval was accepted, but should have been refused (${approval.role})`);
}

const siteId = async (client: string, site: string): Promise<string> =>
  (await db.app.query<{ id: string }>("SELECT s.id FROM sites s JOIN clients c ON c.id = s.client_id WHERE c.name = $1 AND s.name = $2", [client, site])).rows[0]!.id;
const cabinetsAt = async (site: string): Promise<number> =>
  Number((await db.app.query<{ n: number }>("SELECT count(*) AS n FROM cabinets WHERE site_id = $1 AND status <> 'removed'", [site])).rows[0]!.n);
const linkOf = async (id: string): Promise<string | null> =>
  (await db.app.query<{ s: string | null }>("SELECT sync_cabinet_id AS s FROM cabinets WHERE id = $1", [id])).rows[0]!.s?.toLowerCase() ?? null;
const addressOf = async (id: string) =>
  (await db.app.query<{ address: string | null; source: string | null }>("SELECT sync_address AS address, sync_address_source AS source FROM cabinets WHERE id = $1", [id])).rows[0]!;
const token = (action: string, target: string) => issueStepUpToken(db.app, adminId, action, target);

/** A network snapshot as the agent sends it: one adapter per entry. */
let minute = 0;
function network(...adapters: { connected?: boolean; addresses: string[] }[]) {
  const items: Item[] = adapters.map((a, i) => ({ key: `adapter:Ethernet ${i}`, values: { connected: a.connected ?? true, dhcp: true, addresses: a.addresses } }));
  return [{ observedAt: new Date(Date.UTC(2026, 9, 27, 8, minute++)).toISOString(), category: "network", hash: configHash(items), truncated: false, items }] as never;
}

test("a site may have several sync cabinets", async () => {
  const a = await approve({ clientName: "Alpha", siteName: "North", cabinetName: "SYNC A", role: "sync" });
  const b = await approve({ clientName: "Alpha", siteName: "North", cabinetName: "SYNC B", role: "sync" });
  assert.notEqual(a, b);
  const view = await siteView(db.app, await siteId("Alpha", "North"));
  assert.deepEqual(view!.sync.syncCabinets.map(s => s.name), ["SYNC A", "SYNC B"]);
});

test("a satellite approved before any sync cabinet is incomplete, and the site's first sync cabinet takes it in", async () => {
  const sat = await approve({ clientName: "Bravo", siteName: "North", cabinetName: "SAT 1", role: "satellite" });
  assert.equal(await linkOf(sat), null);
  assert.deepEqual(await cabinetSync(db.app, sat), { role: "satellite", state: "unassigned", syncCabinet: null });
  const row = (await cabinet(db.app, sat))!;
  assert.equal(row.syncUnassigned, true, "the fleet lists show it as incomplete");
  assert.equal((await syncForCabinet(db.app, sat))!.address, null, "and its sync tests have nothing to aim at");

  const sync = await approve({ clientName: "Bravo", siteName: "North", cabinetName: "SYNC 1", role: "sync" });
  assert.equal(await linkOf(sat), sync.toLowerCase());
  const state = await cabinetSync(db.app, sat);
  assert.equal(state?.role === "satellite" && state.state, "address_needed", "linked, but the sync cabinet has not reported an address yet");
  assert.equal((await cabinet(db.app, sat))!.syncUnassigned, false);
  // The sync cabinet names its satellites, for the warning in a change's confirmation (module 37).
  const own = await cabinetSync(db.app, sync);
  assert.deepEqual(own?.role === "sync" && [own.satellites, own.satelliteNames], [1, ["SAT 1"]]);
});

test("a satellite at a site with one sync cabinet is linked to it without being asked", async () => {
  const sync = await approve({ clientName: "Charlie", siteName: "North", cabinetName: "SYNC 1", role: "sync" });
  const sat = await approve({ clientName: "Charlie", siteName: "North", cabinetName: "SAT 1", role: "satellite" });
  assert.equal(await linkOf(sat), sync.toLowerCase());
});

test("at a site with several sync cabinets the approver chooses; leaving it out is refused and adds nothing", async () => {
  const a = await approve({ clientName: "Delta", siteName: "North", cabinetName: "SYNC A", role: "sync" });
  const b = await approve({ clientName: "Delta", siteName: "North", cabinetName: "SYNC B", role: "sync" });
  const site = await siteId("Delta", "North");
  const e = await refused({ clientName: "Delta", siteName: "North", cabinetName: "SAT 1", role: "satellite" });
  assert.equal(e.code, "choose_sync_cabinet");
  assert.equal(e.status, 409);
  assert.match(String(e.extra?.reason), /Choose the one this satellite reaches/);
  assert.equal(await cabinetsAt(site), 2);

  const sat = await approve({ clientName: "Delta", siteName: "North", cabinetName: "SAT 1", role: "satellite", syncCabinetId: b });
  assert.equal(await linkOf(sat), b.toLowerCase());
  assert.notEqual(await linkOf(sat), a.toLowerCase());
});

test("a sync cabinet that is not an active sync cabinet at the same site is refused, and nothing is written", async () => {
  const elsewhere = await approve({ clientName: "Echo", siteName: "South", cabinetName: "SYNC S", role: "sync" });
  const standalone = await approve({ clientName: "Echo", siteName: "North", cabinetName: "BASE", role: "standalone" });
  const removed = await approve({ clientName: "Echo", siteName: "North", cabinetName: "OLD SYNC", role: "sync" });
  await revokeCabinet(db.app, removed, adminId);
  const site = await siteId("Echo", "North");
  for (const syncCabinetId of [elsewhere, standalone, removed, randomUUID()]) {
    const e = await refused({ clientName: "Echo", siteName: "North", cabinetName: "SAT 1", role: "satellite", syncCabinetId });
    assert.equal(e.code, "invalid_sync_cabinet", syncCabinetId);
    assert.equal(e.status, 409);
  }
  assert.equal(await cabinetsAt(site), 1, "none of the refused satellites was added");
});

test("only a satellite names a sync cabinet: the pair is refused rather than the choice being dropped", async () => {
  const sync = await approve({ clientName: "Foxtrot", siteName: "North", cabinetName: "SYNC 1", role: "sync" });
  for (const role of ["sync", "standalone"] as const) {
    const e = await refused({ clientName: "Foxtrot", siteName: "North", cabinetName: "X", role, syncCabinetId: sync });
    assert.equal(e.code, "sync_not_allowed");
    assert.equal(e.status, 400);
  }
  assert.equal(await cabinetsAt(await siteId("Foxtrot", "North")), 1);
});

test("a failure late in the approval rolls back the cabinet and every link it made", async () => {
  const sat = await approve({ clientName: "Golf", siteName: "North", cabinetName: "SAT 1", role: "satellite" });
  const requestId = await pending();
  // A stored certificate request that cannot be signed: the transaction fails after the sync cabinet is inserted and linked.
  await asOwner(db, async owner => { await owner.query("UPDATE enrollment_requests SET csr = 'not a certificate request' WHERE id = $1", [requestId]); });
  await assert.rejects(approveEnrollment(db.app, key, requestId, { clientName: "Golf", siteName: "North", cabinetName: "SYNC 1", role: "sync" }, adminId));
  assert.equal(await linkOf(sat), null, "the waiting satellite was not linked to a cabinet that does not exist");
  assert.equal(await cabinetsAt(await siteId("Golf", "North")), 1);
  const request = (await db.app.query<{ status: string }>("SELECT status FROM enrollment_requests WHERE id = $1", [requestId])).rows[0]!;
  assert.equal(request.status, "pending");
});

test("two sync cabinets approved at the same moment both stand, and a waiting satellite is linked to exactly one", async () => {
  const sat = await approve({ clientName: "Hotel", siteName: "North", cabinetName: "SAT 1", role: "satellite" });
  const [r1, r2] = await Promise.all([pending(), pending()]);
  const settled = await Promise.allSettled([
    approveEnrollment(db.app, key, r1, { clientName: "Hotel", siteName: "North", cabinetName: "SYNC A", role: "sync" }, adminId),
    approveEnrollment(db.app, key, r2, { clientName: "Hotel", siteName: "North", cabinetName: "SYNC B", role: "sync" }, adminId)]);
  assert.deepEqual(settled.map(s => s.status), ["fulfilled", "fulfilled"], String(settled.map(s => s.status === "rejected" ? s.reason : "").join(" ")));
  const ids = settled.map(s => (s as PromiseFulfilledResult<{ cabinetId: string }>).value.cabinetId.toLowerCase());
  const link = await linkOf(sat);
  assert.ok(link !== null && ids.includes(link), "linked to one of the two");
});

test("a sync cabinet's address follows what it reports, keeps the last one when a report is ambiguous, and an Admin's address stands", async () => {
  const sync = await approve({ clientName: "India", siteName: "North", cabinetName: "SYNC 1", role: "sync" });
  const sat = await approve({ clientName: "India", siteName: "North", cabinetName: "SAT 1", role: "satellite" });
  assert.deepEqual(await addressOf(sync), { address: null, source: null });

  // The one private address on a connected adapter; the disconnected and the self-assigned ones do not count.
  await ingestAndEvaluate(db.app, sync, network({ addresses: ["10.20.0.15/24"] }, { connected: false, addresses: ["192.168.9.9/24"] }, { addresses: ["169.254.3.4/16"] }), "agent");
  assert.deepEqual(await addressOf(sync), { address: "10.20.0.15", source: "reported" });
  assert.equal((await syncForCabinet(db.app, sat))!.address, "10.20.0.15", "the satellite's tests aim at it");

  // A new DHCP address is followed.
  await ingestAndEvaluate(db.app, sync, network({ addresses: ["10.20.0.16/24"] }), "agent");
  assert.equal((await addressOf(sync)).address, "10.20.0.16");

  // Two private addresses, or none: the platform does not guess, and keeps the last one.
  await ingestAndEvaluate(db.app, sync, network({ addresses: ["10.20.0.17/24", "192.168.1.5/24"] }), "agent");
  assert.equal((await addressOf(sync)).address, "10.20.0.16");
  await ingestAndEvaluate(db.app, sync, network({ connected: false, addresses: ["10.20.0.18/24"] }), "agent");
  assert.equal((await addressOf(sync)).address, "10.20.0.16");

  // An Admin's address is never replaced by a report.
  await setSyncAddress(db.app, adminId, sync, "10.20.0.50", await token("cabinet.sync_address", sync));
  await ingestAndEvaluate(db.app, sync, network({ addresses: ["10.20.0.19/24"] }), "agent");
  assert.deepEqual(await addressOf(sync), { address: "10.20.0.50", source: "admin" });

  // Going back to the report takes what was reported last, at once.
  await setSyncAddress(db.app, adminId, sync, null, await token("cabinet.sync_address", sync));
  assert.deepEqual(await addressOf(sync), { address: "10.20.0.19", source: "reported" });

  // Every change is in the audit log: the system's for a report, the Admin's for a setting.
  const audited = (await db.app.query<{ actor_kind: string }>(
    "SELECT actor_kind FROM audit_log WHERE action = 'cabinet.sync_address' AND target_id = $1 ORDER BY seq", [sync])).rows.map(r => r.actor_kind);
  assert.deepEqual(audited, ["system", "system", "user", "user"]);
});

test("a satellite or standalone cabinet never takes a sync address from its report", async () => {
  const sat = await approve({ clientName: "Juliet", siteName: "North", cabinetName: "SAT 1", role: "satellite" });
  const solo = await approve({ clientName: "Juliet", siteName: "North", cabinetName: "SOLO", role: "standalone" });
  for (const id of [sat, solo]) {
    await ingestAndEvaluate(db.app, id, network({ addresses: ["10.30.0.5/24"] }), "agent");
    assert.deepEqual(await addressOf(id), { address: null, source: null });
  }
});

test("an Admin's sync address must be private, and only a sync cabinet has one", async () => {
  const sync = await approve({ clientName: "Kilo", siteName: "North", cabinetName: "SYNC 1", role: "sync" });
  const sat = await approve({ clientName: "Kilo", siteName: "North", cabinetName: "SAT 1", role: "satellite" });
  for (const address of ["203.0.113.10", "8.8.8.8", "10.20.0.300", "sync.local", ""]) {
    await assert.rejects(setSyncAddress(db.app, adminId, sync, address, await token("cabinet.sync_address", sync)), (e: Refused) => e.code === "invalid_address", address);
  }
  await assert.rejects(setSyncAddress(db.app, adminId, sat, "10.20.0.5", await token("cabinet.sync_address", sat)), (e: Refused) => e.code === "not_a_sync_cabinet");
  // A token for another cabinet, or none at all, is refused before anything is read.
  await assert.rejects(setSyncAddress(db.app, adminId, sync, "10.20.0.5", await token("cabinet.sync_address", sat)), (e: Refused) => e.code === "step_up_required");
  await assert.rejects(setSyncAddress(db.app, adminId, sync, "10.20.0.5", "not-a-token"), (e: Refused) => e.code === "step_up_required");
  assert.deepEqual(await addressOf(sync), { address: null, source: null });
});

test("an Admin assigns a satellite to a sync cabinet at its own site, or unassigns it", async () => {
  const a = await approve({ clientName: "Lima", siteName: "North", cabinetName: "SYNC A", role: "sync" });
  const b = await approve({ clientName: "Lima", siteName: "North", cabinetName: "SYNC B", role: "sync" });
  const other = await approve({ clientName: "Lima", siteName: "South", cabinetName: "SYNC S", role: "sync" });
  const sat = await approve({ clientName: "Lima", siteName: "North", cabinetName: "SAT 1", role: "satellite", syncCabinetId: a });
  const solo = await approve({ clientName: "Lima", siteName: "North", cabinetName: "SOLO", role: "standalone" });

  await setSyncCabinet(db.app, adminId, sat, b, await token("cabinet.sync_cabinet", sat));
  assert.equal(await linkOf(sat), b.toLowerCase());
  for (const target of [other, solo, sat, randomUUID()])
    await assert.rejects(setSyncCabinet(db.app, adminId, sat, target, await token("cabinet.sync_cabinet", sat)), (e: Refused) => e.code === "invalid_sync_cabinet", target);
  assert.equal(await linkOf(sat), b.toLowerCase(), "a refused change leaves the link as it was");
  await assert.rejects(setSyncCabinet(db.app, adminId, solo, a, await token("cabinet.sync_cabinet", solo)), (e: Refused) => e.code === "not_a_satellite");
  await assert.rejects(setSyncCabinet(db.app, adminId, sat, a, await token("cabinet.sync_cabinet", solo)), (e: Refused) => e.code === "step_up_required");

  await setSyncCabinet(db.app, adminId, sat, null, await token("cabinet.sync_cabinet", sat));
  assert.equal((await cabinet(db.app, sat))!.syncUnassigned, true);
});

test("removing or demoting a sync cabinet hands its satellites to the site's only remaining one, or leaves them incomplete", async () => {
  const a = await approve({ clientName: "Mike", siteName: "North", cabinetName: "SYNC A", role: "sync" });
  const b = await approve({ clientName: "Mike", siteName: "North", cabinetName: "SYNC B", role: "sync" });
  const sat = await approve({ clientName: "Mike", siteName: "North", cabinetName: "SAT 1", role: "satellite", syncCabinetId: a });

  await revokeCabinet(db.app, a, adminId);
  assert.equal(await linkOf(sat), b.toLowerCase(), "B is now the only sync cabinet, so it takes SAT 1");

  await setCabinetRole(db.app, adminId, b, "standalone", await token("cabinet.role", b));
  assert.equal((await cabinet(db.app, sat))!.syncUnassigned, true, "no sync cabinet left: incomplete");
  assert.deepEqual(await addressOf(b), { address: null, source: null }, "a standalone cabinet keeps no sync address");

  // Promoting a cabinet starts from the address it last reported, and takes in the waiting satellite.
  await ingestAndEvaluate(db.app, b, network({ addresses: ["192.168.7.20/24"] }), "agent");
  await setCabinetRole(db.app, adminId, b, "sync", await token("cabinet.role", b));
  assert.deepEqual(await addressOf(b), { address: "192.168.7.20", source: "reported" });
  assert.equal(await linkOf(sat), b.toLowerCase());

  // A satellite that becomes standalone drops its link.
  await setCabinetRole(db.app, adminId, sat, "standalone", await token("cabinet.role", sat));
  assert.equal(await linkOf(sat), null);
});

test("a link to a cabinet that is no longer an active sync cabinet at the same site does not count", async () => {
  const sync = await approve({ clientName: "November", siteName: "North", cabinetName: "SYNC 1", role: "sync" });
  const sat = await approve({ clientName: "November", siteName: "North", cabinetName: "SAT 1", role: "satellite" });
  await ingestAndEvaluate(db.app, sync, network({ addresses: ["10.40.0.20/24"] }), "agent");
  assert.equal((await syncForCabinet(db.app, sat))!.address, "10.40.0.20");
  // Moved to another site behind the platform's back: the stale link is ignored, not followed.
  const south = randomUUID();
  await db.app.query("INSERT INTO sites (id, client_id, name) SELECT $1, client_id, 'South' FROM sites WHERE id = $2", [south, await siteId("November", "North")]);
  await db.app.query("UPDATE cabinets SET site_id = $2 WHERE id = $1", [sync, south]);
  assert.equal((await syncForCabinet(db.app, sat))!.address, null);
  assert.equal((await cabinet(db.app, sat))!.syncUnassigned, true);
});
