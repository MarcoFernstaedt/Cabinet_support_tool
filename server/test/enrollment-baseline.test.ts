// Baselines are an enrollment requirement (docs/spec/15-baselines-and-config.md "Baselines at enrollment"): every approval carries a
// baseline decision, checked by the contract before anything else; "inherited" needs an approved baseline that applies; "attach" makes an
// approved baseline the site's; "capture" turns the cabinet's first full report into the site's baseline draft, which is approved through
// the usual review with its two-person rule. Until a baseline is in force the cabinet says "Baseline required", on its condition and in
// the fleet lists. Through the real console routes on a real SQL Server.
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
import { captureForEnrollment } from "../src/services/baselines.js";
import { configHash, type Item } from "../src/services/config-canonical.js";
import { ingestAndEvaluate } from "../src/services/config-service.js";
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
let ada: Account, bo: Account, tier2: Account, tier1: Account;

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  [ada, bo, tier2, tier1] = [await h.account("admin"), await h.account("admin"), await h.account("tier2"), await h.account("tier1")];
});
test.after(async () => { await reevaluationsSettled(); await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

async function pending(): Promise<string> {
  const { token } = await createBootstrapToken(db.app, ada.id);
  return submitEnrollment(db.app, {
    csr: csrFor(ecKey()), bootstrapToken: token,
    fingerprints: { hostname: "CAB-" + randomBytes(2).toString("hex"), serialNumber: "SN-" + randomBytes(3).toString("hex"), macAddresses: [],
      provisionedClient: null, provisionedSite: null, onlineSince: "2026-10-06T08:00:00Z", osVersion: "Windows 11", agentVersion: "0.2.0" },
  }, "10.77.0.9");
}

/** Approves through the console route with a step-up token bound to exactly this body. */
async function approve(requestId: string, body: Record<string, unknown>, who: Account = ada) {
  const stepUpToken = await h.codeToken(who, "enrollment.approve", requestId, body);
  return call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...body, stepUpToken }, who);
}
const status = async (requestId: string) => (await db.app.query<{ status: string }>("SELECT status FROM enrollment_requests WHERE id = $1", [requestId])).rows[0]!.status;
const condition = async (cabinetId: string) => (await call("GET", `/api/cabinets/${cabinetId}/condition`, undefined, tier1)).body;

/** A baseline approved by two people through the real routes. */
async function approvedBaseline(scope: { kind: string; id: string | null }, items: unknown[]): Promise<string> {
  const draft = await call("POST", "/api/baselines/drafts", { scope, description: "For the test", content: { items } }, ada);
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const id = draft.body.id as string;
  assert.equal((await call("POST", `/api/baselines/versions/${id}/propose`, {}, ada)).status, 200);
  const note = "Reviewed in the test.";
  const r = await call("POST", `/api/baselines/versions/${id}/approve`, { note, stepUpToken: await h.codeToken(bo, "baseline.approve", id, { note }) }, bo);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await reevaluationsSettled();
  return id;
}
const ITEMS = [{ category: "services", key: "service:W32Time", mode: "match", expect: { startType: "automatic" } }];

/** One full first report: every category a site baseline uses, in two uploads (an agent sends at most eight snapshots at a time). */
function report(): { first: never; second: never } {
  const it = (key: string, values: Record<string, unknown>) => ({ key, values }) as Item;
  const now = new Date().toISOString();
  const s = (category: string, items: Item[]) => ({ observedAt: now, category, hash: configHash(items), truncated: false, items }) as never;
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
  ];
  return { first: all.slice(0, 8) as never, second: all.slice(8) as never };
}

test("the contract refuses an approval without a baseline decision, or with a malformed one, before anything else runs", async () => {
  const requestId = await pending();
  const base = { client: "Kilo Health", site: "North", cabinet: "ICU 1", role: "standalone" };
  const hostile: unknown[] = [undefined, null, "capture", 1, [], {}, { use: "skip" }, { use: "attach" }, { use: "attach", versionId: "1' OR '1'='1" },
    { use: "capture", versionId: randomUUID() }, { use: "inherited", extra: true }, { use: "INHERITED" }, { use: "attach", versionId: randomUUID(), why: "<script>" }];
  for (const baseline of hostile) {
    const body = baseline === undefined ? base : { ...base, baseline };
    // The contract is checked before the step-up token is even looked at.
    const r = await call("POST", `/api/admin/enrollments/${requestId}/approve`, { ...body, stepUpToken: "A".repeat(43) }, ada);
    assert.equal(r.status, 400, `${JSON.stringify(baseline)} → ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalid_request");
  }
  assert.equal(await status(requestId), "pending", "nothing was approved");
});

test("\"use the baseline in force\" is refused when none applies, and accepted when the client has one", async () => {
  const requestId = await pending();
  const body = { client: "Lima Health", site: "East", cabinet: "ICU 1", role: "standalone", baseline: { use: "inherited" } };
  const r = await approve(requestId, body);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, "no_approved_baseline");
  assert.match(String(r.body.reason), /attach to the site, or capture/);
  assert.equal(await status(requestId), "pending");
  assert.equal((await db.app.query("SELECT 1 AS x FROM clients WHERE name = 'Lima Health'")).rows.length, 0, "the refused approval created no client");

  // The client gets an approved baseline; the same approval now passes and the cabinet is judged against it.
  const client = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Lima Health')", [client]);
  await approvedBaseline({ kind: "client", id: client }, ITEMS);
  const preview = await call("GET", `/api/admin/enrollments/${requestId}/baseline?client=Lima%20Health&site=East`, undefined, ada);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.inForce.map((o: { kind: string }) => o.kind), ["client"]);
  assert.equal(preview.body.siteHasOwn, false);

  const ok = await approve(requestId, body);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.baseline.decision, "inherited");
  assert.deepEqual(ok.body.baseline.inForce.map((o: { kind: string }) => o.kind), ["client"]);
  const c = await condition(ok.body.cabinetId);
  assert.equal(c.baseline.inForce, true);
  assert.equal(c.baseline.enrollment.decision, "inherited");
  const audit = (await db.app.query<{ details: { baseline: { use: string } } }>("SELECT details FROM audit_log WHERE action = 'enrollment.approve' AND target_id = $1", [ok.body.cabinetId])).rows[0]!;
  assert.deepEqual(audit.details.baseline, { use: "inherited" }, "the decision is in the audit entry");
});

test("attaching an approved baseline makes it the site's; a draft, an unknown version or a site with its own baseline is refused", async () => {
  const other = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Template Client')", [other]);
  const source = await approvedBaseline({ kind: "client", id: other }, ITEMS);

  // A draft that was never approved cannot be attached; neither can a version that does not exist.
  const draft = await call("POST", "/api/baselines/drafts", { scope: { kind: "client", id: other }, description: "Not approved", content: { items: ITEMS } }, tier2);
  assert.equal(draft.status, 201);
  for (const versionId of [draft.body.id, randomUUID()]) {
    const requestId = await pending();
    const r = await approve(requestId, { client: "Mike Health", site: "North", cabinet: "ICU 1", role: "standalone", baseline: { use: "attach", versionId } });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "not_approved");
    assert.equal(await status(requestId), "pending");
  }

  const ok = await approve(await pending(), { client: "Mike Health", site: "North", cabinet: "ICU 1", role: "standalone", baseline: { use: "attach", versionId: source } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.baseline.inForce.map((o: { kind: string }) => o.kind), ["site"]);
  const site = (await db.app.query<{ site_id: string }>("SELECT site_id FROM cabinets WHERE id = $1", [ok.body.cabinetId])).rows[0]!.site_id.toLowerCase();
  const attached = (await db.app.query<{ status: string; origin: { kind: string; versionId: string }; decided_by: string }>(
    "SELECT v.status, v.origin, v.decided_by FROM baseline_versions v JOIN baselines b ON b.id = v.baseline_id WHERE b.scope_kind = 'site' AND b.scope_id = $1", [site])).rows;
  assert.equal(attached.length, 1);
  assert.equal(attached[0]!.status, "approved");
  assert.equal(attached[0]!.origin.kind, "attach");
  assert.equal(attached[0]!.origin.versionId, source);
  assert.equal(attached[0]!.decided_by.toLowerCase(), ada.id.toLowerCase());
  assert.equal(Number((await db.app.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'baseline.attach'")).rows[0]!.n), 1, "the attachment is audited");
  assert.equal((await condition(ok.body.cabinetId)).baseline.inForce, true);

  // The site has its own baseline now: attaching another is refused (the one in force applies), "inherited" is accepted.
  const again = await approve(await pending(), { client: "Mike Health", site: "North", cabinet: "ICU 2", role: "standalone", baseline: { use: "attach", versionId: source } });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error, "site_has_baseline");
  const inherited = await approve(await pending(), { client: "Mike Health", site: "North", cabinet: "ICU 2", role: "standalone", baseline: { use: "inherited" } });
  assert.equal(inherited.status, 200, JSON.stringify(inherited.body));
});

test("capture: the cabinet shows Baseline required, its full first report becomes the site's draft, and only another Admin's approval puts it in force", async () => {
  const requestId = await pending();
  const ok = await approve(requestId, { client: "November Health", site: "North", cabinet: "ICU 1", role: "sync", baseline: { use: "capture" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.baseline.captureWaiting, true);
  const cabinetId = ok.body.cabinetId as string;

  let c = await condition(cabinetId);
  assert.equal(c.baseline.inForce, false, "Baseline required");
  assert.equal(c.baseline.enrollment.captureState, "waiting");
  const siteId = (await db.app.query<{ site_id: string }>("SELECT site_id FROM cabinets WHERE id = $1", [cabinetId])).rows[0]!.site_id;
  const list = await call("GET", `/api/fleet/sites/${siteId}`, undefined, tier1);
  assert.equal(list.body.cabinets.find((k: { id: string }) => k.id.toLowerCase() === cabinetId.toLowerCase()).baselineRequired, true, "the fleet list says so too");
  assert.equal(await captureForEnrollment(db.app, cabinetId), null, "nothing to capture before the cabinet reports");

  // Part of the first report: still waiting, no draft.
  const { first, second } = report();
  await ingestAndEvaluate(db.app, cabinetId, first, "agent");
  c = await condition(cabinetId);
  assert.equal(c.baseline.enrollment.captureState, "waiting");
  assert.equal(c.baseline.enrollment.categoriesReported, 8);
  assert.equal(c.baseline.enrollment.categoriesNeeded, 10);
  const drafts = async () => (await db.app.query<{ id: string; status: string; created_by: string; origin: { kind: string; enrollment?: boolean } }>(
    "SELECT v.id, v.status, v.created_by, v.origin FROM baseline_versions v JOIN baselines b ON b.id = v.baseline_id WHERE b.scope_kind = 'site' AND b.scope_id = $1", [siteId.toLowerCase()])).rows;
  assert.equal((await drafts()).length, 0);

  // The rest of it: the draft appears, once, in the approver's name, and the cabinet is still "Baseline required".
  await Promise.all([ingestAndEvaluate(db.app, cabinetId, second, "agent"), captureForEnrollment(db.app, cabinetId)]);
  await captureForEnrollment(db.app, cabinetId);
  const made = await drafts();
  assert.equal(made.length, 1, "exactly one draft, even with two uploads at once");
  assert.equal(made[0]!.status, "draft");
  assert.equal(made[0]!.created_by.toLowerCase(), ada.id.toLowerCase());
  assert.equal(made[0]!.origin.kind, "capture");
  assert.equal(made[0]!.origin.enrollment, true);
  c = await condition(cabinetId);
  assert.equal(c.baseline.inForce, false, "a draft is never in force");
  assert.equal(c.baseline.enrollment.captureState, "drafted");
  assert.equal(c.baseline.enrollment.draftVersionId.toLowerCase(), made[0]!.id.toLowerCase());
  const version = await call("GET", `/api/baselines/versions/${made[0]!.id}`, undefined, tier1);
  assert.ok(version.body.content.items.some((i: { key: string }) => i.key === "service:W32Time"));
  assert.ok(!version.body.content.items.some((i: { category: string }) => i.category === "devices"), "a site baseline does not start with devices");

  // The usual review: proposed, then the approver who asked for it may not approve it while another Admin exists.
  const id = made[0]!.id;
  assert.equal((await call("POST", `/api/baselines/versions/${id}/propose`, {}, ada)).status, 200);
  const note = "Checked against the cabinet.";
  const own = await call("POST", `/api/baselines/versions/${id}/approve`, { note, stepUpToken: await h.codeToken(ada, "baseline.approve", id, { note }) }, ada);
  assert.equal(own.status, 403);
  assert.equal(own.body.error, "own_proposal");
  const second2 = await call("POST", `/api/baselines/versions/${id}/approve`, { note, stepUpToken: await h.codeToken(bo, "baseline.approve", id, { note }) }, bo);
  assert.equal(second2.status, 200, JSON.stringify(second2.body));
  await reevaluationsSettled();
  c = await condition(cabinetId);
  assert.equal(c.baseline.inForce, true, "approved: the baseline is in force");
  const after = await call("GET", `/api/fleet/sites/${siteId}`, undefined, tier1);
  assert.equal(after.body.cabinets[0].baselineRequired, false);
});

test("a cabinet approved with no decision (the server's own callers) shows Baseline required until one applies", async () => {
  const { approveEnrollment } = await import("../src/services/enrollment.js");
  const r = await approveEnrollment(db.app, await developmentIssuingKey(tempDir()), await pending(), { clientName: "Oscar Health", siteName: "North", cabinetName: "ICU 1", role: "standalone" }, ada.id);
  assert.equal(r.baseline.decision, null);
  const c = await condition(r.cabinetId);
  assert.equal(c.baseline.inForce, false);
  assert.equal(c.baseline.enrollment, null);
});

test("only an Admin previews or approves, and the preview's query is checked against its contract", async () => {
  const requestId = await pending();
  for (const who of [tier1, tier2]) {
    const p = await call("GET", `/api/admin/enrollments/${requestId}/baseline?client=A&site=B`, undefined, who);
    assert.equal(p.status, 403, JSON.stringify(p.body));
  }
  for (const q of ["client=A", "client=A&site=%3Cscript%3E", "client=A&site=B&role=sync", "client=&site=B", "client=A%07&site=B", `client=${"x".repeat(129)}&site=B`]) {
    const p = await call("GET", `/api/admin/enrollments/${requestId}/baseline?${q}`, undefined, ada);
    assert.equal(p.status, 400, `${q} → ${JSON.stringify(p.body)}`);
  }
  const notPending = await call("GET", `/api/admin/enrollments/${randomUUID()}/baseline?client=A&site=B`, undefined, ada);
  assert.equal(notPending.status, 409);
  const p = await call("GET", `/api/admin/enrollments/${requestId}/baseline?client=New%20Client&site=North`, undefined, ada);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.ok(Array.isArray(p.body.choices) && p.body.choices.every((c: { versionId: string }) => typeof c.versionId === "string"));
  assert.ok(JSON.stringify(p.body).length < 20_000, "the preview stays small");
  const tier2Approve = await call("POST", `/api/admin/enrollments/${requestId}/approve`, { client: "A", site: "B", cabinet: "C", role: "standalone", baseline: { use: "capture" }, stepUpToken: "A".repeat(43) }, tier2);
  assert.equal(tier2Approve.status, 403);
});
