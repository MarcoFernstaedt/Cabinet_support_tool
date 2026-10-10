// The network diagnosis checks on their own: each finding from its evidence, how sure it is, and "could not check" when
// the evidence is missing. No database.
import test from "node:test";
import assert from "node:assert/strict";
import type { NetworkConfigOutput } from "@mashura/cabinet-contracts/types";
import { networkFindings, type NetworkEvidence, type TestRun } from "../src/diagnose/network-findings.js";

const OFF = { domain: false, private: false, public: false };
const adapter = (over: Partial<NetworkConfigOutput["adapters"][number]> = {}): NetworkConfigOutput["adapters"][number] => ({
  interfaceIndex: 12, name: "Ethernet", description: "Intel(R) Ethernet Connection I219-LM", type: "ethernet", connected: true, linkSpeedBps: 1_000_000_000,
  macAddress: "00-1B-21-3A-4F-5C", ipv4: { dhcp: true, addresses: [{ address: "10.21.4.21", prefixLength: 24 }], gateways: ["10.21.4.1"] },
  ipv6Addresses: [], dns: { automatic: true, servers: ["10.21.4.10", "10.21.4.11"] }, dnsSuffix: null, ...over } as never);
const pass = (key: string, label: string, params: Record<string, unknown> = {}): TestRun =>
  ({ key, label, params, output: { target: "gateway", method: "ping", resolvedTarget: "10.21.4.1", success: true, latencyMs: 1, resolvedAddresses: [], error: null } as never });
const fail = (key: string, label: string, params: Record<string, unknown> = {}, error = "timed out"): TestRun =>
  ({ key, label, params, output: { target: "gateway", method: "ping", resolvedTarget: null, success: false, latencyMs: null, resolvedAddresses: [], error } as never });
const evidence = (over: Partial<NetworkEvidence> = {}): NetworkEvidence => ({
  cabinet: { id: "c1", name: "Surgery", role: "satellite" },
  config: { adapters: [adapter()] },
  firewall: { profiles: (["domain", "private", "public"] as const).map(profile => ({ profile, enabled: false, defaultInbound: "block", defaultOutbound: "allow", reenableAt: null })), rules: [], rulesTruncated: false, snapshots: [] } as never,
  policy: OFF,
  sync: { address: "10.21.4.20", ports: [1433], cabinet: { id: "s1", name: "Pharmacy Sync", online: true, minutesSilent: 0, profiles: OFF } },
  tests: [pass("gateway", "Gateway"), pass("dns-0", "DNS server 1"), pass("dns-1", "DNS server 2"), pass("platform", "Platform"), pass("sync-ping", "Sync ping"), pass("sync-tcp-1433", "Sync port 1433", { port: 1433 })],
  ...over,
});
const ids = (e: NetworkEvidence) => networkFindings(e).map(f => `${f.severity}:${f.id}`);

test("a healthy network: everything ok, nothing else", () => {
  const f = networkFindings(evidence());
  assert.ok(f.every(x => x.severity === "ok"), JSON.stringify(f.filter(x => x.severity !== "ok")));
  assert.ok(f.some(x => x.id === "sync-ok"));
});

test("the sync cabinet's firewall: a closed port with the sync cabinet's firewall on is a probable cause, with the fix on that cabinet", () => {
  const e = evidence({ tests: [pass("gateway", "Gateway"), pass("dns-0", "DNS 1"), pass("sync-ping", "Sync ping"), fail("sync-tcp-1433", "Sync port 1433", { port: 1433 })],
    sync: { address: "10.21.4.20", ports: [1433], cabinet: { id: "s1", name: "Pharmacy Sync", online: true, minutesSilent: 0, profiles: { domain: true, private: true, public: true } } } });
  const f = networkFindings(e)[0]!;
  assert.equal(f.id, "sync-firewall");
  assert.equal(f.certainty, "probable");
  assert.deepEqual(f.action, { kind: "apply_policy", cabinetId: "s1", cabinetName: "Pharmacy Sync" });
  // With the sync cabinet's firewall as the policy asks, a closed port is only a possible cause: the service may be stopped.
  const g = networkFindings({ ...e, sync: { ...e.sync, cabinet: { ...e.sync.cabinet!, profiles: OFF } } })[0]!;
  assert.equal(g.id, "sync-port");
  assert.equal(g.certainty, "possible");
  assert.equal(g.action?.kind, "open");
});

test("the sync cabinet unreachable, and silent on the platform too", () => {
  const e = evidence({ tests: [pass("gateway", "Gateway"), fail("sync-ping", "Sync ping"), fail("sync-tcp-1433", "Sync port 1433", { port: 1433 })],
    sync: { address: "10.21.4.20", ports: [1433], cabinet: { id: "s1", name: "Pharmacy Sync", online: false, minutesSilent: 42, profiles: OFF } } });
  const f = networkFindings(e)[0]!;
  assert.equal(f.id, "sync-down");
  assert.ok(f.evidence.some(x => x.includes("42 minutes")));
});

test("physical layer: no link, a 169.254 address, and a gigabit adapter at 100 Mbps", () => {
  assert.deepEqual(ids(evidence({ config: { adapters: [adapter({ connected: false })] }, tests: [] })).filter(x => x.startsWith("problem")), ["problem:link"]);
  assert.ok(ids(evidence({ config: { adapters: [adapter({ ipv4: { dhcp: true, addresses: [{ address: "169.254.10.3", prefixLength: 16 }], gateways: [] } })] } })).includes("problem:ip-12"));
  assert.ok(ids(evidence({ config: { adapters: [adapter({ linkSpeedBps: 100_000_000 })] } })).includes("warning:speed-12"));
  assert.ok(ids(evidence({ config: { adapters: [adapter({ ipv4: { dhcp: false, addresses: [{ address: "10.21.4.21", prefixLength: 24 }], gateways: [] } })] } })).includes("problem:gateway-none"));
});

test("a gateway that blocks ping is not called down when other traffic gets through; when nothing gets through it is", () => {
  const blocks = networkFindings(evidence({ tests: [fail("gateway", "Gateway"), pass("dns-0", "DNS 1")] })).find(f => f.id === "gateway")!;
  assert.deepEqual([blocks.severity, blocks.certainty], ["info", "possible"]);
  const down = networkFindings(evidence({ tests: [fail("gateway", "Gateway"), fail("dns-0", "DNS 1"), fail("platform", "Platform")] })).find(f => f.id === "gateway")!;
  assert.deepEqual([down.severity, down.certainty], ["problem", "probable"]);
});

test("DNS: one server down is a warning, all down a problem", () => {
  assert.ok(ids(evidence({ tests: [pass("gateway", "G"), pass("dns-0", "DNS server 1"), fail("dns-1", "DNS server 2")] })).includes("warning:dns-dns-1"));
  assert.ok(ids(evidence({ tests: [pass("gateway", "G"), fail("dns-0", "DNS server 1"), fail("dns-1", "DNS server 2")] })).includes("problem:dns-all"));
});

test("this cabinet's firewall against the policy, with the fix on this cabinet", () => {
  const on = evidence();
  (on.firewall!.profiles[2] as { enabled: boolean }).enabled = true;
  const f = networkFindings(on).find(x => x.id === "firewall")!;
  assert.equal(f.severity, "warning");
  assert.deepEqual(f.action, { kind: "apply_policy", cabinetId: "c1", cabinetName: "Surgery" });
});

test("missing evidence is never guessed: could not check", () => {
  const f = networkFindings({ ...evidence(), config: undefined, configFailure: "no answer within a minute", firewall: undefined, firewallFailure: "refused",
    tests: [{ key: "gateway", label: "Gateway", params: {}, failure: "expired" }, { key: "sync-ping", label: "Sync ping", params: {}, failure: "expired" }] } as unknown as NetworkEvidence);
  assert.ok(f.every(x => x.severity === "info" && x.certainty === "not_checked"), JSON.stringify(f));
  assert.ok(f.some(x => x.id === "config") && f.some(x => x.id === "firewall") && f.some(x => x.id === "gateway"));
});

test("the sync cabinet itself, and a site without a sync address", () => {
  assert.ok(ids(evidence({ cabinet: { id: "s1", name: "Pharmacy Sync", role: "sync" }, tests: [pass("gateway", "G")] })).includes("info:sync-self"));
  assert.ok(ids(evidence({ sync: { address: null, ports: [], cabinet: null }, tests: [pass("gateway", "G")] })).includes("info:sync-none"));
});
