// The base-path helpers (src/lib/base.ts). The console runs at the origin root by default and under
// a path in some deployments, so every address it builds or reads has to survive odd input: a
// protocol-relative URL, a path that only looks like the base, a base that could climb out.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBase, stripBaseAt, withBaseAt } from "../src/lib/base.ts";

test("normalizeBase accepts a plain path and rejects anything else", () => {
  assert.equal(normalizeBase(undefined), "");
  assert.equal(normalizeBase(""), "");
  assert.equal(normalizeBase("/"), "");
  assert.equal(normalizeBase("/console"), "/console");
  assert.equal(normalizeBase("/console/"), "/console");
  assert.equal(normalizeBase("/a/b/"), "/a/b");
  assert.equal(normalizeBase("  /console  "), "/console");
  // Not absolute, or protocol-relative: not a path we can build under.
  assert.equal(normalizeBase("console/"), "");
  assert.equal(normalizeBase("//evil.example"), "");
  assert.equal(normalizeBase("//evil.example/console"), "");
  // Nothing that could climb out of the base or break the address the proxy matches on.
  assert.equal(normalizeBase("/console/../.."), "");
  assert.equal(normalizeBase("/console/./x"), "");
  assert.equal(normalizeBase("/console/?q=1"), "");
  assert.equal(normalizeBase("/console/#x"), "");
  assert.equal(normalizeBase("/console/a%2e%2e"), "");
});

test("withBaseAt puts the console's own paths under the base", () => {
  assert.equal(withBaseAt("", "/fleet"), "/fleet");
  assert.equal(withBaseAt("/console", "/"), "/console/");
  assert.equal(withBaseAt("/console", "/fleet"), "/console/fleet");
  assert.equal(withBaseAt("/console", "/fleet?a=1#b"), "/console/fleet?a=1#b");
  // Never doubled, and never rewritten for a path that is not the console's.
  assert.equal(withBaseAt("/console", "/console/fleet"), "/console/fleet");
  assert.equal(withBaseAt("/console", "//evil.example/x"), "//evil.example/x");
  assert.equal(withBaseAt("/console", "fleet"), "fleet");
  // "/consolex" is a different path, so it gets the base too.
  assert.equal(withBaseAt("/console", "/consolex"), "/console/consolex");
});

test("stripBaseAt tells the console where it is inside the base", () => {
  assert.equal(stripBaseAt("", "/fleet"), "/fleet");
  assert.equal(stripBaseAt("/console", "/console"), "/");
  assert.equal(stripBaseAt("/console", "/console/"), "/");
  assert.equal(stripBaseAt("/console", "/console/fleet"), "/fleet");
  assert.equal(stripBaseAt("/console", "/console/fleet?a=1"), "/fleet?a=1");
  // A different path, or one that only starts the same way, is left alone.
  assert.equal(stripBaseAt("/console", "/"), "/");
  assert.equal(stripBaseAt("/console", "/consolex"), "/consolex");
  assert.equal(stripBaseAt("/console", "/consolex/fleet"), "/consolex/fleet");
});

test("withBaseAt and stripBaseAt undo each other for the console's own paths", () => {
  for (const path of ["/", "/fleet", "/cabinets/2b3f1c40-0000-4000-8000-000000000000/event-logs", "/alerts?type=disk", "/admin/pending"]) {
    assert.equal(stripBaseAt("/console", withBaseAt("/console", path)), path);
  }
});
