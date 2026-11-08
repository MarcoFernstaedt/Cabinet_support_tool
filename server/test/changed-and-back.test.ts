// "Changed since healthy" sees what the end state hides (F8.R3, decision-log D42). The comparison with the last healthy mark reads the
// two snapshots item by item, so a value that changed and changed back, or a category that returned to the marked version, showed
// nothing. The change records since the mark are now read too: an item they name that matches the mark again is listed with how many
// times it changed. Through the real configuration ingest and the real console route on a real SQL Server.
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
const at = (minutes: number) => new Date(base + minutes * MIN).toISOString();
const svc = (name: string, startType = "automatic", state = "running"): Item => ({ key: `service:${name}`, values: { startType, state } as Item["values"] });
const snap = (items: Item[], minutes: number) => ({ observedAt: at(minutes), category: "services", hash: configHash(items), truncated: false, items }) as never;

async function newCabinet() {
  const id = randomUUID();
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, $3, 'standalone', 'active', SYSUTCDATETIME())", [id, siteId, `K ${id.slice(0, 6)}`]);
  return id;
}
/** A healthy mark of what is in force now, made `daysAgo` days ago, and the cabinet's health pointing at it, as the evaluation leaves it. */
async function markNow(cabinetId: string, minutes: number, daysAgo = 0) {
  const versions = Object.fromEntries((await db.app.query<{ category: string; version_id: string }>(
    "SELECT category, version_id FROM config_current WHERE cabinet_id = $1", [cabinetId])).rows.map(r => [r.category, Number(r.version_id)]));
  const markedAt = daysAgo > 0 ? new Date(Date.now() - daysAgo * 86_400_000).toISOString() : at(minutes);
  const id = (await db.app.query<{ id: string }>("INSERT INTO healthy_marks (cabinet_id, marked_at, versions) OUTPUT inserted.id VALUES ($1, $2, $3)",
    [cabinetId, markedAt, JSON.stringify(versions)])).rows[0]!.id;
  await db.app.query("INSERT INTO cabinet_health (cabinet_id, state, evaluated_at, since, reasons, last_healthy_at, last_mark_id) VALUES ($1, 'degraded', SYSUTCDATETIME(), SYSUTCDATETIME(), '[]', $2, $3)",
    [cabinetId, markedAt, id]);
}
async function compare(cabinetId: string) {
  const r = await call("GET", `/api/cabinets/${cabinetId}/compare-healthy`, undefined, t1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { changes: { category: string; key: string }[]; changedAndBack: { category: string; key: string; changes: number; lastAt: string }[]; interimComplete: boolean };
}

test("a service that changed and changed back since the healthy mark is listed, though the category is back at the marked version", async () => {
  const k = await newCabinet();
  await ingestConfig(db.app, k, [snap([svc("Spooler"), svc("W32Time")], 0)], "agent");
  await markNow(k, 1);
  await ingestConfig(db.app, k, [snap([svc("Spooler", "disabled", "stopped"), svc("W32Time")], 10)], "agent");
  await ingestConfig(db.app, k, [snap([svc("Spooler"), svc("W32Time")], 20)], "agent");
  const r = await compare(k);
  assert.deepEqual(r.changes, [], "the end state is the marked state");
  assert.deepEqual(r.changedAndBack.map(c => [c.category, c.key, c.changes]), [["services", "service:Spooler", 2]]);
  assert.equal(r.changedAndBack[0]!.lastAt, at(20));
  assert.equal(r.interimComplete, true);
});

test("an item that changed and stayed changed is in the end-state list only; one that came and went beside it is in the other", async () => {
  const k = await newCabinet();
  await ingestConfig(db.app, k, [snap([svc("Spooler"), svc("W32Time"), svc("BioScanSvc")], 0)], "agent");
  await markNow(k, 1);
  await ingestConfig(db.app, k, [snap([svc("Spooler", "manual"), svc("W32Time", "disabled", "stopped"), svc("BioScanSvc")], 10)], "agent");
  await ingestConfig(db.app, k, [snap([svc("Spooler", "manual"), svc("W32Time"), svc("BioScanSvc")], 20)], "agent");
  const r = await compare(k);
  assert.deepEqual(r.changes.map(c => c.key), ["service:Spooler"]);
  assert.deepEqual(r.changedAndBack.map(c => c.key), ["service:W32Time"]);
});

test("a mark older than change records are kept says the in-between list may be missing changes; no mark has none", async () => {
  const k = await newCabinet();
  await ingestConfig(db.app, k, [snap([svc("Spooler")], 0)], "agent");
  await markNow(k, 1, 120);
  assert.equal((await compare(k)).interimComplete, false, "the default keeps change records 90 days");
  const none = await newCabinet();
  const r = await compare(none);
  assert.deepEqual([r.changes, r.changedAndBack, r.interimComplete], [[], [], true]);
});
