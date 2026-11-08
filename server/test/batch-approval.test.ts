// Batch approval (F6.R2, decision-log D36): several pending cabinets of one site approved in one action, with one role and one baseline
// decision, confirmed with one code bound to the whole batch. Each cabinet is approved on its own, so one refusal leaves the rest approved
// and itself pending; an attach applies once and the rest inherit it. Through the real console routes on a real SQL Server.
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
import { createBootstrapToken, submitEnrollment } from "../src/services/enrollment.js";
import { ConsoleHarness, ORIGIN, type Account } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);
const call = h.call.bind(h);
let ada: Account, bo: Account, tier2: Account;
let roleVersion: string;

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  [ada, bo, tier2] = [await h.account("admin"), await h.account("admin"), await h.account("tier2")];
  // A satellite role baseline, so satellites have a baseline in force wherever they are approved.
  const draft = await call("POST", "/api/baselines/drafts", { scope: { kind: "role", id: "satellite" }, description: "For the test", content: { items: [{ category: "services", key: "service:W32Time", mode: "present" }] } }, ada);
  roleVersion = draft.body.id;
  await call("POST", `/api/baselines/versions/${roleVersion}/propose`, {}, ada);
  const note = "Reviewed in the test.";
  assert.equal((await call("POST", `/api/baselines/versions/${roleVersion}/approve`, { note, stepUpToken: await h.codeToken(bo, "baseline.approve", roleVersion, { note }) }, bo)).status, 200);
  await reevaluationsSettled();
});
test.after(async () => { await reevaluationsSettled(); await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

async function newSite() {
  const clientId = randomUUID(), siteId = randomUUID(), tag = randomBytes(3).toString("hex");
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [clientId, `Client ${tag}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [siteId, clientId, `Site ${tag}`]);
  return { clientId, siteId, client: `Client ${tag}`, site: `Site ${tag}` };
}
const enroll = (token: string) => submitEnrollment(db.app, {
  csr: csrFor(ecKey()), bootstrapToken: token,
  fingerprints: { hostname: "CAB-" + randomBytes(2).toString("hex"), serialNumber: "SN-" + randomBytes(3).toString("hex"), macAddresses: [],
    provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 11", agentVersion: "0.3.1" },
}, "10.77.0.9");
async function batch(body: Record<string, unknown>, who: Account = ada, confirmFor: Record<string, unknown> = body) {
  return call("POST", "/api/admin/enrollments/approve-batch", { ...body, stepUpToken: await h.codeToken(who, "enrollment.approve_batch", "fleet", confirmFor) }, who);
}
const status = async (id: string) => (await db.app.query<{ status: string }>("SELECT status FROM enrollment_requests WHERE id = $1", [id])).rows[0]!.status;

test("a site's cabinets are approved together; one from another site's installer is refused and left pending, the rest are approved", async () => {
  const s = await newSite(), other = await newSite();
  const { token } = await createBootstrapToken(db.app, ada.id, undefined, { siteId: s.siteId, role: "satellite", cabinets: 3 });
  const elsewhere = await createBootstrapToken(db.app, ada.id, undefined, { siteId: other.siteId, cabinets: 1 });
  const [a, b, c] = [await enroll(token), await enroll(token), await enroll(token)];
  const stray = await enroll(elsewhere.token);
  const r = await batch({ client: s.client, site: s.site, role: "satellite", baseline: { use: "inherited" },
    cabinets: [{ requestId: a, cabinet: "Sat 1" }, { requestId: stray, cabinet: "Stray" }, { requestId: b, cabinet: "Sat 2" }, { requestId: c, cabinet: "Sat 3" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const out = r.body.outcomes as { requestId: string; outcome: string; error?: string }[];
  assert.deepEqual(out.map(o => [o.requestId, o.outcome, o.error ?? null]), [[a, "approved", null], [stray, "refused", "not_this_site"], [b, "approved", null], [c, "approved", null]]);
  assert.deepEqual([await status(a), await status(stray), await status(b), await status(c)], ["issued", "pending", "issued", "issued"]);
  const names = (await db.app.query<{ name: string }>("SELECT name FROM cabinets WHERE site_id = $1 ORDER BY name", [s.siteId])).rows.map(x => x.name);
  assert.deepEqual(names, ["Sat 1", "Sat 2", "Sat 3"]);
  const audit = (await db.app.query<{ details: { approved: number; refused: { requestId: string; error: string }[]; requests: string[] } }>(
    "SELECT details FROM audit_log WHERE action = 'enrollment.approve_batch' ORDER BY seq DESC")).rows[0]!.details;
  assert.deepEqual([audit.approved, audit.refused, audit.requests.length], [3, [{ requestId: stray, error: "not_this_site" }], 4]);
  const approvedIds = out.filter(o => o.outcome === "approved").map(o => (o as unknown as { cabinetId: string }).cabinetId);
  assert.equal(Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'enrollment.approve' AND target_id IN (SELECT value FROM OPENJSON($1))",
    [JSON.stringify(approvedIds)])).rows[0]!.n), 3, "each cabinet has its own approval entry too");
});

test("an attach is made once, with the first cabinet, and the rest use it as the baseline in force", async () => {
  const s = await newSite();
  const { token } = await createBootstrapToken(db.app, ada.id, undefined, { siteId: s.siteId, cabinets: 2 });
  const [a, b] = [await enroll(token), await enroll(token)];
  const r = await batch({ client: s.client, site: s.site, role: "standalone", baseline: { use: "attach", versionId: roleVersion },
    cabinets: [{ requestId: a, cabinet: "Stand 1" }, { requestId: b, cabinet: "Stand 2" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((r.body.outcomes as { outcome: string }[]).map(o => o.outcome), ["approved", "approved"], JSON.stringify(r.body));
  assert.equal(Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'baseline.attach'")).rows[0]!.n), 1, "attached once");
});

test("a batch that lists a cabinet twice, names two alike, is confirmed for other cabinets, or comes from Tier 2 approves nothing", async () => {
  const s = await newSite();
  const { token } = await createBootstrapToken(db.app, ada.id, undefined, { siteId: s.siteId, role: "satellite", cabinets: 3 });
  const [a, b] = [await enroll(token), await enroll(token)];
  const base = { client: s.client, site: s.site, role: "satellite", baseline: { use: "inherited" } };
  assert.equal((await batch({ ...base, cabinets: [{ requestId: a, cabinet: "One" }, { requestId: a, cabinet: "Two" }] })).status, 400, "listed twice");
  assert.equal((await batch({ ...base, cabinets: [{ requestId: a, cabinet: "Same" }, { requestId: b, cabinet: "same" }] })).status, 400, "two names alike");
  const two = { ...base, cabinets: [{ requestId: a, cabinet: "One" }, { requestId: b, cabinet: "Two" }] };
  assert.equal((await batch(two, ada, { ...base, cabinets: [{ requestId: a, cabinet: "One" }] })).status, 403, "a code confirmed for one cabinet does not approve two");
  assert.equal((await batch(two, tier2)).status, 403, "only an Admin approves");
  for (const bad of [{ ...two, baseline: { use: "capture" } }, { ...two, cabinets: [] }, { ...two, cabinets: [{ requestId: "1 OR 1=1", cabinet: "X" }] }, { ...two, cabinets: [{ requestId: a, cabinet: "<script>" }] }])
    assert.equal((await batch(bad)).status, 400, JSON.stringify(bad));
  assert.deepEqual([await status(a), await status(b)], ["pending", "pending"], "nothing was approved");
});
