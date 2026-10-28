// Re-applying a replaced cabinet's settings on its replacement (docs/spec/05-server-spec.md "Replacing a cabinet"): the plan from what
// the old cabinet last reported and what the new one reads now, each step issued in the approving Admin's name and verified, a failure
// stopping the steps after it, and every case where nothing may be sent. A small fake agent answers the new cabinet's commands through
// the commands table, as the agent API would record them.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "../src/auth/passwords.js";
import { NULL_BINARY } from "../src/db/db.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import type { IssuingKey } from "../src/pki/x509.js";
import { approveEnrollment, createBootstrapToken, submitEnrollment, type Approval } from "../src/services/enrollment.js";
import { configHash, type Item } from "../src/services/config-canonical.js";
import { ingestAndEvaluate } from "../src/services/config-service.js";
import { planNetwork, reapplyStatus, runReapply, startDueReapplies, type OldAdapter } from "../src/services/replacement-reapply.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

let db: TestDatabase;
let key: IssuingKey;
let adminId: string;
const TIMING = { pollMs: 40, answerMs: 4_000, verifyMs: 4_000 };

test.before(async () => {
  db = await createTestDatabase();
  key = await developmentIssuingKey(tempDir());
  adminId = await user("admin");
});
test.after(async () => { await db.drop(); });

async function user(role: string): Promise<string> {
  const id = randomUUID();
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, $2, $3, $4, $5, 0, 0, $6, 1)`, [id, `${role}.${randomBytes(3).toString("hex")}`, "Reapply " + role, role, await hashPassword(randomBytes(12).toString("hex")), NULL_BINARY]);
  return id;
}
async function pending(): Promise<string> {
  const { token } = await createBootstrapToken(db.app, adminId);
  return submitEnrollment(db.app, { csr: csrFor(ecKey()), bootstrapToken: token, fingerprints: { hostname: "CAB-" + randomBytes(2).toString("hex"), serialNumber: null,
    macAddresses: [], provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 11", agentVersion: "0.3.1" } }, "127.0.0.1");
}
const approve = async (a: Approval, by = adminId) => approveEnrollment(db.app, key, await pending(), a, by);

let minute = 0;
/** The old cabinet's network snapshot, as its agent sent it. */
function snapshot(adapters: Item["values"][]) {
  const items: Item[] = adapters.map((values, i) => ({ key: `adapter:Ethernet ${i}`, values }));
  return [{ observedAt: new Date(Date.UTC(2026, 9, 27, 8, minute++)).toISOString(), category: "network", hash: configHash(items), truncated: false, items }] as never;
}
const OLD_NETWORK = [
  { type: "ethernet", connected: true, dhcp: false, addresses: ["10.30.0.40/24"], gateways: ["10.30.0.1"], dnsServers: ["10.30.0.2", "1.1.1.1"], dnsAutomatic: false, interfaceIndex: 7 },
  { type: "ethernet", connected: true, dhcp: false, addresses: ["172.20.1.0/32"], gateways: [], dnsServers: [], dnsAutomatic: true, interfaceIndex: 9 },
];

// ---- The new cabinet's network, as network.config reads it -----------------------------------------------------------------------------

interface Fake { adapters: any[]; zone: string; profiles: { domain: boolean; private: boolean; public: boolean }; fail?: string }
const adapter = (o: { index: number; name: string; dhcp: boolean; addresses: { address: string; prefixLength: number }[]; gateways: string[]; dns: string[]; automatic: boolean; profile: string }) => ({
  interfaceIndex: o.index, name: o.name, description: "Intel Ethernet", type: "ethernet", connected: true, linkSpeedBps: 1_000_000_000, macAddress: "00-11-22-33-44-55",
  ipv4: { dhcp: o.dhcp, addresses: o.addresses, gateways: o.gateways }, ipv6Addresses: [], dns: { servers: o.dns, automatic: o.automatic }, dnsSuffix: null,
  details: { networkProfile: { name: o.profile, category: "public" } } });
const freshMachine = (): Fake => ({
  zone: "Eastern Standard Time", profiles: { domain: true, private: true, public: true },
  adapters: [
    adapter({ index: 4, name: "Ethernet", dhcp: true, addresses: [{ address: "10.30.0.77", prefixLength: 24 }], gateways: ["10.30.0.1"], dns: ["10.30.0.1"], automatic: true, profile: "Clinic" }),
    adapter({ index: 12, name: "Ethernet 2", dhcp: true, addresses: [{ address: "169.254.10.4", prefixLength: 16 }], gateways: [], dns: [], automatic: true, profile: "Unidentified network" }),
  ] });

/** Answers the cabinet's queued commands from its fake state, and reports a heartbeat after each change. Stops when `stop` is set. */
async function fakeAgent(cabinetId: string, state: Fake) {
  let stop = false;
  // Its first report, before anything is asked of it.
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME(), time_zone_id = $2, firewall_profiles = $3, read_only = 0 WHERE id = $1",
    [cabinetId, state.zone, JSON.stringify(state.profiles)]);
  const loop = (async () => {
    while (!stop) {
      const queued = (await db.app.query<{ id: string; operation: string; params: any }>("SELECT id, operation, params FROM commands WHERE cabinet_id = $1 AND status = 'queued'", [cabinetId])).rows;
      for (const c of queued) {
        let output: unknown = {};
        if (state.fail === c.operation) {
          await db.app.query("UPDATE commands SET status = 'failed', result = $2, result_at = SYSUTCDATETIME() WHERE id = $1",
            [c.id, JSON.stringify({ error: { code: "operation_failed", message: "Windows refused the change" } })]);
          continue;
        }
        if (c.operation === "network.config") output = { adapters: state.adapters, routes: [] };
        const a = state.adapters.find(x => x.interfaceIndex === c.params.interfaceIndex);
        if (c.operation === "network.setIp") a.ipv4 = { dhcp: false, addresses: [{ address: c.params.address, prefixLength: c.params.prefixLength }], gateways: c.params.gateway ? [c.params.gateway] : [] };
        if (c.operation === "network.setDns") a.dns = { servers: c.params.servers, automatic: false };
        if (c.operation === "time.setZone") state.zone = c.params.timeZoneId;
        if (c.operation === "firewall.applyPolicy") state.profiles = c.params.profiles;
        await db.app.query("UPDATE commands SET status = 'succeeded', result = $2, result_at = SYSUTCDATETIME() WHERE id = $1", [c.id, JSON.stringify({ output })]);
      }
      await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME(), time_zone_id = $2, firewall_profiles = $3, read_only = 0 WHERE id = $1",
        [cabinetId, state.zone, JSON.stringify(state.profiles)]);
      await new Promise(r => setTimeout(r, 30));
    }
  })();
  return { state, stop: async () => { stop = true; await loop; } };
}

/** An old cabinet with its network, zone and firewall reported, replaced by a new one. */
async function replaced(client: string, network: Item["values"][] | null = OLD_NETWORK, by = adminId) {
  const old = (await approve({ clientName: client, siteName: "North", cabinetName: "FRONT", role: "standalone", baseline: { use: "capture" } })).cabinetId;
  if (network) await ingestAndEvaluate(db.app, old, snapshot(network), "agent");
  await db.app.query("UPDATE cabinets SET time_zone_id = 'Pacific Standard Time' WHERE id = $1", [old]);
  await db.app.query("UPDATE clients SET firewall_policy = $2 WHERE name = $1", [client, JSON.stringify({ domain: "off", private: "off", public: "off" })]);
  const fresh = (await approve({ clientName: client, siteName: "North", cabinetName: "FRONT", role: "standalone", replacesCabinetId: old, baseline: { use: "capture" } }, by)).cabinetId;
  return { old, fresh };
}
const steps = async (id: string) => (await reapplyStatus(db.app, id))!;

// ---- Planning alone --------------------------------------------------------------------------------------------------------------------

const asOld = (n: typeof OLD_NETWORK): OldAdapter[] => n.map(a => ({ type: a.type, connected: a.connected, dhcp: a.dhcp,
  addresses: a.addresses.map(x => ({ address: x.split("/")[0]!, prefixLength: Number(x.split("/")[1]) })), gateways: a.gateways, dnsServers: a.dnsServers, dnsAutomatic: a.dnsAutomatic }));

test("the plan puts the drawer address, the fixed DNS and the fixed address on the matching adapters, address last", () => {
  const p = planNetwork(asOld(OLD_NETWORK), freshMachine().adapters);
  assert.deepEqual(p.map(s => [s.kind, s.skip]), [["drawer", null], ["dns", null], ["address", null]]);
  assert.deepEqual(p[0]!.params, { interfaceIndex: 12, mode: "static", address: "172.20.1.0", prefixLength: 32 });
  assert.deepEqual(p[1]!.params, { interfaceIndex: 4, mode: "static", servers: ["10.30.0.2", "1.1.1.1"] });
  assert.deepEqual(p[2]!.params, { interfaceIndex: 4, mode: "static", address: "10.30.0.40", prefixLength: 24, gateway: "10.30.0.1" });
});

test("the plan skips, with the reason, what it cannot place safely", () => {
  const dhcp = asOld(OLD_NETWORK.map(a => ({ ...a, dhcp: true, dnsAutomatic: true })));
  assert.deepEqual(planNetwork(dhcp, freshMachine().adapters).slice(1).map(s => s.skip), ["The old cabinet took its DNS servers automatically.", "The old cabinet took its address from DHCP."]);
  // No unidentified network on the new machine: no drawer adapter to aim at.
  const noDrawer = freshMachine().adapters.map(a => ({ ...a, details: { networkProfile: { name: "Clinic", category: "private" } } }));
  assert.match(planNetwork(asOld(OLD_NETWORK), noDrawer)[0]!.skip!, /No single drawer adapter/);
  // Two network adapters with gateways: nothing is guessed.
  const two = [...freshMachine().adapters, { ...freshMachine().adapters[0], interfaceIndex: 5, name: "Ethernet 3" }];
  assert.deepEqual(planNetwork(asOld(OLD_NETWORK), two).slice(1).map(s => s.params), [null, null]);
  // Already as the old cabinet had it.
  const same = freshMachine();
  same.adapters[1].ipv4 = { dhcp: false, addresses: [{ address: "172.20.1.0", prefixLength: 32 }], gateways: [] };
  assert.match(planNetwork(asOld(OLD_NETWORK), same.adapters)[0]!.skip!, /^Already set/);
  // Hostile values in the old snapshot never reach a command: the parameters are checked against the operation's schema.
  const hostile = asOld(OLD_NETWORK);
  hostile[0]!.addresses = [{ address: "10.30.0.40; netsh", prefixLength: 24 }];
  hostile[0]!.dnsServers = ["10.30.0.2\" & calc"];
  assert.deepEqual(planNetwork(hostile, freshMachine().adapters).slice(1).map(s => s.params), [null, null]);
});

// ---- Running ---------------------------------------------------------------------------------------------------------------------------

test("once the new cabinet reports, its old settings are put back in the Admin's name and each is verified", async () => {
  const { old, fresh } = await replaced("Reapply Health");
  assert.equal((await steps(fresh)).state, "waiting");
  assert.equal(await startDueReapplies(db.app, TIMING), 0, "nothing starts before the new cabinet has reported");
  const agent = await fakeAgent(fresh, freshMachine());
  try {
    await runReapply(db.app, fresh, TIMING);
    const s = await steps(fresh);
    assert.equal(s.state, "done", JSON.stringify(s));
    assert.deepEqual(s.steps.map(x => [x.kind, x.state]), [["firewall", "verified"], ["time_zone", "verified"], ["drawer", "verified"], ["dns", "verified"], ["address", "verified"]]);
    assert.deepEqual(agent.state.profiles, { domain: false, private: false, public: false });
    assert.equal(agent.state.zone, "Pacific Standard Time", "no zone applies to the site, so the old cabinet's");
    assert.deepEqual(agent.state.adapters[1].ipv4.addresses, [{ address: "172.20.1.0", prefixLength: 32 }]);
    assert.deepEqual(agent.state.adapters[0].ipv4, { dhcp: false, addresses: [{ address: "10.30.0.40", prefixLength: 24 }], gateways: ["10.30.0.1"] });
  } finally { await agent.stop(); }
  // Issued by the approving Admin, one change against their limit, each audited as the replacement's.
  const writes = (await db.app.query<{ issued_by: string; bulk_id: string | null }>(
    "SELECT issued_by, bulk_id FROM commands WHERE cabinet_id = $1 AND operation IN ('firewall.applyPolicy', 'time.setZone', 'network.setIp', 'network.setDns')", [fresh])).rows;
  assert.equal(writes.length, 5);
  assert.ok(writes.every(w => w.issued_by.toLowerCase() === adminId.toLowerCase() && w.bulk_id?.toLowerCase() === fresh.toLowerCase()));
  const audits = (await db.app.query<{ details: { via?: string; replaces?: string } }>(
    "SELECT details FROM audit_log WHERE action = 'command.write' AND target_id = $1", [fresh.toLowerCase()])).rows;
  assert.equal(audits.length, 5);
  assert.ok(audits.every(a => a.details.via === "replacement" && a.details.replaces?.toLowerCase() === old.toLowerCase()));
  assert.equal((await db.app.query("SELECT 1 FROM audit_log WHERE action = 'replacement.reapply.finish' AND target_id = $1", [fresh.toLowerCase()])).rows.length, 1);
  // Run again: nothing is planned or sent twice.
  await runReapply(db.app, fresh, TIMING);
  assert.equal((await db.app.query("SELECT 1 FROM commands WHERE cabinet_id = $1 AND operation = 'network.setIp'", [fresh])).rows.length, 2);
});

test("a step that fails stops the ones after it, so the address is never changed after a failure", async () => {
  const { fresh } = await replaced("Failing Health");
  const machine = freshMachine();
  machine.fail = "network.setDns";
  const agent = await fakeAgent(fresh, machine);
  try { await runReapply(db.app, fresh, TIMING); } finally { await agent.stop(); }
  const s = await steps(fresh);
  assert.deepEqual(s.steps.map(x => x.state), ["verified", "verified", "verified", "failed", "skipped"]);
  assert.match(s.steps[3]!.detail!, /Windows refused/);
  assert.match(s.detail!, /need a look/);
  assert.equal(machine.adapters[0].ipv4.dhcp, true, "the address was left alone");
});

test("nothing is sent to a read-only cabinet, or in the name of an Admin who can no longer make changes", async () => {
  const ro = await replaced("Readonly Health");
  // Not reported yet: it waits.
  await runReapply(db.app, ro.fresh, TIMING);
  assert.equal((await steps(ro.fresh)).state, "waiting");
  await db.app.query("UPDATE cabinets SET read_only = 1, last_heartbeat_at = SYSUTCDATETIME() WHERE id = $1", [ro.fresh]);
  await runReapply(db.app, ro.fresh, TIMING);
  assert.equal((await steps(ro.fresh)).state, "stopped");
  assert.match((await steps(ro.fresh)).detail!, /read-only/);

  const otherAdmin = await user("admin");
  const gone = await replaced("Gone Health", OLD_NETWORK, otherAdmin);
  await db.app.query("UPDATE users SET status = 'disabled' WHERE id = $1", [otherAdmin]);
  await runReapply(db.app, gone.fresh, TIMING);
  assert.match((await steps(gone.fresh)).detail!, /can no longer make changes/);
  for (const id of [ro.fresh, gone.fresh])
    assert.equal((await db.app.query("SELECT 1 FROM commands WHERE cabinet_id = $1", [id])).rows.length, 0);
});

test("an old cabinet that never reported its network still gets its firewall and zone back", async () => {
  const { fresh } = await replaced("Quiet Health", null);
  const agent = await fakeAgent(fresh, freshMachine());
  try {
    assert.equal(await startDueReapplies(db.app, TIMING) >= 1, true, "a reported cabinet is picked up");
    for (const end = Date.now() + 15_000; (await steps(fresh)).state !== "done" && Date.now() < end; ) await new Promise(r => setTimeout(r, 100));
  } finally { await agent.stop(); }
  const s = await steps(fresh);
  assert.deepEqual(s.steps.map(x => x.state), ["verified", "verified", "skipped", "skipped", "skipped"]);
  assert.equal(s.steps[2]!.detail, "The old cabinet never reported its network settings.");
});
