import test from "node:test";
import assert from "node:assert/strict";
import { orderPatterns, reachText } from "../src/lib/fleet-patterns.ts";

test("a pattern's reach reads in one line", () => {
  assert.equal(reachText({ sites: 60, cabinets: 120, clients: 3 }), "60 sites, 120 cabinets, 3 clients");
  assert.equal(reachText({ sites: 1, cabinets: 1, clients: 1 }), "1 site, 1 cabinet, 1 client");
  assert.equal(reachText({ sites: 1200, cabinets: -1, clients: 2 }), "1,200 sites, ? cabinets, 2 clients");
});

test("open patterns come first, widest first; resolved ones after", () => {
  const p = (id: string, sites: number, resolvedAt: string | null, openedAt = "2026-11-04T00:00:00Z") => ({ id, sites, resolvedAt, openedAt });
  assert.deepEqual(orderPatterns([p("r", 90, "2026-11-04T02:00:00Z"), p("small", 5, null), p("wide", 60, null)]).map(x => x.id), ["wide", "small", "r"]);
});
