// The address a sync cabinet's satellites reach, picked from what the cabinet reports (services/sync-cabinets.ts). Pure: no database.
// A report is agent input, so malformed and hostile shapes are fed too; none of them may yield an address.
import test from "node:test";
import assert from "node:assert/strict";
import { adaptersFromItems, adaptersFromNetworkConfig, isCanonicalIpv4, lanAddress } from "../src/services/sync-cabinets.js";

const up = (...addresses: string[]) => ({ connected: true, addresses });

test("the single private address on a connected adapter is the one", () => {
  assert.equal(lanAddress([up("10.20.0.15/24")]), "10.20.0.15");
  assert.equal(lanAddress([up("192.168.4.20")]), "192.168.4.20");
  assert.equal(lanAddress([up("172.16.0.9/16"), { connected: false, addresses: ["10.9.9.9/24"] }]), "172.16.0.9");
  // The same address on two adapters (a team, a bridge) is still one address.
  assert.equal(lanAddress([up("10.20.0.15/24"), up("10.20.0.15/24")]), "10.20.0.15");
  // Public, self-assigned and loopback addresses are not where satellites reach it.
  assert.equal(lanAddress([up("10.20.0.15/24", "203.0.113.4/24", "169.254.1.1/16", "127.0.0.1/8")]), "10.20.0.15");
});

test("none, or several, gives nothing: the platform does not guess", () => {
  assert.equal(lanAddress([]), null);
  assert.equal(lanAddress([up()]), null);
  assert.equal(lanAddress([{ connected: false, addresses: ["10.20.0.15/24"] }]), null);
  assert.equal(lanAddress([up("10.20.0.15/24", "10.20.0.16/24")]), null);
  assert.equal(lanAddress([up("10.20.0.15/24"), up("192.168.1.5/24")]), null);
  assert.equal(lanAddress([up("8.8.8.8/32", "169.254.3.4/16")]), null);
});

test("malformed or hostile addresses never become the sync address", () => {
  for (const bad of ["010.20.0.15", "10.20.0.015", " 10.20.0.15", "10.20.0.15 ", "+10.20.0.15", "10.20.0", "10.20.0.15.1", "10.20.0.256",
    "10.20.0.1e1", "0x0a.20.0.15", "10.20.0.15;DROP TABLE cabinets", "10.20.0.15\u0000", "１0.20.0.15", "", ".", "...", "10..0.15", "10.20.0.-1"]) {
    assert.equal(lanAddress([up(bad)]), null, JSON.stringify(bad));
    assert.equal(lanAddress([up(`${bad}/24`)]), null, `${JSON.stringify(bad)}/24`);
  }
  // A bad entry beside a good one does not count as a second address.
  assert.equal(lanAddress([up("10.20.0.15/24", "010.20.0.16/24")]), "10.20.0.15");
  assert.equal(isCanonicalIpv4("10.20.0.15"), true);
  assert.equal(isCanonicalIpv4("1.2.3.4.5"), false);
});

test("a stored network configuration: adapters only, and anything not shaped like an adapter counts as absent", () => {
  const items = [
    { key: "adapter:Ethernet", values: { connected: true, addresses: ["10.20.0.15/24"] } },
    { key: "adapter:Wi-Fi", values: { connected: "yes", addresses: ["10.30.0.5/24"] } },
    { key: "adapter:Odd", values: { connected: true, addresses: "10.40.0.5/24" } },
    { key: "adapter:Mixed", values: { connected: true, addresses: [5, null, { a: 1 }, "10.20.0.15/24"] } },
    { key: "route:0.0.0.0/0", values: { connected: true, addresses: ["10.50.0.5/24"] } },
  ] as never;
  const adapters = adaptersFromItems(items);
  assert.equal(adapters.length, 4, "routes are not adapters");
  assert.deepEqual(adapters[1], { connected: false, addresses: ["10.30.0.5/24"] }, "only a true boolean is connected");
  assert.deepEqual(adapters[2]!.addresses, [], "a string is not a list");
  assert.equal(lanAddress(adapters), "10.20.0.15");
});

test("a network.config result, as the operation's contract shapes it, and shapes it does not", () => {
  const output = { adapters: [
    { connected: true, ipv4: { addresses: [{ address: "10.20.0.15", prefixLength: 24 }] } },
    { connected: true, ipv4: { addresses: [{ address: 7 }, null] } },
    { connected: true },
  ] };
  assert.equal(lanAddress(adaptersFromNetworkConfig(output)), "10.20.0.15");
  for (const junk of [null, undefined, 5, "x", [], {}, { adapters: "no" }, { adapters: [null, 5, "x"] }])
    assert.equal(lanAddress(adaptersFromNetworkConfig(junk)), null, JSON.stringify(junk));
});
