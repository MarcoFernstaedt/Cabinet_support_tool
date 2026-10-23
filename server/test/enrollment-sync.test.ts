// Approving a cabinet captures what its role needs (docs/spec/09-open-decisions.md "Cabinet role"):
// a site has one live sync cabinet, a satellite needs a sync address to reach, and a sync cabinet is never
// given one. The address is written in the approving transaction, so a refusal or a failure leaves no
// half-applied setting behind (docs/spec/14-network-troubleshooting.md: the site's sync cabinet is what a
// satellite's network checks target).
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "../src/auth/passwords.js";
import { NULL_BINARY } from "../src/db/db.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import type { IssuingKey } from "../src/pki/x509.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment, type Approval } from "../src/services/enrollment.js";
import { Refused } from "../src/services/errors.js";
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

async function approve(requestId: string, approval: Approval): Promise<{ cabinetId: string; serial: string }> {
  return approveEnrollment(db.app, key, requestId, approval, adminId);
}

/** The refusal approveEnrollment threw, checked to be a fixed-code one. */
async function refused(requestId: string, approval: Approval): Promise<Refused> {
  try { await approve(requestId, approval); }
  catch (e) { if (e instanceof Refused) return e; throw e; }
  assert.fail(`the approval was accepted, but should have been refused (${approval.role})`);
}

interface SiteRow { id: string; sync_address: string | null; sync_ports: number[] | null }
const siteOf = async (client: string, site: string): Promise<SiteRow> =>
  (await db.app.query<SiteRow>("SELECT s.id, s.sync_address, s.sync_ports FROM sites s JOIN clients c ON c.id = s.client_id WHERE c.name = $1 AND s.name = $2", [client, site])).rows[0]!;
const cabinetsAt = async (siteId: string, role?: string): Promise<number> =>
  Number((await db.app.query<{ n: number }>("SELECT count(*) AS n FROM cabinets WHERE site_id = $1 AND status <> 'removed'" + (role ? " AND role = $2" : ""),
    role ? [siteId, role] : [siteId])).rows[0]!.n);

test("a second sync cabinet at a site is refused, and the first one stands", async () => {
  const first = await pending();
  await approve(first, { clientName: "Bravo Health", siteName: "North", cabinetName: "SYNC 1", role: "sync" });
  const site = await siteOf("Bravo Health", "North");

  // The refusal is a 409 with a code of its own and a sentence an Admin can act on, which the console shows.
  const e = await refused(await pending(), { clientName: "Bravo Health", siteName: "North", cabinetName: "SYNC 2", role: "sync" });
  assert.equal(e.code, "sync_exists");
  assert.equal(e.status, 409);
  assert.match(String(e.extra?.reason), /already has a sync cabinet/);
  assert.match(String(e.extra?.reason), /satellite or standalone/);

  // Nothing was left behind by the refused approval.
  assert.equal(await cabinetsAt(site.id), 1);
  assert.equal(await cabinetsAt(site.id, "sync"), 1);
});

test("a sync cabinet is not given a sync address: the pair is refused rather than the address being dropped", async () => {
  // The site exists first, so "nothing was written" means the site's own setting, not a rolled-back client and site.
  await approve(await pending(), { clientName: "Delta Health", siteName: "East", cabinetName: "BASE", role: "standalone" });
  const e = await refused(await pending(), { clientName: "Delta Health", siteName: "East", cabinetName: "SYNC 1", role: "sync", sync: { address: "10.20.0.15" } });
  assert.equal(e.code, "sync_not_allowed");
  assert.equal(e.status, 400);
  assert.match(String(e.extra?.reason), /not given a sync address/);
  const site = await siteOf("Delta Health", "East");
  assert.equal(site.sync_address, null);
  assert.equal(await cabinetsAt(site.id), 1, "the refused cabinet was not added");
});

test("a satellite with no sync address is refused; the same approval with one is accepted", async () => {
  await approve(await pending(), { clientName: "Echo Health", siteName: "West", cabinetName: "BASE", role: "standalone" });
  const e = await refused(await pending(), { clientName: "Echo Health", siteName: "West", cabinetName: "SAT 1", role: "satellite" });
  assert.equal(e.code, "satellite_needs_sync");
  assert.equal(e.status, 409);
  // It says exactly what to do, and what a private address looks like.
  assert.match(String(e.extra?.reason), /private IPv4 address/);
  assert.match(String(e.extra?.reason), /approve the site's sync cabinet first/);
  const site = await siteOf("Echo Health", "West");
  assert.equal(await cabinetsAt(site.id), 1, "a refused satellite leaves no cabinet behind");
  assert.equal(site.sync_address, null, "and writes no address");

  const ok = await approve(await pending(), { clientName: "Echo Health", siteName: "West", cabinetName: "SAT 1", role: "satellite",
    sync: { address: "10.20.0.15", ports: [1433, 5000] } });
  assert.ok(ok.cabinetId);
  const after = await siteOf("Echo Health", "West");
  assert.equal(after.sync_address, "10.20.0.15");
  assert.deepEqual(after.sync_ports, [1433, 5000]);
  assert.equal(await cabinetsAt(after.id, "satellite"), 1);
});

test("a satellite may use the address the site already has, and ports stay the site's when none are given", async () => {
  await approve(await pending(), { clientName: "Foxtrot Health", siteName: "Main", cabinetName: "SYNC 1", role: "sync" });
  await approve(await pending(), { clientName: "Foxtrot Health", siteName: "Main", cabinetName: "SAT 1", role: "satellite", sync: { address: "192.168.4.20" } });
  const ok = await approve(await pending(), { clientName: "Foxtrot Health", siteName: "Main", cabinetName: "SAT 2", role: "satellite" });
  assert.ok(ok.cabinetId, "the site already has a sync address, so the second satellite needs no field");
  const site = await siteOf("Foxtrot Health", "Main");
  assert.equal(site.sync_address, "192.168.4.20");
  assert.equal(site.sync_ports, null, "no ports given: the client's apply, else the fleet's");
  assert.equal(await cabinetsAt(site.id, "satellite"), 2);
});

test("a public or malformed sync address is refused and nothing is written", async () => {
  await approve(await pending(), { clientName: "Golf Health", siteName: "North", cabinetName: "BASE", role: "standalone" });
  for (const address of ["203.0.113.10", "8.8.8.8", "10.20.0.300", "10.20.0", "sync.local", ""]) {
    const e = await refused(await pending(), { clientName: "Golf Health", siteName: "North", cabinetName: "SAT 1", role: "satellite", sync: { address } });
    assert.equal(e.code, "invalid_address", `${address} must be refused`);
    assert.equal(e.status, 400);
  }
  // Ports are checked too: a site may carry at most four, whole numbers, once each.
  for (const ports of [[1433, 1433], [0], [65536], [1433, 5000, 6000, 7000, 8000], [1433.5]]) {
    const e = await refused(await pending(), { clientName: "Golf Health", siteName: "North", cabinetName: "SAT 1", role: "satellite", sync: { address: "10.20.0.15", ports } });
    assert.equal(e.code, "invalid_ports", JSON.stringify(ports));
  }
  const site = await siteOf("Golf Health", "North");
  assert.equal(site.sync_address, null);
  assert.equal(site.sync_ports, null);
  assert.equal(await cabinetsAt(site.id), 1, "none of the refused satellites was added");
});

test("the sync address is written with the cabinet, and never without it: a failure after it rolls both back", async () => {
  await approve(await pending(), { clientName: "Hotel Health", siteName: "North", cabinetName: "BASE", role: "standalone" });
  // A request whose stored certificate request cannot be signed: the transaction fails after the sync write.
  const requestId = await pending();
  await asOwner(db, async owner => { await owner.query("UPDATE enrollment_requests SET csr = 'not a certificate request' WHERE id = $1", [requestId]); });
  await assert.rejects(approve(requestId, { clientName: "Hotel Health", siteName: "North", cabinetName: "SAT 1", role: "satellite", sync: { address: "10.20.0.15", ports: [1433] } }));

  const site = await siteOf("Hotel Health", "North");
  assert.equal(site.sync_address, null, "the site's sync address was not left behind by a failed approval");
  assert.equal(site.sync_ports, null);
  assert.equal(await cabinetsAt(site.id), 1, "and neither was the cabinet");
  const request = (await db.app.query<{ status: string }>("SELECT status FROM enrollment_requests WHERE id = $1", [requestId])).rows[0]!;
  assert.equal(request.status, "pending", "the request is still waiting, not half-decided");
});

test("two sync approvals at the same moment leave exactly one sync cabinet", async () => {
  const [a, b] = await Promise.all([pending(), pending()]);
  const approval = (cabinetName: string): Approval => ({ clientName: "India Health", siteName: "North", cabinetName, role: "sync" });
  const settled = await Promise.allSettled([approve(a, approval("SYNC A")), approve(b, approval("SYNC B"))]);
  const won = settled.filter(s => s.status === "fulfilled");
  assert.equal(won.length, 1, "one approval commits");
  const lost = settled.find(s => s.status === "rejected") as PromiseRejectedResult;
  assert.ok(lost.reason instanceof Refused, `the other is refused by a rule, not by a deadlock: ${String(lost.reason)}`);
  assert.equal(lost.reason.code, "sync_exists");

  const site = await siteOf("India Health", "North");
  assert.equal(await cabinetsAt(site.id, "sync"), 1);
  assert.equal(await cabinetsAt(site.id), 1);
});

test("a standalone approval needs nothing extra and writes no sync address", async () => {
  const ok = await approve(await pending(), { clientName: "Juliet Health", siteName: "North", cabinetName: "SA 1", role: "standalone" });
  assert.ok(ok.cabinetId);
  const site = await siteOf("Juliet Health", "North");
  assert.equal(site.sync_address, null);
  assert.equal(await cabinetsAt(site.id, "standalone"), 1);
});
