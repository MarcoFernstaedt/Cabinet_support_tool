import test from "node:test";
import assert from "node:assert/strict";
import { baselineFrom } from "../src/services/site-standards.js";

const adapter = (over: Record<string, unknown> = {}) => ({ connected: true, type: "ethernet",
  ipv4: { dhcp: true, addresses: [{ address: "10.1.1.20", prefixLength: 24 }], gateways: ["10.1.1.1"] }, dns: { servers: ["10.1.1.10", "10.1.1.11"] }, ...over });

test("a baseline is taken from the first connected card with an address, gateway and DNS", () => {
  assert.deepEqual(baselineFrom([adapter({ connected: false }), adapter()]), { addressing: "dhcp", prefixLength: 24, gateway: "10.1.1.1", dnsServers: ["10.1.1.10", "10.1.1.11"] });
});

test("nothing usable, or hostile readings, give no baseline", () => {
  assert.equal(baselineFrom(null), null);
  assert.equal(baselineFrom("x"), null);
  assert.equal(baselineFrom([null, 5, {}]), null);
  assert.equal(baselineFrom([adapter({ ipv4: { dhcp: true, addresses: [{ address: "169.254.1.2", prefixLength: 16 }], gateways: [] } })]), null, "no gateway");
  assert.equal(baselineFrom([adapter({ dns: { servers: ["fe80::1", "not an address", "999.1.1.1"] } })]), null, "no IPv4 DNS server");
  assert.equal(baselineFrom([adapter({ ipv4: { dhcp: false, addresses: [{ address: "10.1.1.20", prefixLength: 31 }], gateways: ["10.1.1.1"] } })]), null, "prefix outside what a baseline allows");
  assert.equal(baselineFrom([adapter({ ipv4: { dhcp: false, addresses: [{ address: "10.1.1.20", prefixLength: 24 }], gateways: ["fe80::1"] } })]), null, "gateway not IPv4");
});

test("DNS servers are de-duplicated and capped at four", () => {
  const b = baselineFrom([adapter({ dns: { servers: ["1.1.1.1", "1.1.1.1", "8.8.8.8", "8.8.4.4", "9.9.9.9", "4.4.4.4"] } })]);
  assert.deepEqual(b?.dnsServers, ["1.1.1.1", "8.8.8.8", "8.8.4.4", "9.9.9.9"]);
});
