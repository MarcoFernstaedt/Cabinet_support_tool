import test from "node:test";
import assert from "node:assert/strict";
import { looksPrivate } from "../src/lib/ipv4.ts";

test("a private dotted quad passes the console's check", () => {
  for (const ok of ["10.20.0.15", "10.0.0.0", "172.16.0.1", "172.31.255.255", "192.168.4.20"]) assert.equal(looksPrivate(ok), true, ok);
});

test("public, malformed and signed addresses are caught before a code is asked for", () => {
  for (const bad of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "10.20.0.-1", "-10.20.0.1", "+10.20.0.1", "10.20.0.256", "010.20.0.1",
    "10.20.0", "10.20.0.1.5", "10..0.1", " 10.20.0.1", "10.20.0.1 ", "10.20.0.1e1", "0x0a.0.0.1", "１0.20.0.1", "sync.local", ""]) assert.equal(looksPrivate(bad), false, JSON.stringify(bad));
});
