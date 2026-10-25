// The full network read (docs/spec/16-network-troubleshooting.md): what the checks say about a cabinet that matches its baseline but
// has a lease about to end, errors on its network card, packet loss to the gateway, a path that stops, or a gateway that does not answer
// ARP. Pure functions: no database, no network. Older agents (no details, no traces) must produce no observations and no errors.
import test from "node:test";
import assert from "node:assert/strict";
import { networkFindings, type NetworkEvidence, type TestRun } from "../src/diagnose/network-findings.js";
import type { TraceRun } from "../src/diagnose/network-observations.js";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const adapter = (over: Record<string, unknown> = {}) => ({
  interfaceIndex: 12, name: "Ethernet", description: "Intel NIC", type: "ethernet", connected: true, linkSpeedBps: 1_000_000_000, macAddress: "00-1B-21-10-4F-5C",
  ipv4: { dhcp: true, addresses: [{ address: "10.21.9.25", prefixLength: 24 }], gateways: ["10.21.9.1"] }, ipv6Addresses: [], dns: { automatic: true, servers: ["10.21.9.10"] }, dnsSuffix: null,
  details: { dhcpServer: "10.21.9.2", leaseObtained: "2026-10-11T04:00:00Z", leaseExpires: "2026-10-12T04:00:00Z", mtu: 1500,
    statistics: { bytesReceived: 1, bytesSent: 1, receiveErrors: 0, sendErrors: 0, receiveDiscards: 0, sendDiscards: 0 } }, ...over });
const ok = (key: string, label: string, params: Record<string, unknown>, output: Record<string, unknown> = {}): TestRun => ({ key, label, params,
  output: { target: "gateway", method: "ping", resolvedTarget: "10.21.9.1", success: true, latencyMs: 0.6, resolvedAddresses: [], error: null, ...output } as never });
const evidence = (over: Partial<NetworkEvidence> = {}, a: Record<string, unknown> = {}): NetworkEvidence => ({
  cabinet: { id: "c", name: "Operating Room", role: "satellite" }, now: NOW,
  config: { adapters: [adapter(a)] } as never, policy: { domain: false, private: false, public: false }, baseline: null,
  sync: { address: null, ports: [], cabinet: null }, tests: [], ...over });
const byId = (e: NetworkEvidence, id: string) => networkFindings(e).find(f => f.id === id);

test("a healthy lease and a gateway that answers well are reported as fine, with what was read", () => {
  const e = evidence({ tests: [ok("gateway", "Gateway (ping)", { count: 4 }, { statistics: { sent: 4, received: 4, lossPercent: 0, minMs: 0.4, avgMs: 0.6, maxMs: 0.9, jitterMs: 0.1 } })] });
  const lease = byId(e, "obs-dhcp-12")!;
  assert.equal(lease.severity, "ok");
  assert.match(lease.evidence.join(" "), /10\.21\.9\.2/);
  assert.match(lease.evidence.join(" "), /Lease ends 2026-10-12T04:00:00Z \(16 h from now\)/);
  assert.equal(byId(e, "obs-ping-ok")!.severity, "ok");
  assert.equal(networkFindings(e).filter(f => f.severity === "problem" || f.severity === "warning").length, 0);
});

test("everything can match the baseline and still show trouble: loss to the gateway, errors on the card, a lease that ran out", () => {
  const e = evidence({ tests: [ok("gateway", "Gateway (ping)", { count: 4 }, { latencyMs: 24.3, statistics: { sent: 4, received: 3, lossPercent: 25, minMs: 1.8, avgMs: 24.3, maxMs: 61.2, jitterMs: 18.4 } })] },
    { details: { dhcpServer: "10.21.9.2", leaseObtained: "2026-10-10T04:00:00Z", leaseExpires: "2026-10-11T04:00:00Z", mtu: 1500,
      statistics: { bytesReceived: 9, bytesSent: 9, receiveErrors: 4812, sendErrors: 96, receiveDiscards: 912, sendDiscards: 0 } } });
  const loss = byId(e, "obs-ping-loss")!;
  assert.equal(loss.severity, "problem");
  assert.match(loss.title, /25%/);
  assert.match(loss.fix!, /patch cable/);
  const errors = byId(e, "obs-errors-12")!;
  assert.equal(errors.severity, "warning");
  assert.match(errors.title, /4,908 packet errors/);
  assert.equal(byId(e, "obs-lease-12")!.severity, "warning");
  assert.match(byId(e, "obs-lease-12")!.title, /has run out/);
  assert.equal(loss.layer, "gateway");
  assert.equal(errors.layer, "link");
  assert.equal(byId(e, "obs-lease-12")!.layer, "address");
});

test("a lease about to end, a small packet size and a slow gateway are said once each, as leads", () => {
  const soon = new Date(NOW + 40 * 60_000).toISOString();
  const e = evidence({ tests: [ok("gateway", "Gateway (ping)", { count: 4 }, { statistics: { sent: 4, received: 4, lossPercent: 0, minMs: 30, avgMs: 32, maxMs: 40, jitterMs: 3 } })] },
    { details: { dhcpServer: "10.21.9.2", leaseObtained: null, leaseExpires: soon, mtu: 1400, statistics: null } });
  assert.match(byId(e, "obs-lease-12")!.title, /ends in 40 min/);
  assert.match(byId(e, "obs-mtu-12")!.title, /1400, not the usual 1500/);
  assert.equal(byId(e, "obs-ping-slow")!.severity, "warning");
});

test("the ARP table: a gateway that never completes is a problem below IP; a complete entry is reported with its hardware address", () => {
  const stuck = evidence({ config: { adapters: [adapter()], neighbors: [{ interfaceIndex: 12, address: "10.21.9.1", macAddress: null, state: "incomplete" }] } as never });
  assert.equal(byId(stuck, "obs-arp")!.severity, "warning");
  assert.match(byId(stuck, "obs-arp")!.fix!, /cable|VLAN/);
  const fine = evidence({ config: { adapters: [adapter()], neighbors: [{ interfaceIndex: 12, address: "10.21.9.1", macAddress: "AC-1F-6B-15-04-01", state: "reachable" }] } as never });
  assert.match(byId(fine, "obs-arp-ok")!.title, /AC-1F-6B-15-04-01/);
});

test("a path that stops says where, and one that is reached says how many routers it crosses; a missing trace is 'not checked', never a guess", () => {
  const stops: TraceRun = { key: "trace-sync", label: "Path to the sync cabinet", params: {}, output: { target: "sync_cabinet", resolvedTarget: "10.21.9.20", reached: false, error: "No reply after hop 1.",
    hops: [{ hop: 1, address: "10.21.9.1", rttMs: [0.6, 0.5, 0.7] }, { hop: 2, address: null, rttMs: [null, null, null] }] } };
  const reached: TraceRun = { key: "trace-platform", label: "Path to the platform server", params: {}, output: { target: "platform_server", resolvedTarget: "203.0.113.10", reached: true, error: null,
    hops: [{ hop: 1, address: "10.21.9.1", rttMs: [0.6] }, { hop: 2, address: "100.64.0.1", rttMs: [4.2] }, { hop: 3, address: "203.0.113.10", rttMs: [12.1] }] } };
  const missing: TraceRun = { key: "trace-sync", label: "x", params: {}, failure: "your limit of 4 path traces per minute is reached" };
  const e = evidence({ traces: [stops, reached] });
  const s = byId(e, "obs-trace-sync")!;
  assert.equal(s.severity, "warning");
  assert.match(s.title, /stops after 10\.21\.9\.1/);
  assert.equal(s.layer, "sync");
  const p = byId(e, "obs-trace-platform")!;
  assert.equal(p.severity, "ok");
  assert.match(p.title, /3 hops, through 2 routers/);
  assert.equal(byId(evidence({ traces: [missing] }), "obs-trace-sync")!.certainty, "not_checked");
});

test("an agent from before the full read (no details, no routes, no neighbours, no traces, no statistics) gets no observations and no errors", () => {
  const old = evidence({ tests: [ok("gateway", "Gateway (ping)", { target: "gateway", method: "ping" })] }, { details: undefined });
  assert.deepEqual(networkFindings(old).filter(f => f.id.startsWith("obs-")), []);
});

test("hostile readings do not break the checks: absurd counters and lease times, a thousand hops, and text where numbers belong", () => {
  const e = evidence({ traces: [{ key: "trace-platform", label: "p", params: {}, output: { target: "platform_server", resolvedTarget: null, reached: false, error: null,
    hops: Array.from({ length: 20 }, (_, i) => ({ hop: i + 1, address: i % 2 ? null : "10.0.0.1", rttMs: [1, null, 3] })) } as never }] },
    { details: { dhcpServer: "10.21.9.2", leaseObtained: "not a date", leaseExpires: "not a date", mtu: 1500, statistics: { bytesReceived: 0, bytesSent: 0, receiveErrors: Number.MAX_SAFE_INTEGER, sendErrors: 0, receiveDiscards: 0, sendDiscards: 0 } } });
  const found = networkFindings(e);
  assert.ok(found.some(f => f.id === "obs-errors-12"));
  assert.ok(found.every(f => f.title.length < 400));
});
