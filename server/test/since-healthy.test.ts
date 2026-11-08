// "What changed since it was healthy" in one route (F8.R4, decision-log D44): health, drift, the comparison with the healthy mark, and the
// configuration changes since the mark ranked by how close they are to the moment the problem was first observed: the closest first, and
// at an equal distance the one before ahead of the one after. Through the real configuration ingest and the real console route.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { configHash, type Item } from "../src/services/config-canonical.js";
import { ingestConfig } from "../src/services/config-ingest.js";
import { rankChanges, type RankedChange } from "../src/services/since-healthy.js";
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
let t1: Account;
let siteId: string;

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  t1 = await h.account("tier1");
  const clientId = randomUUID();
  siteId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour')", [clientId]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [siteId, clientId]);
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

const MIN = 60_000;
const base = Date.now() - 6 * 3_600_000;
const at = (minutes: number) => new Date(base + minutes * MIN);
const svc = (name: string, startType = "automatic"): Item => ({ key: `service:${name}`, values: { startType, state: "running" } as Item["values"] });
const snap = (items: Item[], minutes: number) => ({ observedAt: at(minutes).toISOString(), category: "services", hash: configHash(items), truncated: false, items }) as never;

async function newCabinet() {
  const id = randomUUID();
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, $3, 'standalone', 'active', SYSUTCDATETIME())", [id, siteId, `K ${id.slice(0, 6)}`]);
  return id;
}
/** A healthy mark at `minutes`, and the cabinet's health as the evaluation leaves it: `state`, first observed at `problemAt` when not healthy. */
async function judged(cabinetId: string, minutes: number, state: "healthy" | "degraded", problemAt: number | null) {
  const versions = Object.fromEntries((await db.app.query<{ category: string; version_id: string }>(
    "SELECT category, version_id FROM config_current WHERE cabinet_id = $1", [cabinetId])).rows.map(r => [r.category, Number(r.version_id)]));
  const mark = (await db.app.query<{ id: string }>("INSERT INTO healthy_marks (cabinet_id, marked_at, versions) OUTPUT inserted.id VALUES ($1, $2, $3)",
    [cabinetId, at(minutes), JSON.stringify(versions)])).rows[0]!.id;
  await db.app.query(`INSERT INTO cabinet_health (cabinet_id, state, evaluated_at, since, reasons, last_healthy_at, last_mark_id, degraded_since)
    VALUES ($1, $2, SYSUTCDATETIME(), SYSUTCDATETIME(), '[]', $3, $4, $5)`, [cabinetId, state, at(minutes), mark, problemAt === null ? null : at(problemAt)]);
}
async function since(cabinetId: string) {
  const r = await call("GET", `/api/cabinets/${cabinetId}/since-healthy`, undefined, t1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

test("one answer: health, drift, the comparison with the mark, and the changes since ranked by closeness to the problem, the one before first on a tie", async () => {
  const k = await newCabinet();
  await ingestConfig(db.app, k, [snap([svc("A"), svc("B"), svc("C")], 0)], "agent");
  await ingestConfig(db.app, k, [snap([svc("A"), svc("B"), svc("C")], 5)], "agent");
  // The healthy mark was made at minute 5, and the problem was first observed at minute 30. Changes at 10, 25 and 35.
  await db.app.query("DELETE FROM cabinet_health WHERE cabinet_id = $1", [k]);
  await judged(k, 5, "degraded", 30);
  await ingestConfig(db.app, k, [snap([svc("A", "manual"), svc("B"), svc("C")], 10)], "agent");
  await ingestConfig(db.app, k, [snap([svc("A", "manual"), svc("B", "manual"), svc("C")], 25)], "agent");
  await ingestConfig(db.app, k, [snap([svc("A", "manual"), svc("B", "manual"), svc("C", "manual")], 35)], "agent");
  const r = await since(k);
  assert.equal(r.health.state, "degraded");
  assert.equal(r.health.problemFirstObserved, at(30).toISOString());
  assert.deepEqual(r.drift, [], "no baseline, so no drift: still part of the one answer");
  assert.deepEqual(r.sinceMark.changes.map((c: { key: string }) => c.key).sort(), ["service:A", "service:B", "service:C"]);
  assert.deepEqual(r.changes.map((c: { key: string; minutesFromProblem: number }) => [c.key, c.minutesFromProblem]),
    [["service:B", -5], ["service:C", 5], ["service:A", -20]]);
  assert.equal(r.changesFrom, at(5).toISOString());
});

test("a healthy cabinet has no problem to measure from: its changes since the mark are newest first; an unknown cabinet is not found", async () => {
  const k = await newCabinet();
  await ingestConfig(db.app, k, [snap([svc("A"), svc("B")], 0)], "agent");
  await judged(k, 1, "healthy", null);
  await ingestConfig(db.app, k, [snap([svc("A", "manual"), svc("B")], 10)], "agent");
  await ingestConfig(db.app, k, [snap([svc("A", "manual"), svc("B", "manual")], 20)], "agent");
  const r = await since(k);
  assert.equal(r.health.problemFirstObserved, null);
  assert.deepEqual(r.changes.map((c: { key: string; minutesFromProblem: number | null }) => [c.key, c.minutesFromProblem]), [["service:B", null], ["service:A", null]]);
  assert.equal((await call("GET", `/api/cabinets/${randomUUID()}/since-healthy`, undefined, t1)).status, 404);
  assert.equal((await call("GET", `/api/cabinets/${k}/since-healthy`, undefined)).status, 401);
});

test("the ranking on its own: distance first, before ahead of after on a tie, newest first with no problem", () => {
  const c = (key: string, m: number | null, at = "2026-11-08T10:00:00.000Z"): RankedChange =>
    ({ category: "services", key, change: "changed", fields: {}, at, notBefore: null, exact: true, viaPlatform: false, violatesBaseline: false, minutesFromProblem: m });
  assert.deepEqual(rankChanges([c("far", -90), c("after", 3), c("before", -3), c("near", 1)]).map(x => x.key), ["near", "before", "after", "far"]);
  assert.deepEqual(rankChanges([c("old", null, "2026-11-08T09:00:00.000Z"), c("new", null, "2026-11-08T11:00:00.000Z")]).map(x => x.key), ["new", "old"]);
});
