import test from "node:test";
import assert from "node:assert/strict";
import { analyseDrawer, drawerText, findDrawerAdapter, inDrawerNetwork } from "../src/lib/drawer.ts";

const stats = (o: Partial<Record<string, number>> = {}) => ({ bytesReceived: 1000, bytesSent: 1000, receiveErrors: 0, sendErrors: 0, receiveDiscards: 0, sendDiscards: 0, ...o });
const adapter = (o: any = {}): any => ({
  interfaceIndex: 7, name: "Ethernet 2", description: "USB Ethernet", type: "ethernet", connected: true, linkSpeedBps: 100_000_000, macAddress: null,
  ipv4: { dhcp: false, addresses: [{ address: "172.20.1.10", prefixLength: 24 }], gateways: [] }, dns: { automatic: false, servers: [] }, dnsSuffix: null,
  details: { networkProfile: { name: "Unidentified network", category: "public" }, adminStatus: "up", statistics: stats() }, ...o });
const later = (a: any, s: object) => ({ ...a, details: { ...a.details, statistics: stats(s) } });
const off = [{ profile: "domain", enabled: false }, { profile: "private", enabled: false }, { profile: "public", enabled: false }];

test("addresses are matched by network, with no text parsing", () => {
  assert.equal(inDrawerNetwork("172.20.1.10"), true);
  assert.equal(inDrawerNetwork("176.20.2.10"), false);
  for (const bad of ["", "172.20.1", "172.20.1.999", "172.20.1.1.1", "a.b.c.d", "172.20.1.1 ", "０.0.0.0", "-1.0.0.0", "172.20.1.1e1"]) assert.equal(inDrawerNetwork(bad), false, bad);
});

test("the drawer adapter is found by address or by the unidentified network, never Wi-Fi", () => {
  const office = adapter({ interfaceIndex: 3, name: "Ethernet", ipv4: { dhcp: true, addresses: [{ address: "10.0.0.5", prefixLength: 24 }], gateways: ["10.0.0.1"] }, details: { networkProfile: { name: "clinic", category: "private" } } });
  assert.equal(findDrawerAdapter([office, adapter()])?.interfaceIndex, 7);
  assert.equal(findDrawerAdapter([office, adapter({ ipv4: { dhcp: false, addresses: [{ address: "169.254.3.3", prefixLength: 16 }], gateways: [] } })])?.interfaceIndex, 7);
  assert.equal(findDrawerAdapter([office, adapter({ type: "wifi" })]), null);
  assert.equal(findDrawerAdapter([office]), null);
});

test("a healthy drawer link passes", () => {
  const a = analyseDrawer([adapter()], [later(adapter(), { bytesReceived: 5000, bytesSent: 3000 })], 5, off);
  assert.equal(a.tone, "ok", a.summary);
  assert.match(drawerText("Cab 1", a), /cash drawer check/);
});

test("a missing drawer adapter is a problem", () => {
  const a = analyseDrawer([], null, 5, off);
  assert.equal(a.tone, "crit"); assert.equal(a.adapter, null);
});

test("each fault is named", () => {
  const tone = (a: any, b: any, p = off) => analyseDrawer([a], b ? [b] : null, 5, p);
  assert.equal(tone(adapter({ connected: false }), null).lines.find(l => l.id === "status")?.tone, "crit");
  assert.equal(tone(adapter({ details: { adminStatus: "down", networkProfile: { name: "Unidentified network", category: "public" } } }), null).lines.find(l => l.id === "status")?.tone, "crit");
  assert.equal(tone(adapter({ ipv4: { dhcp: true, addresses: [{ address: "169.254.1.1", prefixLength: 16 }], gateways: [] } }), null).lines.find(l => l.id === "ip")?.tone, "crit");
  assert.equal(tone(adapter({ ipv4: { dhcp: false, addresses: [{ address: "172.20.1.10", prefixLength: 16 }], gateways: [] } }), null).lines.find(l => l.id === "ip")?.tone, "warn");
  assert.equal(tone(adapter({ ipv4: { dhcp: false, addresses: [{ address: "192.168.1.5", prefixLength: 24 }], gateways: [] }, details: { networkProfile: { name: "Unidentified network", category: "public" } } }), null).lines.find(l => l.id === "ip")?.tone, "crit");
  assert.equal(tone(adapter({ ipv4: { dhcp: false, addresses: [{ address: "172.20.1.10", prefixLength: 24 }], gateways: ["172.20.1.1"] } }), null).lines.find(l => l.id === "gateway")?.tone, "warn");
  assert.equal(tone(adapter(), later(adapter(), { receiveErrors: 3 })).lines.find(l => l.id === "packets")?.tone, "crit");
  assert.equal(tone(adapter(), later(adapter(), {})).lines.find(l => l.id === "packets")?.tone, "warn");
  assert.equal(tone(adapter(), later(adapter(), { bytesSent: 2000 })).lines.find(l => l.id === "packets")?.tone, "warn");
  assert.equal(tone(adapter(), later(adapter(), { bytesReceived: 10, bytesSent: 10 })).lines.find(l => l.id === "packets")?.tone, "info"); // counters reset
});

test("the firewall must be off on every profile", () => {
  const a = analyseDrawer([adapter()], null, 5, [{ profile: "domain", enabled: false }, { profile: "private", enabled: true }, { profile: "public", enabled: true }]);
  assert.deepEqual(a.profilesOn, ["private", "public"]);
  assert.equal(a.lines.find(l => l.id === "firewall")?.tone, "crit");
  assert.equal(analyseDrawer([adapter()], null, 5, null).lines.find(l => l.id === "firewall")?.tone, "info");
});

test("hostile readings do not break the analysis", () => {
  const evil = adapter({ name: "<img src=x onerror=alert(1)>", description: null, linkSpeedBps: null, details: undefined, ipv4: { dhcp: false, addresses: [{ address: "172.20.1.10\n", prefixLength: 24 }], gateways: [] } });
  const a = analyseDrawer([evil], [evil], 0, off);
  assert.ok(a.lines.length > 0);
  assert.doesNotThrow(() => drawerText("x", a));
});

test("the drawer address is built from the drawer network and a usable last number, never from other text", async () => {
  const { drawerAddressParams } = await import("../src/lib/drawer.ts");
  assert.deepEqual(drawerAddressParams(7, "10"), { interfaceIndex: 7, mode: "static", address: "172.20.1.10", prefixLength: 24 });
  for (const bad of ["", "0", "255", "256", "1.5", "10 ", "1e1", "-1", "0010x", "1000", "١٠"]) assert.equal(drawerAddressParams(7, bad), null, bad);
});
