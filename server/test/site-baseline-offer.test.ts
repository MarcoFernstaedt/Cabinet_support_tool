// The offer to capture a cabinet's configuration as its site's baseline (F17, decision-log D53). Made only where the site has no baseline
// of its own (approved, pending or in draft), the cabinet has reported every part a site baseline holds, and it is healthy: in contact, no
// required item drifting from a baseline that does apply, no major alert open. Accepting it is the existing capture, a draft for the site.
// Through the real configuration ingest and console routes on a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { reevaluationsSettled } from "../src/console-api/baseline-routes.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { configHash, type Item } from "../src/services/config-canonical.js";
import { ingestAndEvaluate } from "../src/services/config-service.js";
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
let t1: Account, t2: Account;
let clientId: string;

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  [t1, t2] = [await h.account("tier1"), await h.account("tier2")];
  clientId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour')", [clientId]);
});
test.after(async () => { await reevaluationsSettled(); await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

/** Every part a site baseline holds, in two uploads (an agent sends at most eight at a time); `leaveOut` drops some. */
async function reportAll(cabinetId: string, leaveOut: string[] = []) {
  const it = (key: string, values: Record<string, unknown>) => ({ key, values }) as Item;
  const now = new Date().toISOString();
  const s = (category: string, items: Item[]) => ({ observedAt: now, category, hash: configHash(items), truncated: false, items });
  const all = [
    s("network", [it("adapter:Ethernet", { connected: true, dhcp: true, addresses: ["10.77.0.9/24"], gateways: ["10.77.0.1"] })]),
    s("services", [it("service:W32Time", { startType: "automatic", state: "running" })]),
    s("drivers", [it("driver:oem1.inf", { version: "1.0" })]),
    s("updates", [it("update:KB5000001", { title: "Update" })]),
    s("firewall", [it("profile:domain", { enabled: true })]),
    s("time", [it("time", { timeZoneId: "UTC" })]),
    s("applications", [it("app:Cabinet App", { version: "4.2" })]),
    s("hosts", [it("host:localhost", { address: "127.0.0.1" })]),
    s("tasks", [it("task:Backup", { enabled: true })]),
    s("system", [it("hardware", { manufacturer: "Dell Inc.", model: "OptiPlex 7090" })]),
  ].filter(x => !leaveOut.includes(x.category));
  await ingestAndEvaluate(db.app, cabinetId, all.slice(0, 8) as never, "agent");
  if (all.length > 8) await ingestAndEvaluate(db.app, cabinetId, all.slice(8) as never, "agent");
  await reevaluationsSettled();
}
/** A cabinet at a site of its own, heard from now. */
async function cabinetAtNewSite() {
  const siteId = randomUUID(), id = randomUUID();
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [siteId, clientId, `Pier ${siteId.slice(0, 4)}`]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, $3, 'standalone', 'active', SYSUTCDATETIME())", [id, siteId, `K ${id.slice(0, 6)}`]);
  return { id, siteId };
}
const offer = async (id: string) => {
  const r = await call("GET", `/api/cabinets/${id}/condition`, undefined, t1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.siteOffer as { offered: boolean; site: { id: string }; notOffered: string[] };
};

test("a healthy cabinet at a site with no baseline is offered; accepting it drafts the site's baseline, and then it is not offered again", async () => {
  const k = await cabinetAtNewSite();
  await reportAll(k.id);
  const o = await offer(k.id);
  assert.deepEqual([o.offered, o.site.id, o.notOffered], [true, k.siteId, []]);
  // Accepting is the existing capture, for the site: a draft, nothing approved.
  const draft = await call("POST", "/api/baselines/capture", { cabinetId: k.id, scope: { kind: "site", id: k.siteId }, description: "Captured from a healthy cabinet.",
    categories: ["network", "services", "firewall", "time", "drivers", "hosts"] }, t2);
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const again = await offer(k.id);
  assert.deepEqual([again.offered, again.notOffered], [false, ["A baseline for the site is being drafted."]]);
});

test("not offered while the cabinet is out of contact, has a major alert open, or has not reported every part", async () => {
  const quiet = await cabinetAtNewSite();
  await reportAll(quiet.id);
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(hour, -2, SYSUTCDATETIME()) WHERE id = $1", [quiet.id]);
  const q = await offer(quiet.id);
  assert.equal(q.offered, false);
  assert.match(q.notOffered.join(" "), /^It is not healthy: Not heard from since /);

  const alerting = await cabinetAtNewSite();
  await reportAll(alerting.id);
  await db.app.query("INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen) VALUES ($1, NULL, 'major', 'unrecognized:System|disk|7', 'Disk failing', SYSUTCDATETIME(), SYSUTCDATETIME())", [alerting.id]);
  assert.deepEqual((await offer(alerting.id)).notOffered, ["It is not healthy: Disk failing"]);

  const partial = await cabinetAtNewSite();
  await reportAll(partial.id, ["firewall", "hosts"]);
  assert.deepEqual((await offer(partial.id)).notOffered, ["It has not reported all of its configuration yet (2 of 10 parts missing)."]);
});

test("where a client's baseline applies, a required item drifting from it is not healthy, so no offer; matching it, the offer is made", async () => {
  const [a1, a2] = [await h.account("admin"), await h.account("admin")];
  const draft = await call("POST", "/api/baselines/drafts", { scope: { kind: "client", id: clientId }, description: "The client's time service",
    content: { items: [{ category: "services", key: "service:W32Time", mode: "match", expect: { startType: "disabled" }, required: true }] } }, a1);
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal((await call("POST", `/api/baselines/versions/${draft.body.id}/propose`, {}, a1)).status, 200);
  const note = "The client's own setting.";
  assert.equal((await call("POST", `/api/baselines/versions/${draft.body.id}/approve`, { note, stepUpToken: await h.codeToken(a2, "baseline.approve", draft.body.id, { note }) }, a2)).status, 200);
  await reevaluationsSettled();
  const k = await cabinetAtNewSite();
  await reportAll(k.id); // W32Time automatic: drifts from the client's required "disabled"
  const o = await offer(k.id);
  assert.equal(o.offered, false);
  assert.match(o.notOffered[0]!, /^It is not healthy: service:W32Time \(startType\) is not as the baseline requires\.$/);
  // Withdraw the client's expectation by approving a version that matches: healthy, and offered.
  const next = await call("POST", "/api/baselines/drafts", { scope: { kind: "client", id: clientId }, description: "Matches the cabinets",
    content: { items: [{ category: "services", key: "service:W32Time", mode: "match", expect: { startType: "automatic" }, required: true }] } }, a1);
  assert.equal(next.status, 201, JSON.stringify(next.body));
  assert.equal((await call("POST", `/api/baselines/versions/${next.body.id}/propose`, {}, a1)).status, 200);
  assert.equal((await call("POST", `/api/baselines/versions/${next.body.id}/approve`, { note, stepUpToken: await h.codeToken(a2, "baseline.approve", next.body.id, { note }) }, a2)).status, 200);
  await reevaluationsSettled();
  assert.equal((await offer(k.id)).offered, true);
});
