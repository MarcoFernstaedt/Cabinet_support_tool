// The network diagnosis checks on their own: each finding from its evidence, how sure it is, and "could not check" when
// the evidence is missing. No database.
import test from "node:test";
import assert from "node:assert/strict";
import type { NetworkConfigOutput } from "@mashura/cabinet-contracts/types";
import { layerStates, networkFindings, sameSubnet, type NetworkEvidence, type TestRun } from "../src/diagnose/network-findings.js";

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

const series = (key: string, label: string, method: "ping" | "tcp", sent: number, received: number, params: Record<string, unknown> = {}): TestRun =>
  ({ key, label, params: { method, ...params }, output: { target: "sync_cabinet", method, resolvedTarget: "10.21.4.20", success: received > 0, latencyMs: received ? 40 : null, resolvedAddresses: [], error: received ? null : "No answer",
    statistics: { sent, received, lossPercent: Math.round(1000 * (sent - received) / sent) / 10, minMs: received ? 3 : null, avgMs: received ? 40 : null, maxMs: received ? 840 : null, jitterMs: received ? 210 : null } } as never });

test("a weak link to the sync cabinet is its own finding: some attempts get through and some do not", () => {
  const base = [pass("gateway", "Gateway"), pass("dns-0", "DNS 1"), pass("platform", "Platform")];
  // Three of five connections made: reachable, but not a link a sync can rely on.
  const weak = evidence({ tests: [...base, series("sync-ping", "Sync ping", "ping", 10, 9), series("sync-tcp-1433", "Sync port 1433", "tcp", 5, 3, { port: 1433 })] });
  const f = networkFindings(weak);
  const flaky = f.find(x => x.id === "sync-flaky")!;
  assert.ok(flaky, JSON.stringify(f.map(x => x.id)));
  assert.equal(flaky.severity, "warning");
  assert.ok(flaky.evidence.some(x => x.includes("3 of 5 connected (40% lost)")));
  assert.ok(!f.some(x => x.id === "sync-ok" || x.id === "sync-down"), "neither healthy nor down");
  // Mostly lost is a problem, and nothing at all is the existing "down" finding.
  assert.equal(networkFindings(evidence({ tests: [...base, series("sync-ping", "Sync ping", "ping", 10, 3), pass("sync-tcp-1433", "Sync port 1433", { port: 1433 })] })).find(x => x.id === "sync-flaky")!.severity, "problem");
  assert.equal(networkFindings(evidence({ tests: [...base, series("sync-ping", "Sync ping", "ping", 10, 0), series("sync-tcp-1433", "Sync port 1433", "tcp", 5, 0, { port: 1433 })] }))[0]!.id, "sync-down");
  // A little ping loss alone is tolerated; a clean series is healthy.
  assert.ok(!networkFindings(evidence({ tests: [...base, series("sync-ping", "Sync ping", "ping", 20, 19), series("sync-tcp-1433", "Sync port 1433", "tcp", 5, 5, { port: 1433 })] })).some(x => x.id === "sync-flaky"));
  // On Wi-Fi the signal strength is in the evidence, and weak signal is called out.
  const wifi = adapter({ type: "wifi", details: { dhcpServer: null, leaseObtained: null, leaseExpires: null, mtu: 1500, statistics: null, wifi: { ssid: "ClinicGuest", signalDbm: -74 } } } as never);
  const onWifi = networkFindings({ ...weak, config: { adapters: [wifi] } }).find(x => x.id === "sync-flaky")!;
  assert.ok(onWifi.evidence.some(x => x.includes("ClinicGuest") && x.includes("-74 dBm") && x.includes("weak")));
  assert.match(onWifi.fix ?? "", /access point|cable/);
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

// ---- Against the site's baseline -----------------------------------------------------------------------------------------

const BASE = { addressing: "dhcp" as const, prefixLength: 24, gateway: "10.21.4.1", dnsServers: ["10.21.4.10", "10.21.4.11"] };
const withAdapter = (over: Partial<NetworkConfigOutput["adapters"][number]>, e: Partial<NetworkEvidence> = {}) =>
  evidence({ baseline: BASE, config: { adapters: [adapter(over)] }, ...e });
const find = (e: NetworkEvidence, id: string) => networkFindings(e).find(f => f.id === id);

test("baseline: a cabinet that matches its site says so, and nothing is flagged", () => {
  const f = networkFindings(withAdapter({}));
  assert.ok(f.some(x => x.id === "baseline-ok-12"));
  assert.ok(f.every(x => x.severity === "ok"));
});

test("baseline: no baseline set means no baseline findings (nothing is guessed)", () => {
  assert.ok(!networkFindings(evidence()).some(f => f.id.startsWith("baseline-")));
});

test("baseline: a fixed address from another network at a DHCP site is a confirmed problem, fixed by switching to DHCP; the failed tests that follow point back at it", () => {
  const e = withAdapter({ ipv4: { dhcp: false, addresses: [{ address: "192.168.1.57", prefixLength: 24 }], gateways: ["192.168.1.1"] }, dns: { automatic: false, servers: ["192.168.1.1"] } },
    { tests: [fail("gateway", "Gateway"), fail("dns-0", "DNS server 1"), fail("platform", "Platform"), fail("sync-ping", "Sync ping"), fail("sync-tcp-1433", "Sync port", { port: 1433 })] });
  const subnet = find(e, "baseline-subnet-12")!;
  assert.equal(subnet.severity, "problem");
  assert.equal(subnet.certainty, "confirmed");
  assert.deepEqual(subnet.action, { kind: "use_dhcp", cabinetId: "c1", cabinetName: "Surgery", interfaceIndex: 12, label: "Switch Ethernet to DHCP" });
  assert.match(subnet.evidence[0]!, /10\.21\.4\.0\/24/);
  for (const id of ["gateway", "dns-all", "sync-down"]) assert.equal(find(e, id)?.causedBy, "baseline-subnet-12", id);
  assert.equal(networkFindings(e)[0]!.id.startsWith("baseline-") || networkFindings(e)[0]!.severity === "problem", true);
});

test("baseline: the same wrong address at a site with fixed addresses has no automatic fix, and says what to do", () => {
  const e = evidence({ baseline: { ...BASE, addressing: "static" }, config: { adapters: [adapter({ ipv4: { dhcp: false, addresses: [{ address: "192.168.1.57", prefixLength: 24 }], gateways: ["192.168.1.1"] } })] } });
  const f = find(e, "baseline-subnet-12")!;
  assert.equal(f.action, undefined);
  assert.match(f.fix!, /fixed addresses/);
});

test("baseline: a fixed address at a DHCP site that is otherwise right is a warning with the DHCP fix", () => {
  const f = find(withAdapter({ ipv4: { dhcp: false, addresses: [{ address: "10.21.4.77", prefixLength: 24 }], gateways: ["10.21.4.1"] } }), "baseline-addressing-12")!;
  assert.equal(f.severity, "warning");
  assert.equal(f.action?.kind, "use_dhcp");
});

test("baseline: the wrong gateway on a fixed address is fixed by setting the baseline gateway and keeping the address", () => {
  const f = find(evidence({ baseline: { ...BASE, addressing: "static" }, config: { adapters: [adapter({ ipv4: { dhcp: false, addresses: [{ address: "10.21.4.77", prefixLength: 24 }], gateways: ["10.21.4.254"] } })] },
    tests: [fail("gateway", "Gateway"), fail("platform", "Platform")] }), "baseline-gateway-12")!;
  assert.equal(f.severity, "problem");
  assert.deepEqual(f.action, { kind: "set_static", cabinetId: "c1", cabinetName: "Surgery", interfaceIndex: 12, address: "10.21.4.77", prefixLength: 24, gateway: "10.21.4.1", label: "Set the gateway to 10.21.4.1" });
});

test("baseline: a wrong gateway handed out by DHCP has no cabinet fix (the DHCP scope is wrong)", () => {
  const f = find(withAdapter({ ipv4: { dhcp: true, addresses: [{ address: "10.21.4.77", prefixLength: 24 }], gateways: ["10.21.4.254"] } }), "baseline-gateway-12")!;
  assert.equal(f.action, undefined);
  assert.match(f.fix!, /DHCP scope/);
});

test("baseline: DNS servers that are not the site's: a problem when none match, a warning when some do; the fix sets the baseline servers", () => {
  const none = find(withAdapter({ dns: { automatic: false, servers: ["10.1.1.5", "10.1.1.6"] } }), "baseline-dns-12")!;
  assert.equal(none.severity, "problem");
  assert.deepEqual(none.action, { kind: "set_dns", cabinetId: "c1", cabinetName: "Surgery", interfaceIndex: 12, servers: BASE.dnsServers, label: "Set DNS to 10.21.4.10, 10.21.4.11" });
  const some = find(withAdapter({ dns: { automatic: false, servers: ["10.21.4.10", "10.255.255.254"] } }), "baseline-dns-12")!;
  assert.equal(some.severity, "warning");
  // The same servers in another order are the same servers.
  assert.equal(find(withAdapter({ dns: { automatic: false, servers: ["10.21.4.11", "10.21.4.10"] } }), "baseline-dns-12"), undefined);
});

test("baseline: no DHCP lease (169.254) offers the lease renewal; a cable fault offers no remote fix, only what to check", () => {
  const apipa = find(withAdapter({ ipv4: { dhcp: true, addresses: [{ address: "169.254.10.200", prefixLength: 16 }], gateways: [] }, dns: { automatic: true, servers: [] } }), "ip-12")!;
  assert.equal(apipa.action?.kind, "renew_lease");
  const slow = find(withAdapter({ linkSpeedBps: 100_000_000 }), "speed-12")!;
  assert.equal(slow.action, undefined);
  assert.match(slow.fix!, /patch cable/);
});

test("subnet arithmetic: prefix sizes, the edges, and addresses that are not addresses", () => {
  assert.equal(sameSubnet("10.21.4.9", "10.21.4.200", 24), true);
  assert.equal(sameSubnet("10.21.5.9", "10.21.4.1", 24), false);
  assert.equal(sameSubnet("10.21.5.9", "10.21.4.1", 16), true);
  assert.equal(sameSubnet("10.21.4.1", "10.21.4.1", 32), true);
  assert.equal(sameSubnet("10.21.4.1", "10.21.4.2", 32), false);
  for (const bad of ["", "10.21.4", "10.21.4.256", "10.21.4.1.1", "a.b.c.d", "10.21.4.-1", "10.21.4. 1"]) assert.equal(sameSubnet(bad, "10.21.4.1", 24), false, bad);
  assert.equal(sameSubnet("10.21.4.1", "10.21.4.1", 33), false);
});

test("layers: each cabinet's path from the link up to the firewall, worst finding per layer, unknown when nothing was checked there", () => {
  const f = networkFindings(withAdapter({ dns: { automatic: false, servers: ["10.1.1.5"] } }, { tests: [pass("gateway", "Gateway"), fail("dns-0", "DNS server 1")] }));
  const l = layerStates(f);
  assert.equal(l.link, "ok");
  assert.equal(l.gateway, "ok");
  assert.equal(l.dns, "problem");
  assert.equal(l.sync, "unknown");
});

test("the drawer link is not judged against the site's network or gateway", () => {
  const drawer = adapter({ interfaceIndex: 13, name: "Ethernet 2", ipv4: { dhcp: false, addresses: [{ address: "172.20.1.12", prefixLength: 24 }], gateways: [] }, dns: { automatic: false, servers: [] } });
  const e = evidence({ config: { adapters: [adapter(), drawer] }, baseline: { addressing: "dhcp", gateway: "10.21.4.1", prefixLength: 24, dnsServers: ["10.21.4.10", "10.21.4.11"] } as never });
  const f = networkFindings(e);
  assert.ok(f.every(x => !x.id.endsWith("-13")), JSON.stringify(f.filter(x => x.id.endsWith("-13"))));
  assert.ok(f.every(x => x.severity === "ok"), JSON.stringify(f.filter(x => x.severity !== "ok")));
});
