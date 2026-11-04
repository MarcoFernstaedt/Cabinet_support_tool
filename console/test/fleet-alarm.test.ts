import test from "node:test";
import assert from "node:assert/strict";
import { alarmText, parseAcknowledged, unacknowledged } from "../src/lib/fleet-alarm.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("only open, unacknowledged patterns sound the alarm, widest first", () => {
  const list = [
    { id: id(1), title: "a", sites: 6, cabinets: 6, clients: 1 },
    { id: id(2), title: "b", sites: 60, cabinets: 120, clients: 3 },
    { id: id(3), title: "c", sites: 9, cabinets: 9, clients: 1, resolvedAt: "2026-11-04T05:00:00Z" },
  ];
  assert.deepEqual(unacknowledged(list, new Set([id(1)])).map(p => p.title), ["b"]);
  assert.deepEqual(unacknowledged(list, new Set()).map(p => p.title), ["b", "a"]);
});

test("the alarm line names the problem and its reach", () => {
  assert.equal(alarmText({ title: "Fleet pattern: Restarting repeatedly", sites: 60, cabinets: 120, clients: 3 }), "Restarting repeatedly: 60 sites, 120 cabinets, 3 clients");
  assert.equal(alarmText({ title: "x", sites: 1, cabinets: 1, clients: 1 }), "x: 1 site, 1 cabinet, 1 client");
});

test("acknowledgements read from storage are ids only; anything else is ignored", () => {
  assert.deepEqual([...parseAcknowledged(JSON.stringify([id(1), 5, "<script>", id(2)]))], [id(1), id(2)]);
  for (const bad of [null, "", "{", JSON.stringify("x"), JSON.stringify({ a: 1 })]) assert.equal(parseAcknowledged(bad).size, 0, String(bad));
});
