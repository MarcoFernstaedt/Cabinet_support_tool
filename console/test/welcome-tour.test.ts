// The welcome tour is data, so what it covers can be checked: every menu item and every cabinet tab has a step, each target is one the page really has,
// and what a person is told matches what their role can see.
import test from "node:test";
import assert from "node:assert/strict";
import { forMode, welcomeSteps } from "../src/lib/welcome-tour.ts";
import { SECTIONS } from "../src/lib/sections.ts";

const CAB = "00000000-0000-4000-8000-0000000000aa";
const ids = (steps: { id: string }[]) => steps.map(s => s.id);

test("every cabinet tab has its own step, in the order of the tabs, in the full tour", () => {
  const steps = welcomeSteps({ role: "tier1", canApproveFixes: false }, CAB);
  const tabs = steps.filter(s => s.id.startsWith("tab-"));
  assert.deepEqual(tabs.map(s => s.id), SECTIONS.map(([k]) => `tab-${k}`));
  for (const [key, label] of SECTIONS) {
    const s = tabs.find(t => t.id === `tab-${key}`)!;
    assert.equal(s.title, label);
    assert.equal(s.path, `/cabinets/${CAB}/${key}`);
    assert.match(s.target!.selector, new RegExp(`/${key}"\\]$`), "points at that tab's link");
    assert.ok(s.body.length > 0 && s.body.every(p => p.length > 20 && p.length < 400), `${key}: a short paragraph or two`);
  }
});

test("every item of the main menu a person has is covered, and none they do not have", () => {
  const menu = (role: "tier1" | "tier2" | "admin", fixes: boolean) => ids(welcomeSteps({ role, canApproveFixes: fixes }, null));
  for (const need of ["fleet", "search", "alerts", "incidents", "operations", "issues", "account"]) assert.ok(menu("tier1", false).includes(need), need);
  assert.ok(!menu("tier1", false).includes("admin"), "Tier 1 has no Admin menu");
  assert.ok(!menu("tier2", false).includes("fixes"), "Fixes only for those who can approve");
  assert.ok(menu("tier2", true).includes("fixes"));
  assert.ok(menu("admin", true).includes("admin") && menu("admin", true).includes("fixes"));
});

test("a menu step points at a link the menu really has", () => {
  const hrefs = new Set(["/", "/search", "/alerts", "/incidents", "/fleet-operations", "/issues", "/fixes", "/admin"]);
  for (const s of welcomeSteps({ role: "admin", canApproveFixes: true }, CAB).filter(s => s.target?.selector.startsWith(".topbar nav a"))) {
    const href = /href="([^"]+)"/.exec(s.target!.selector)![1]!;
    assert.ok(hrefs.has(href), `${s.id}: ${href}`);
    assert.equal(s.path, href, `${s.id} opens the page it talks about`);
  }
});

test("with no cabinet yet the tour says so instead of pointing at tabs that are not there", () => {
  const steps = welcomeSteps({ role: "admin", canApproveFixes: true }, null);
  assert.ok(!steps.some(s => s.id.startsWith("tab-")));
  assert.ok(steps.some(s => s.id === "cabinet-later"));
  assert.ok(steps.every(s => !s.path?.includes("/cabinets/")));
});

test("the short tour is a subset, starts with the welcome, and ends with the account and the finish", () => {
  const full = welcomeSteps({ role: "admin", canApproveFixes: true }, CAB);
  const quick = forMode(full, "quick");
  assert.ok(quick.length < full.length && quick.length >= 8);
  assert.ok(quick.every(s => full.includes(s)));
  assert.equal(quick[0]!.id, "welcome");
  assert.deepEqual(ids(quick).slice(-2), ["account", "done"]);
  assert.equal(forMode(full, "full"), full);
});

test("no step is told in the wrong words: nothing promises a shell, a file transfer or a pattern", () => {
  const text = welcomeSteps({ role: "admin", canApproveFixes: true }, CAB).flatMap(s => [s.title, ...s.body, s.needs ?? ""]).join(" ").toLowerCase();
  for (const bad of ["run any command", "upload a file", "regular expression", "powershell", "remote desktop"]) assert.ok(!text.includes(bad), bad);
  assert.ok(text.includes("no remote shell and no file transfer"));
});

test("ids are unique", () => {
  const all = ids(welcomeSteps({ role: "admin", canApproveFixes: true }, CAB));
  assert.equal(new Set(all).size, all.length);
});
