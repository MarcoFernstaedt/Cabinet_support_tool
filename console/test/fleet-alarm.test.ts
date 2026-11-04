import test from "node:test";
import assert from "node:assert/strict";
import { alarmText, parseAcknowledged, unacknowledged } from "../src/lib/fleet-alarm.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const RANG = "2026-11-04T04:00:00Z";

test("only open, ringing, unacknowledged patterns sound the alarm, widest first", () => {
  const list = [
    { id: id(1), title: "a", sites: 6, cabinets: 6, clients: 1, alarmedAt: RANG },
    { id: id(2), title: "b", sites: 60, cabinets: 120, clients: 3, alarmedAt: RANG },
    { id: id(3), title: "c", sites: 9, cabinets: 9, clients: 1, resolvedAt: "2026-11-04T05:00:00Z", alarmedAt: RANG },
  ];
  assert.deepEqual(unacknowledged(list, new Set([id(1)])).map(p => p.title), ["b"]);
  assert.deepEqual(unacknowledged(list, new Set()).map(p => p.title), ["b", "a"]);
});

test("a minor pattern listed quietly (never rung) does not sound the alarm, however wide (D25)", () => {
  const list = [
    { id: id(1), title: "quiet", sites: 19, cabinets: 19, clients: 2, alarmedAt: null },
    { id: id(2), title: "older console", sites: 7, cabinets: 7, clients: 1 },
    { id: id(3), title: "rings", sites: 5, cabinets: 5, clients: 1, alarmedAt: RANG },
  ];
  assert.deepEqual(unacknowledged(list, new Set()).map(p => p.title), ["rings"]);
});

test("the alarm line names the problem and its reach", () => {
  assert.equal(alarmText({ title: "Fleet pattern: Restarting repeatedly", sites: 60, cabinets: 120, clients: 3 }), "Restarting repeatedly: 60 sites, 120 cabinets, 3 clients");
  assert.equal(alarmText({ title: "x", sites: 1, cabinets: 1, clients: 1 }), "x: 1 site, 1 cabinet, 1 client");
});

test("acknowledgements read from storage are ids only; anything else is ignored", () => {
  assert.deepEqual([...parseAcknowledged(JSON.stringify([id(1), 5, "<script>", id(2)]))], [id(1), id(2)]);
  for (const bad of [null, "", "{", JSON.stringify("x"), JSON.stringify({ a: 1 })]) assert.equal(parseAcknowledged(bad).size, 0, String(bad));
});
