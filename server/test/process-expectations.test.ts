// Process expectations (F7, decision-log D142, D155): a baseline item says a program must be running, optionally within a CPU and memory
// ceiling, or must not be running. It is judged against the cabinet's latest stored processes.list answer, never by a command of its
// own; each difference carries the time of that answer; with no answer the item is unknown. A miss is a difference from the baseline,
// counts in the Differences view, and degrades the health when the item is required. It is never an alert.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { reevaluationsSettled } from "../src/console-api/baseline-routes.js";
import { ResultStream } from "../src/console-api/stream.js";
import { consoleBodies } from "../src/contracts.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { computeDrift, processAnswer } from "../src/services/baseline-drift.js";
import { checkContent, type Origin, type ResolvedItem } from "../src/services/baselines.js";
import { configHash, type Item } from "../src/services/config-canonical.js";
import { ingestAndEvaluate } from "../src/services/config-service.js";
import { issueCommand, storeResult, takeQueuedCommands } from "../src/services/commands.js";
import { ConsoleHarness, ORIGIN, type Account } from "./console-harness.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

// ---- The judgement itself ----------------------------------------------------------------------------------------------------

const origin: Origin = { kind: "role", id: "sync", name: "Sync cabinets", baselineId: "b", versionId: "v", version: 1 };
const item = (over: Partial<ResolvedItem>): ResolvedItem =>
  ({ category: "processes", key: "process:SyncService.exe", mode: "present", expect: null, required: true, severity: "major", note: null, origin, ...over });
const proc = (name: string, cpuPercent: number, mb: number) => ({ name, cpuPercent, workingSetBytes: mb * 1_048_576 });
const at = "2026-11-26T08:00:00.000Z";
const judged = (...ps: ReturnType<typeof proc>[]) => processAnswer(at, { processes: ps });
const none = new Map<string, Item[]>();

test("a program that must run: missing is a difference with the answer's time, running is none, and the name matches whatever its case", () => {
  assert.deepEqual(computeDrift([item({})], none, judged(proc("explorer.exe", 1, 80))).map(r => [r.mode, r.field, r.expected, r.actual]),
    [["present", "", true, { running: false, takenAt: at }]]);
  assert.deepEqual(computeDrift([item({})], none, judged(proc("SYNCSERVICE.EXE", 3, 200))), []);
  assert.deepEqual(computeDrift([item({ key: "process:syncservice.exe" })], none, judged(proc("SyncService.exe", 3, 200))), []);
});

test("limits are judged on every running instance added together, each limit its own difference", () => {
  const limited = item({ limits: { cpuPercent: 25, workingSetMb: 1024 } });
  assert.deepEqual(computeDrift([limited], none, judged(proc("SyncService.exe", 10, 400))), [], "within both");
  const two = computeDrift([limited], none, judged(proc("SyncService.exe", 15, 600), proc("syncservice.exe", 15.04, 600)));
  assert.deepEqual(two.map(r => [r.field, r.expected, r.actual]),
    [["cpuPercent", { atMost: 25 }, { value: 30, takenAt: at }], ["workingSetMb", { atMost: 1024 }, { value: 1200, takenAt: at }]]);
  assert.ok(two.every(r => r.mode === "match" && r.required && r.severity === "major"));
  assert.deepEqual(computeDrift([item({ limits: { cpuPercent: 25 } })], none, judged(proc("SyncService.exe", 25, 9999))), [], "at the limit is within it; no memory limit set");
});

test("a program that must not run, and a process item with no stored answer, which is unknown and never a difference", () => {
  const banned = item({ key: "process:TeamViewer.exe", mode: "absent", required: false, severity: "minor" });
  assert.deepEqual(computeDrift([banned], none, judged(proc("TeamViewer.exe", 0, 30))).map(r => [r.mode, r.actual]), [["absent", { running: true, takenAt: at }]]);
  assert.deepEqual(computeDrift([banned], none, judged()), []);
  assert.deepEqual(computeDrift([item({}), banned], none, null), [], "no answer: unknown");
});

test("the contract and the content check: a process item is keyed process:, takes only present, absent or ignore, and limits only when present", () => {
  const ok = { items: [{ category: "processes", key: "process:SyncService.exe", mode: "present", limits: { cpuPercent: 25 } }] };
  const draft = (content: unknown) => consoleBodies.baselineDraft.is({ scope: { kind: "role", id: "sync" }, description: "Process expectations for the sync role.", content });
  assert.equal(draft(ok), true);
  for (const bad of [
    { category: "processes", key: "service:Sync", mode: "present" },
    { category: "processes", key: "process:Sync.exe", mode: "match", expect: { cpuPercent: 1 } },
    { category: "processes", key: "process:Sync.exe", mode: "absent", limits: { cpuPercent: 1 } },
    { category: "services", key: "service:Spooler", mode: "present", limits: { cpuPercent: 1 } },
    { category: "processes", key: "process:Sync.exe", mode: "present", limits: { cpuPercent: 101 } },
    { category: "processes", key: "process:Sync.exe", mode: "present", limits: { workingSetMb: "1024; DROP TABLE cabinets" } },
    { category: "processes", key: "process:<script>", mode: "present" },
    { category: "processes", key: "process:Sync.exe\u0000", mode: "present" },
  ]) assert.equal(draft({ items: [bad] }), false, JSON.stringify(bad));
  assert.doesNotThrow(() => checkContent(ok as never));
  assert.throws(() => checkContent({ items: [{ category: "processes", key: "process:", mode: "present" }] } as never), /does not belong/);
  assert.throws(() => checkContent({ items: [{ category: "processes", key: "process:Sync.exe", mode: "present" }, { category: "processes", key: "process:SYNC.EXE", mode: "absent" }] } as never),
    /listed twice/, "the same program in another case is the same item");
});

// ---- Through a stored answer, on a real SQL Server --------------------------------------------------------------------------

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);
const call = h.call.bind(h);
let ada: Account, bo: Account, tier1: Account;

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  [ada, bo, tier1] = [await h.account("admin"), await h.account("admin"), await h.account("tier1")];
});
test.after(async () => { await reevaluationsSettled(); await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

/** A role baseline approved by two people through the real routes. */
async function approvedRoleBaseline(role: string, items: unknown[]): Promise<void> {
  const draft = await call("POST", "/api/baselines/drafts", { scope: { kind: "role", id: role }, description: "Process expectations", content: { items } }, ada);
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const id = draft.body.id as string;
  assert.equal((await call("POST", `/api/baselines/versions/${id}/propose`, {}, ada)).status, 200);
  const note = "Reviewed in the test.";
  const r = await call("POST", `/api/baselines/versions/${id}/approve`, { note, stepUpToken: await h.codeToken(bo, "baseline.approve", id, { note }) }, bo);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await reevaluationsSettled();
}

/** A sync cabinet that has reported its services, so it has a configuration and a baseline in force. */
async function syncCabinet(): Promise<string> {
  const client = randomUUID(), site = randomUUID(), k = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 6)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, last_heartbeat_at) VALUES ($1, $2, $3, 'sync', 'active', SYSUTCDATETIME())", [k, site, `K-${k.slice(0, 6)}`]);
  const items = [{ key: "service:Spooler", values: { state: "running", startType: "automatic" } }] as Item[];
  await ingestAndEvaluate(db.app, k, [{ observedAt: new Date().toISOString(), category: "services", hash: configHash(items), truncated: false, items }] as never, "agent");
  return k;
}

async function answer(k: string, processes: ReturnType<typeof proc>[]): Promise<void> {
  const cmd = await issueCommand(db.app, ada.id, k, "processes.list", {});
  await takeQueuedCommands(db.app, k);
  const full = processes.map((p, i) => ({ processId: 100 + i, executablePath: null, privateBytes: p.workingSetBytes, threads: 4, handles: 50, startTime: null, sessionId: 0, account: null, ...p }));
  await storeResult(db.app, k, { commandId: cmd.commandId, status: "succeeded", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    output: { processes: full, sampleMilliseconds: 1000, truncated: false } } as never);
}
const drift = async (k: string) => (await call("GET", `/api/cabinets/${k}/drift`, undefined, tier1)).body as { drift: { category: string; itemKey: string; field: string; actual: { takenAt?: string } }[] };
const health = async (k: string) => (await db.app.query<{ state: string }>("SELECT state FROM cabinet_health WHERE cabinet_id = $1", [k])).rows[0]?.state;

test("a stored answer is judged when it arrives: a missing program is a difference that degrades the health, shows in the Differences view, and clears on the next answer, never an alert", async () => {
  await approvedRoleBaseline("sync", [
    { category: "processes", key: "process:SyncService.exe", mode: "present", required: true, severity: "major", limits: { cpuPercent: 25 } },
    { category: "services", key: "service:Spooler", mode: "match", expect: { startType: "automatic" } },
  ]);
  const k = await syncCabinet();
  assert.deepEqual((await drift(k)).drift, [], "no processes answer yet: unknown, not a difference");
  assert.equal(await health(k), "healthy");

  await answer(k, [proc("explorer.exe", 1, 80)]);
  const missing = (await drift(k)).drift;
  assert.deepEqual(missing.map(d => [d.category, d.itemKey, d.field]), [["processes", "process:SyncService.exe", ""]]);
  assert.ok(missing[0]!.actual.takenAt, "the difference says when the answer was taken");
  assert.equal(await health(k), "degraded", "a required process that is not running");
  const groups = (await call("GET", "/api/fleet/differences?role=sync", undefined, tier1)).body as { groups: { category: string; itemKey: string; cabinets: number }[] };
  assert.ok(groups.groups.some(g => g.category === "processes" && g.itemKey === "process:SyncService.exe" && g.cabinets >= 1), JSON.stringify(groups));
  const group = await call("GET", "/api/fleet/differences/group?category=processes&itemKey=process%3ASyncService.exe&role=sync", undefined, tier1);
  assert.equal(group.status, 200, JSON.stringify(group.body));
  assert.ok((group.body.cabinets as { id: string }[]).some(c => c.id.toLowerCase() === k), "the cabinet is listed in the group");

  await answer(k, [proc("syncservice.exe", 40, 300)]);
  assert.deepEqual((await drift(k)).drift.map(d => [d.itemKey, d.field]), [["process:SyncService.exe", "cpuPercent"]], "running, but over its CPU limit");

  await answer(k, [proc("SyncService.exe", 5, 300)]);
  assert.deepEqual((await drift(k)).drift, [], "within its limit: the difference clears");
  assert.equal(await health(k), "healthy");
  assert.equal((await db.app.query("SELECT 1 FROM alerts WHERE cabinet_id = $1", [k])).rowCount, 0, "a process difference never raises an alert");
});
