import test from "node:test";
import assert from "node:assert/strict";
import { fieldsFrom, inheritedFrom, sitePoliciesFrom, type SitePolicyPreview } from "../src/lib/site-policies.ts";

const OFF = { domain: "off", private: "off", public: "off" } as const;
const preview = (p: Partial<SitePolicyPreview> = {}): SitePolicyPreview =>
  ({ siteExists: false, firewall: { policy: { ...OFF }, source: "fleet" }, timeZone: { zone: "Eastern Standard Time", source: "client" }, ...p });

test("keeping what is inherited sends null for both, so the site keeps following its client or the fleet", () => {
  const p = preview();
  assert.deepEqual(sitePoliciesFrom(p, fieldsFrom(p)), { firewall: null, timeZone: null });
});

test("only what the approver sets becomes the site's own", () => {
  const p = preview();
  const f = { ...fieldsFrom(p), firewallOwn: true, firewall: { ...OFF, public: "on" as const }, timeZone: "Pacific Standard Time" };
  assert.deepEqual(sitePoliciesFrom(p, f), { firewall: { domain: "off", private: "off", public: "on" }, timeZone: "Pacific Standard Time" });
  assert.deepEqual(fieldsFrom(p).firewall, OFF, "the own policy starts from the inherited one");
});

test("an existing site, or no preview yet, sends nothing", () => {
  assert.equal(sitePoliciesFrom(preview({ siteExists: true }), fieldsFrom(preview())), undefined);
  assert.equal(sitePoliciesFrom(null, fieldsFrom(preview())), undefined);
});

test("where an inherited value comes from is said plainly", () => {
  assert.equal(inheritedFrom("client", "policy"), "the client's policy");
  assert.equal(inheritedFrom("fleet", "default zone"), "the fleet's default zone");
  assert.equal(inheritedFrom(null, "zone"), null);
});
