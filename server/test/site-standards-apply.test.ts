// Applying a site's standards in one action (F6.R3, decision-log D37): copied from another site's own settings, or taken from what this
// site's cabinets report. Each part is written by its own writer with its own audit entry, in one transaction with a code bound to the
// request; a part with nothing to apply is skipped with the reason; nothing at all to apply is refused. Through the real console route.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { transaction } from "../src/db/db.js";
import { writeSitePolicy } from "../src/services/firewall-policy.js";
import { setNetworkBaseline } from "../src/services/network-baseline.js";
import { setSiteTimeZone, type TimeZoneId } from "../src/services/time.js";
import { ConsoleHarness, ORIGIN, type Account } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);
const call = h.call.bind(h);
let ada: Account, tier2: Account;

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  [ada, tier2] = [await h.account("admin"), await h.account("tier2")];
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

async function newSite(clientId?: string) {
  const client = clientId ?? randomUUID(), siteId = randomUUID(), tag = randomBytes(3).toString("hex");
  if (!clientId) await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `Client ${tag}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [siteId, client, `Site ${tag}`]);
  return { clientId: client, siteId };
}
const BASELINE = { addressing: "dhcp" as const, prefixLength: 24, gateway: "10.40.0.1", dnsServers: ["10.40.0.2", "10.40.0.3"] };
const POLICY = { domain: "on" as const, private: "on" as const, public: "off" as const };
async function apply(siteId: string, body: Record<string, unknown>, who: Account = ada, confirmFor: Record<string, unknown> = body) {
  return call("POST", `/api/sites/${siteId}/standards/apply`, { ...body, stepUpToken: await h.codeToken(who, "site.apply_standards", siteId, confirmFor) }, who);
}
const site = async (id: string) => (await db.app.query<{ time_zone: string | null; network_baseline: unknown; firewall_policy: unknown }>(
  "SELECT time_zone, network_baseline, firewall_policy FROM sites WHERE id = $1", [id])).rows[0]!;
const asJson = (v: unknown) => typeof v === "string" ? JSON.parse(v) : v;

test("a site's standards are copied from another site in one action, each part written and audited as if set on its own", async () => {
  const src = await newSite(), dst = await newSite(src.clientId);
  await setSiteTimeZone(db.app, ada.id, src.siteId, "Eastern Standard Time" as TimeZoneId);
  await setNetworkBaseline(db.app, ada.id, src.siteId, BASELINE);
  await transaction(db.app, c => writeSitePolicy(c, ada.id, src.siteId, POLICY));
  const r = await apply(dst.siteId, { from: { siteId: src.siteId }, parts: ["networkBaseline", "timeZone", "firewall"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.applied, r.body.skipped], [["networkBaseline", "timeZone", "firewall"], []]);
  const after = await site(dst.siteId);
  assert.deepEqual([after.time_zone, asJson(after.network_baseline), asJson(after.firewall_policy)], ["Eastern Standard Time", BASELINE, POLICY]);
  const actions = (await db.app.query<{ action: string }>("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY seq", [dst.siteId.toLowerCase()])).rows.map(a => a.action);
  for (const a of ["site.network_baseline", "site.time_zone", "site.apply_standards"]) assert.ok(actions.includes(a), `${a} in ${actions}`);
});

test("from the site's own cabinets, the parts with a suggestion are applied and the rest are skipped with why; nothing at all is refused", async () => {
  const s = await newSite();
  for (let i = 0; i < 2; i++)
    await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, time_zone_id, firewall_profiles) VALUES ($1, $2, $3, 'standalone', 'active', 'Central Standard Time', $4)",
      [randomUUID(), s.siteId, `K${i}`, JSON.stringify({ domain: true, private: true, public: false })]);
  const r = await apply(s.siteId, { from: "suggested", parts: ["networkBaseline", "timeZone", "firewall"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.applied, ["timeZone", "firewall"]);
  assert.deepEqual(r.body.skipped.map((x: { part: string }) => x.part), ["networkBaseline"], "no cabinet has had its network read");
  assert.equal((await site(s.siteId)).time_zone, "Central Standard Time");
  const empty = await newSite();
  const none = await apply(empty.siteId, { from: "suggested", parts: ["timeZone"] });
  assert.equal(none.status, 409, JSON.stringify(none.body));
  assert.equal(none.body.error, "nothing_to_apply");
  assert.equal((await site(empty.siteId)).time_zone, null, "nothing written");
});

test("only an Admin applies, with a code for exactly these parts; a site is not copied onto itself; hostile bodies change nothing", async () => {
  const src = await newSite(), dst = await newSite(src.clientId);
  await setSiteTimeZone(db.app, ada.id, src.siteId, "Pacific Standard Time" as TimeZoneId);
  const body = { from: { siteId: src.siteId }, parts: ["timeZone", "firewall"] };
  assert.equal((await apply(dst.siteId, body, tier2)).status, 403);
  assert.equal((await apply(dst.siteId, body, ada, { ...body, parts: ["timeZone"] })).status, 403, "a code confirmed for less does not apply more");
  assert.equal((await apply(dst.siteId, { from: { siteId: dst.siteId }, parts: ["timeZone"] })).status, 400, "not onto itself");
  assert.equal((await apply(dst.siteId, { from: { siteId: randomUUID() }, parts: ["timeZone"] })).status, 404);
  for (const bad of [{ from: "suggested", parts: [] }, { from: "suggested", parts: ["timeZone", "timeZone"] }, { from: "cabinet", parts: ["timeZone"] },
    { from: { siteId: "x' OR 1=1" }, parts: ["timeZone"] }, { from: "suggested", parts: ["scannerIds"] }])
    assert.equal((await apply(dst.siteId, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await site(dst.siteId)).time_zone, null, "nothing written");
  // The copy skips what the other site does not set itself (here its firewall), and says so.
  const r = await apply(dst.siteId, body);
  assert.deepEqual([r.body.applied, r.body.skipped.map((x: { part: string }) => x.part)], [["timeZone"], ["firewall"]]);
});
