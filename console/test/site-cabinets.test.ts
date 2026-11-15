import test from "node:test";
import assert from "node:assert/strict";
import { everySiteCabinet, MAX_SITE_PAGES } from "../src/lib/site-cabinets.ts";

type Answer = { name: string; cabinets: { id: number }[]; cabinetsPage: { limit: number; offset: number; hasMore: boolean } };
/** A server with `count` cabinets that pages them as the site route does: 200 when no page is asked for. */
function server(count: number) {
  const asked: string[] = [];
  const get = async (path: string): Promise<Answer> => {
    asked.push(path);
    const q = new URL(path, "http://x").searchParams;
    const limit = q.has("limit") ? Number(q.get("limit")) : 200, offset = q.has("offset") ? Number(q.get("offset")) : 0;
    const cabinets = Array.from({ length: Math.max(0, Math.min(limit, count - offset)) }, (_, i) => ({ id: offset + i }));
    return { name: "Big Site", cabinets, cabinetsPage: { limit, offset, hasMore: offset + cabinets.length < count } };
  };
  return { asked, get };
}

test("a site of more than 200 cabinets is read in full, the first page asked for exactly as before", async () => {
  const s = server(1_234);
  const site = await everySiteCabinet(s.get, "site-1");
  assert.equal(site.cabinets.length, 1_234);
  assert.deepEqual(site.cabinets.map(c => c.id), Array.from({ length: 1_234 }, (_, i) => i), "every cabinet once, in order");
  assert.equal(site.name, "Big Site", "the rest of the first answer is kept");
  assert.deepEqual(s.asked, ["/api/fleet/sites/site-1", "/api/fleet/sites/site-1?limit=500&offset=200", "/api/fleet/sites/site-1?limit=500&offset=700",
    "/api/fleet/sites/site-1?limit=500&offset=1200"]);
});

test("a site of 200 or fewer is one request, as before", async () => {
  for (const n of [0, 1, 200]) {
    const s = server(n);
    assert.equal((await everySiteCabinet(s.get, "site-1")).cabinets.length, n);
    assert.deepEqual(s.asked, ["/api/fleet/sites/site-1"], String(n));
  }
});

test("a server that keeps saying there is more is not followed for good, and an empty page that says more stops", async () => {
  let calls = 0;
  const forever = async () => { calls++; return { name: "x", cabinets: [{ id: calls }], cabinetsPage: { limit: 500, offset: 0, hasMore: true } }; };
  await assert.rejects(everySiteCabinet(forever, "site-1"), /could not be read in full/);
  assert.equal(calls, MAX_SITE_PAGES);
  const empty = async () => ({ name: "x", cabinets: [], cabinetsPage: { limit: 500, offset: 0, hasMore: true } });
  await assert.rejects(everySiteCabinet(empty, "site-1"), /could not be read in full/);
});

test("a failed page fails the whole read rather than offering part of the site", async () => {
  const s = server(900);
  const failing = async (path: string) => { if (path.includes("offset=200")) throw new Error("internal"); return s.get(path); };
  await assert.rejects(everySiteCabinet(failing, "site-1"), /internal/);
});

test("the site id is put in the path encoded, never as raw text", async () => {
  const s = server(1);
  await everySiteCabinet(s.get, "a/../b?x=1");
  assert.deepEqual(s.asked, ["/api/fleet/sites/a%2F..%2Fb%3Fx%3D1"]);
});
