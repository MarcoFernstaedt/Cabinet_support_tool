// Configuration snapshots, baselines, change detection, drift, health and the last known healthy state
// (docs/spec/15-baselines-and-config.md), through the real services and console routes on a real SQL Server.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import { buildConsoleApi } from "../src/console-api/server.js";
import { reevaluationsSettled } from "../src/console-api/baseline-routes.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { SecretBox } from "../src/auth/secrets.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { canonicalItems, configHash, valueText, type Item } from "../src/services/config-canonical.js";
import { diffItems } from "../src/services/config-diff.js";
import { ingestAndEvaluate } from "../src/services/config-service.js";
import { KEEP_VERSIONS, packItems, unpackItems, verifySnapshot, keyBelongs } from "../src/services/config-ingest.js";
import { evaluateHealth, judge, sweepHealth } from "../src/services/cabinet-health.js";
import { computeDrift } from "../src/services/baseline-drift.js";
import { diffContent } from "../src/services/baselines.js";
import { issueCommand, storeResult, takeQueuedCommands } from "../src/services/commands.js";
import { ConsoleHarness, ORIGIN, type Account } from "./console-harness.js";
import { asOwner, createTestDatabase, type TestDatabase } from "./database.js";
import { tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
let feed: NotificationFeed;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);
const account = (role: "tier1" | "tier2" | "admin") => h.account(role);
const call = h.call.bind(h);
const codeToken = h.codeToken.bind(h);

const MIN = 60_000;
const base = Date.now() - 6 * 3_600_000;
const at = (minutes: number) => new Date(base + minutes * MIN).toISOString();
/** Minutes from `base` to now: a look the cabinet made just now (a change right after an approval is only near in time if it is dated like one). */
const nowMin = () => (Date.now() - base) / MIN;
const item = (key: string, values: Record<string, unknown>): Item => ({ key, values: values as Item["values"] });
const snap = (category: string, items: Item[], minutes: number, extra: Record<string, unknown> = {}) =>
  ({ observedAt: at(minutes), category, hash: configHash(items), truncated: false, items, ...extra }) as any;
const eth = (dns: string[] = ["10.21.4.10", "10.21.4.11"], address = "10.21.4.25/24") => item("adapter:Ethernet", { dhcp: true, addresses: [address], gateways: ["10.21.4.1"], dnsServers: dns, dnsAutomatic: false, interfaceIndex: 12 });
const svc = (name: string, startType = "automatic", state = "running") => item(`service:${name}`, { startType, state });
const hardware = (model: string) => item("hardware", { manufacturer: "Dell Inc.", model, biosVersion: "1.18.0" });

async function newSite(label = randomUUID().slice(0, 6)) {
  const clientId = randomUUID(), siteId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [clientId, `Client ${label}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [siteId, clientId, `Site ${label}`]);
  return { clientId, siteId };
}
async function newCabinet(siteId: string, name = "Cab " + randomUUID().slice(0, 6), model: string | null = null) {
  const id = randomUUID();
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status, hostname, last_heartbeat_at, model) VALUES ($1, $2, $3, 'satellite', 'active', $4, SYSUTCDATETIME(), $5)",
    [id, siteId, name, name.toUpperCase().replace(/\s/g, "-"), model]);
  return id;
}
const rows = async (sql: string, args: unknown[] = []) => (await db.app.query(sql, args)).rows as any[];
const count = async (sql: string, args: unknown[] = []) => Number((await rows(sql, args))[0].n);

/** A baseline made, proposed and approved by two people through the real routes. */
async function approve(author: Account, approver: Account, scope: unknown, content: unknown, description = "Approved for the test") {
  const draft = await call("POST", "/api/baselines/drafts", { scope, description, content }, author);
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const id = draft.body.id as string;
  assert.equal((await call("POST", `/api/baselines/versions/${id}/propose`, {}, author)).status, 200);
  const note = "Reviewed and approved in the test.";
  const r = await call("POST", `/api/baselines/versions/${id}/approve`, { note, stepUpToken: await codeToken(approver, "baseline.approve", id, { note }) }, approver);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await reevaluationsSettled();
  return id;
}

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

// ---- The fingerprint, the diff and the stored form ---------------------------------------------------------------------------

test("the hash matches the vectors the agent checks too, whatever the order of items or values", () => {
  const vectors = JSON.parse(readFileSync(join(dirname(SCHEMA_DIR), "vectors", "config-hash-vectors.json"), "utf8")).vectors as { name: string; items: Item[]; hash: string }[];
  assert.ok(vectors.length >= 8);
  for (const v of vectors) assert.equal(configHash(v.items), v.hash, v.name);
  const a = item("service:a", { state: "running", startType: "automatic" }), b = item("service:b", { x: ["q", "p"] });
  assert.equal(configHash([a, b]), configHash([b, item("service:a", { startType: "automatic", state: "running" })]));
  assert.notEqual(configHash([b]), configHash([item("service:b", { x: ["p", "q"] })]), "list order is part of the configuration");
  for (const bad of [1.5, { run: "cmd" }, new Date(), Symbol("x"), undefined === 1 ? 0 : 2 ** 31 + 0.5])
    if (typeof bad !== "number" || !Number.isInteger(bad)) assert.throws(() => canonicalItems([item("service:x", { v: bad })]), TypeError);
  assert.equal(valueText(undefined), "null");
});

test("a diff names added, removed and changed items and only the fields that differ", () => {
  const before = [svc("a"), svc("b"), eth()];
  const after = [svc("a", "disabled"), svc("c"), eth(["8.8.8.8"])];
  const d = diffItems(before, after);
  assert.deepEqual(d.map(x => [x.key, x.change]), [["adapter:Ethernet", "changed"], ["service:a", "changed"], ["service:b", "removed"], ["service:c", "added"]]);
  assert.deepEqual(Object.keys(d[0]!.fields), ["dnsServers"]);
  assert.deepEqual(d[1]!.fields.startType, { before: "automatic", after: "disabled" });
  assert.deepEqual(diffItems(before, before), []);
});

test("items are stored compressed and come back exactly; damaged or bomb-sized storage is an error, never a half reading", () => {
  const items = Array.from({ length: 300 }, (_, i) => svc(`Service ${i}`, "automatic", i % 2 ? "running" : "stopped"));
  const packed = packItems(items);
  assert.ok(packed.length < JSON.stringify(items).length / 3, "a configuration compresses well");
  assert.deepEqual(unpackItems(packed), items);
  assert.throws(() => unpackItems(Buffer.from("not gzip")));
  assert.throws(() => unpackItems(gzipSync(Buffer.from('{"not":"a list"}'))), /not a list/);
  assert.throws(() => unpackItems(gzipSync(Buffer.alloc(40 * 1024 * 1024, 0x20))), /./, "a decompression bomb is stopped at 16 MB");
  assert.equal(keyBelongs("tasks", "startup:HKLM Run/BioScan"), true);
  assert.equal(keyBelongs("system", "hardware"), true);
  assert.equal(keyBelongs("system", "hardwarex"), false);
  assert.equal(keyBelongs("services", "service"), true);
  assert.equal(keyBelongs("hosts", "service:x"), false);
});

// ---- Ingest ------------------------------------------------------------------------------------------------------------

test("the first look is a starting point, a repeat changes nothing but its time, and a change is recorded item by item with its window", async () => {
  const { siteId } = await newSite();
  const cab = await newCabinet(siteId);
  const first = await ingestAndEvaluate(db.app, cab, [snap("services", [svc("BioScanSvc"), svc("Spooler")], 0)], "agent");
  assert.equal(first.first, 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM config_changes WHERE cabinet_id = $1", [cab]), 0, "the first look is not a change");
  const same = await ingestAndEvaluate(db.app, cab, [snap("services", [svc("BioScanSvc"), svc("Spooler")], 10)], "agent");
  assert.equal(same.unchanged, 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM config_versions WHERE cabinet_id = $1", [cab]), 1, "change-only: no new version");
  const changed = await ingestAndEvaluate(db.app, cab, [snap("services", [svc("BioScanSvc", "disabled", "stopped"), svc("Spooler")], 20)], "agent");
  assert.deepEqual(changed.categoriesChanged, ["services"]);
  const [ch] = await rows("SELECT item_key, change, fields, not_before, observed_at, exact_at, via_platform FROM config_changes WHERE cabinet_id = $1", [cab]);
  assert.equal(ch.item_key, "service:BioScanSvc");
  assert.deepEqual(ch.fields.startType, { before: "automatic", after: "disabled" });
  // Between the look at minute 10 (the last that saw the old value) and minute 20: never a precise time it does not have.
  assert.equal(new Date(ch.not_before).toISOString(), at(10));
  assert.equal(new Date(ch.observed_at).toISOString(), at(20));
  assert.equal(ch.exact_at, null);
  assert.equal(ch.via_platform, false);
  assert.equal(await count("SELECT COUNT(*) AS n FROM config_versions WHERE cabinet_id = $1", [cab]), 2);
  // What is stored is the compressed list, and the cabinet's current configuration points at it: nothing is stored twice.
  const [stored] = await rows("SELECT v.items, v.item_count, c.hash FROM config_current c JOIN config_versions v ON v.id = c.version_id WHERE c.cabinet_id = $1 AND c.category = 'services'", [cab]);
  assert.deepEqual(unpackItems(stored.items).map(i => i.key), ["service:BioScanSvc", "service:Spooler"]);
  assert.equal(stored.item_count, 2);
  assert.equal(stored.hash.trim(), configHash([svc("BioScanSvc", "disabled", "stopped"), svc("Spooler")]));
});

test("a snapshot that is not what it claims to be is refused, and a refused batch changes nothing", async () => {
  const { siteId } = await newSite();
  const cab = await newCabinet(siteId);
  const good = snap("services", [svc("A")], 0);
  const wrongHash = { ...snap("time", [item("time", { timeZoneId: "Eastern Standard Time" })], 1), hash: "0".repeat(64) };
  await assert.rejects(ingestAndEvaluate(db.app, cab, [good, wrongHash], "agent"), (e: { code: string }) => e.code === "hash_mismatch");
  assert.equal(await count("SELECT COUNT(*) AS n FROM config_current WHERE cabinet_id = $1", [cab]), 0, "nothing of the batch was stored");
  await assert.rejects(ingestAndEvaluate(db.app, cab, [snap("services", [svc("A"), svc("A")], 0)], "agent"), (e: { code: string }) => e.code === "duplicate_key");
  await assert.rejects(ingestAndEvaluate(db.app, cab, [snap("services", [item("rule:Allow", { enabled: true })], 0)], "agent"), (e: { code: string }) => e.code === "wrong_category");
  assert.throws(() => verifySnapshot(snap("hosts", [item("host:127.0.0.1", { names: ["a"] })], 0, { hash: "f".repeat(64) })));
  // Two uploads for the same cabinet at once (an agent's and a refresh) store one "first" between them, never two.
  const items = [svc("Race")];
  const both = await Promise.allSettled([ingestAndEvaluate(db.app, cab, [snap("services", items, 5)], "agent"), ingestAndEvaluate(db.app, cab, [snap("services", items, 6)], "refresh")]);
  assert.ok(both.every(r => r.status === "fulfilled"), JSON.stringify(both));
  assert.equal(await count("SELECT COUNT(*) AS n FROM config_versions WHERE cabinet_id = $1 AND category = 'services'", [cab]), 1);
});

test("an older look than the one held is ignored; an observation in the future is held to now; a gap and the platform's own changes are recorded", async () => {
  const { siteId } = await newSite();
  const cab = await newCabinet(siteId);
  await ingestAndEvaluate(db.app, cab, [snap("network", [eth()], 30)], "agent");
  const stale = await ingestAndEvaluate(db.app, cab, [snap("network", [eth(["1.1.1.1"])], 10)], "agent");
  assert.equal(stale.stale, 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM config_changes WHERE cabinet_id = $1", [cab]), 0);
  // The platform changed the DNS (a command that succeeded just before the agent looked): the change is marked as made through it.
  const user = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, $2, 'Tech', 'tier2')", [user, "u" + user.slice(0, 8)]);
  await db.app.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result_at) VALUES ($1, $2, 'network.setDns', '{}', $3, $4, $5, 'succeeded', $6)`,
    [randomUUID(), cab, user, new Date(base + 35 * MIN), new Date(base + 37 * MIN), new Date(base + 36 * MIN)]);
  await ingestAndEvaluate(db.app, cab, [snap("network", [eth(["10.21.4.99"])], 40, { gapBefore: true })], "agent");
  const [ch] = await rows("SELECT via_platform, gap FROM config_changes WHERE cabinet_id = $1", [cab]);
  assert.equal(ch.via_platform, true);
  assert.equal(ch.gap, true, "the agent said it lost older snapshots");
  // A change of a kind the platform does not make is never marked as its own (the hosts file has no platform operation).
  await ingestAndEvaluate(db.app, cab, [snap("hosts", [item("host:10.0.0.1", { names: ["a"] })], 41)], "agent");
  await ingestAndEvaluate(db.app, cab, [snap("hosts", [item("host:10.0.0.1", { names: ["b"] })], 42)], "agent");
  assert.equal((await rows("SELECT via_platform FROM config_changes WHERE cabinet_id = $1 AND category = 'hosts'", [cab]))[0].via_platform, false);
  // A clock far in the future cannot place the observation after now.
  await ingestAndEvaluate(db.app, cab, [snap("network", [eth(["10.21.4.98"])], 60 * 24 * 3)], "agent");
  const [cur] = await rows("SELECT observed_at FROM config_current WHERE cabinet_id = $1 AND category = 'network'", [cab]);
  assert.ok(new Date(cur.observed_at).getTime() <= Date.now() + 1000);
});

test("only Windows' own timestamp makes an exact time, and only the newest versions are kept, but never one a healthy mark points at", async () => {
  const { siteId } = await newSite();
  const cab = await newCabinet(siteId);
  await ingestAndEvaluate(db.app, cab, [snap("updates", [item("update:KB1", { installedAt: at(-600), result: "succeeded" })], 0)], "agent");
  await ingestAndEvaluate(db.app, cab, [snap("updates", [item("update:KB1", { installedAt: at(-600), result: "succeeded" }), item("update:KB5050011", { installedAt: at(14), result: "succeeded" })], 20)], "agent");
  const [ch] = await rows("SELECT exact_at FROM config_changes WHERE cabinet_id = $1", [cab]);
  assert.equal(new Date(ch.exact_at).toISOString(), at(14));
  // An update Windows dated in the future, or not at all, is never an exact time.
  await ingestAndEvaluate(db.app, cab, [snap("updates", [item("update:KB1", { installedAt: at(-600) }), item("update:KB9", { installedAt: "2999-01-01T00:00:00Z" }), item("update:KB8", { result: "failed" })], 25)], "agent");
  assert.equal(await count("SELECT COUNT(*) AS n FROM config_changes WHERE cabinet_id = $1 AND exact_at IS NOT NULL", [cab]), 1);
  // A mark pointing at the very first time version keeps it through the pruning.
  await ingestAndEvaluate(db.app, cab, [snap("time", [item("time", { timeZoneId: "Zone first" })], 30)], "agent");
  const first = Number((await rows("SELECT version_id FROM config_current WHERE cabinet_id = $1 AND category = 'time'", [cab]))[0].version_id);
  await db.app.query("INSERT INTO healthy_marks (cabinet_id, versions) VALUES ($1, $2)", [cab, JSON.stringify({ time: first })]);
  for (let i = 0; i < 25; i++) await ingestAndEvaluate(db.app, cab, [snap("time", [item("time", { timeZoneId: `Zone ${i}` })], 31 + i)], "agent");
  assert.equal(await count("SELECT COUNT(*) AS n FROM config_versions WHERE cabinet_id = $1 AND category = 'time'", [cab]), KEEP_VERSIONS + 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM config_versions WHERE id = $1", [first]), 1, "the marked version is kept");
  // The change records outlive the versions they came from.
  assert.ok(await count("SELECT COUNT(*) AS n FROM config_changes WHERE cabinet_id = $1 AND category = 'time'", [cab]) >= 25);
});

test("a big mass of changes adds at most 500 change records, and the version still holds every item", async () => {
  const { siteId } = await newSite();
  const cab = await newCabinet(siteId);
  const many = (v: string) => Array.from({ length: 800 }, (_, i) => item(`driver:oem${i}.inf`, { version: v }));
  await ingestAndEvaluate(db.app, cab, [snap("drivers", many("1.0"), 0)], "agent");
  await ingestAndEvaluate(db.app, cab, [snap("drivers", many("2.0"), 10)], "agent");
  assert.equal(await count("SELECT COUNT(*) AS n FROM config_changes WHERE cabinet_id = $1", [cab]), 500);
  const [v] = await rows("SELECT items FROM config_versions WHERE cabinet_id = $1 AND hash = $2", [cab, configHash(many("2.0"))]);
  assert.equal(unpackItems(v.items).length, 800);
});

test("the model the cabinet reports is remembered, so its model baseline applies", async () => {
  const { siteId } = await newSite();
  const cab = await newCabinet(siteId);
  await ingestAndEvaluate(db.app, cab, [snap("system", [hardware("OptiPlex 7090")], 0)], "agent");
  assert.deepEqual((await rows("SELECT manufacturer, model FROM cabinets WHERE id = $1", [cab]))[0], { manufacturer: "Dell Inc.", model: "OptiPlex 7090" });
  await ingestAndEvaluate(db.app, cab, [snap("system", [hardware("OptiPlex 7090"), item("identity", { joinType: "workgroup" })], 5)], "agent");
  assert.equal((await rows("SELECT model FROM cabinets WHERE id = $1", [cab]))[0].model, "OptiPlex 7090");
  // A hostile model text is cut to the column, never trusted further.
  await ingestAndEvaluate(db.app, cab, [snap("system", [item("hardware", { model: "M".repeat(200) })], 10)], "agent");
  assert.equal((await rows("SELECT model FROM cabinets WHERE id = $1", [cab]))[0].model.length, 200);
});

test("a configuration read on demand (config.snapshot) is stored like one the agent sent, and a damaged answer is refused", async () => {
  const { siteId } = await newSite();
  const cab = await newCabinet(siteId);
  const user = randomUUID();
  await db.app.query("INSERT INTO users (id, username, name, role) VALUES ($1, $2, 'Tech', 'tier1')", [user, "u" + user.slice(0, 8)]);
  const run = async (output: unknown) => {
    const cmd = await issueCommand(db.app, user, cab, "config.snapshot", {});
    await takeQueuedCommands(db.app, cab);
    await storeResult(db.app, cab, { commandId: cmd.commandId, status: "succeeded", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), output } as never);
  };
  const items = [svc("Spooler")];
  await run({ takenAt: new Date(base + 5 * MIN).toISOString(), categories: [{ category: "services", hash: configHash(items), truncated: false, items }, { category: "time", hash: configHash([item("time", { timeZoneId: "UTC" })]), truncated: false, items: [item("time", { timeZoneId: "UTC" })] }] });
  assert.equal(await count("SELECT COUNT(*) AS n FROM config_current WHERE cabinet_id = $1", [cab]), 2);
  assert.equal((await rows("SELECT source FROM config_versions WHERE cabinet_id = $1", [cab]))[0].source, "refresh");
  // A hash that does not match the items is not stored (the command result itself is kept).
  await run({ takenAt: new Date(base + 9 * MIN).toISOString(), categories: [{ category: "services", hash: "a".repeat(64), truncated: false, items: [svc("Spooler", "disabled")] }] });
  assert.equal(await count("SELECT COUNT(*) AS n FROM config_versions WHERE cabinet_id = $1 AND category = 'services'", [cab]), 1);
  // Eleven categories (more than one upload may hold) are all stored.
  const eleven = ["network", "services", "drivers", "updates", "firewall", "time", "devices", "applications", "hosts", "tasks", "system"].map(category => {
    const list = category === "system" ? [hardware("X")] : category === "tasks" ? [item("task:\\a", { state: "ready" })] : [item(category === "firewall" ? "profile:domain" : category === "applications" ? "app:A" : category === "time" ? "time" : `${category === "network" ? "adapter" : category.slice(0, -1)}:z`, { v: 1 })];
    return { category, hash: configHash(list), truncated: false, items: list };
  });
  const other = await newCabinet(siteId);
  const cmd = await issueCommand(db.app, user, other, "config.snapshot", {});
  await takeQueuedCommands(db.app, other);
  await storeResult(db.app, other, { commandId: cmd.commandId, status: "succeeded", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), output: { takenAt: new Date(base).toISOString(), categories: eleven } } as never);
  assert.equal(await count("SELECT COUNT(*) AS n FROM config_current WHERE cabinet_id = $1", [other]), 11);
});

// ---- Baselines ---------------------------------------------------------------------------------------------------------

test("a baseline version is drafted, proposed and approved by an Admin with a code bound to the note; versions are never overwritten", async () => {
  const author = await account("tier2"), boss = await account("admin"), other = await account("admin"), t1 = await account("tier1");
  const { siteId } = await newSite();
  const scope = { kind: "site", id: siteId };
  const content = { items: [{ category: "services", key: "service:BioScanSvc", mode: "match", expect: { startType: "automatic" }, required: true }] };
  // Tier 1 reads but cannot write; the wide scopes are Admin only.
  assert.equal((await call("POST", "/api/baselines/drafts", { scope, description: "Tier one tries", content }, t1)).status, 403);
  assert.equal((await call("POST", "/api/baselines/drafts", { scope: { kind: "global", id: null }, description: "Tier two tries", content }, author)).status, 403);
  assert.equal((await call("POST", "/api/baselines/drafts", { scope: { kind: "model", id: "OptiPlex 7090" }, description: "Tier two tries", content }, author)).status, 403);
  const draft = await call("POST", "/api/baselines/drafts", { scope, description: "First version for the site", content }, author);
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const v1 = draft.body.id as string;
  // A draft is not in force and can be edited by its author only (or an Admin).
  assert.equal((await call("GET", `/api/cabinets/${await newCabinet(siteId)}/baseline`, undefined, t1)).body.items.length, 0, "a draft applies to nobody");
  assert.equal((await call("PUT", `/api/baselines/versions/${v1}`, { description: "Reworded for clarity" }, boss)).status, 200);
  assert.equal((await call("PUT", `/api/baselines/versions/${v1}`, { description: "Not mine to edit" }, await account("tier2"))).status, 403);
  assert.equal((await call("POST", `/api/baselines/versions/${v1}/propose`, {}, author)).status, 200);
  assert.equal((await call("PUT", `/api/baselines/versions/${v1}`, { description: "Too late" }, author)).status, 409, "a proposal is no longer a draft");
  // The decision: Admin only, the note is required, and the code is bound to the exact note.
  const note = "Matches the three cabinets at the site.";
  assert.equal((await call("POST", `/api/baselines/versions/${v1}/approve`, { note, stepUpToken: "A".repeat(43) }, author)).status, 403);
  assert.equal((await call("POST", `/api/baselines/versions/${v1}/approve`, { note, stepUpToken: await codeToken(boss, "baseline.approve", v1, { note: "A different note." }) }, boss)).status, 403, "a code for another note");
  assert.equal((await call("POST", `/api/baselines/versions/${v1}/approve`, { note: "<b>x</b>", stepUpToken: "A".repeat(43) }, boss)).status, 400);
  assert.equal((await call("POST", `/api/baselines/versions/${v1}/approve`, { note, stepUpToken: await codeToken(boss, "baseline.reject", v1, { note }) }, boss)).status, 403, "a code for rejecting is not a code for approving");
  const ok = await call("POST", `/api/baselines/versions/${v1}/approve`, { note, stepUpToken: await codeToken(boss, "baseline.approve", v1, { note }) }, boss);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const detail = (await call("GET", `/api/baselines/versions/${v1}`, undefined, t1)).body;
  assert.equal(detail.status, "approved");
  assert.equal(detail.decisionNote, note);
  assert.equal(detail.decidedBy.name, `Test ${boss.username}`);
  // Approved history is immutable, even to SQL (and to the database owner), and a real baseline is never deleted.
  await assert.rejects(db.app.query("UPDATE baseline_versions SET content = '{\"items\":[]}' WHERE id = $1", [v1]), /only a draft/);
  await assert.rejects(asOwner(db, c => c.query("UPDATE baseline_versions SET description = 'changed after the fact' WHERE id = $1", [v1])), /only a draft/);
  await assert.rejects(db.app.query("DELETE FROM baseline_versions WHERE id = $1", [v1]), /never deleted/);
  await assert.rejects(asOwner(db, c => c.query("DELETE FROM baseline_versions WHERE id = $1", [v1])), /never deleted/);
  await assert.rejects(asOwner(db, c => c.query("DELETE FROM baselines WHERE id = $1", [detail.baselineId])), /./, "the version holds it, and the trigger refuses it too");
  await assert.rejects(db.app.query("UPDATE baseline_versions SET status = 'draft' WHERE id = $1", [v1]), /change of state|conflicted with the CHECK/);
  // A second version is a new version that supersedes the first once approved; the first stays in the history.
  const v2 = (await call("POST", "/api/baselines/drafts", { scope, description: "Also require the spooler", content: { items: [...content.items, { category: "services", key: "service:Spooler", mode: "present" }] } }, author)).body.id as string;
  assert.equal((await call("GET", `/api/baselines/versions/${v2}`, undefined, t1)).body.diff.added.length, 1);
  await call("POST", `/api/baselines/versions/${v2}/propose`, {}, author);
  const n2 = "Adds the spooler.";
  assert.equal((await call("POST", `/api/baselines/versions/${v2}/approve`, { note: n2, stepUpToken: await codeToken(other, "baseline.approve", v2, { note: n2 }) }, other)).status, 200);
  await reevaluationsSettled();
  const history = (await call("GET", `/api/baselines/${detail.baselineId}`, undefined, t1)).body.versions as { version: number; status: string }[];
  assert.deepEqual(history.map(x => [x.version, x.status]), [[2, "approved"], [1, "superseded"]]);
  assert.ok(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'baseline.%' AND target_id = $1", [detail.baselineId]) >= 6, "every step is audited");
  // The list pages: one row per scope with the version in force.
  const list = (await call("GET", `/api/baselines?scopeKind=site&scopeId=${siteId}`, undefined, t1)).body.baselines;
  assert.equal(list.length, 1);
  assert.equal(list[0].approvedVersion, 2);
});

test("the author does not approve their own proposal when another Admin exists; a version made from an old one is refused once a newer is in force; one proposal at a time", async () => {
  const a1 = await account("admin"), a2 = await account("admin");
  const { siteId } = await newSite();
  const scope = { kind: "site", id: siteId };
  const c = (key: string) => ({ items: [{ category: "services", key: `service:${key}`, mode: "present" }] });
  const mine = (await call("POST", "/api/baselines/drafts", { scope, description: "Written by the first Admin", content: c("A") }, a1)).body.id as string;
  await call("POST", `/api/baselines/versions/${mine}/propose`, {}, a1);
  const note = "Looks right to me.";
  assert.equal((await call("POST", `/api/baselines/versions/${mine}/approve`, { note, stepUpToken: await codeToken(a1, "baseline.approve", mine, { note }) }, a1)).body.error, "own_proposal");
  // Two drafts from the same current state; only one proposal at a time.
  const second = (await call("POST", "/api/baselines/drafts", { scope, description: "A competing draft", content: c("B") }, a2)).body.id as string;
  assert.equal((await call("POST", `/api/baselines/versions/${second}/propose`, {}, a2)).body.error, "already_pending");
  assert.equal((await call("POST", `/api/baselines/versions/${mine}/approve`, { note, stepUpToken: await codeToken(a2, "baseline.approve", mine, { note }) }, a2)).status, 200);
  await call("POST", `/api/baselines/versions/${second}/propose`, {}, a2);
  const n2 = "Competing change.";
  const stale = await call("POST", `/api/baselines/versions/${second}/approve`, { note: n2, stepUpToken: await codeToken(a1, "baseline.approve", second, { note: n2 }) }, a1);
  assert.equal(stale.body.error, "stale_base", "it was made before the first was approved and would silently undo it");
  // A rejection leaves nothing in force and keeps the proposal as history; a decided version is decided once.
  const r = await call("POST", `/api/baselines/versions/${second}/reject`, { note: n2, stepUpToken: await codeToken(a1, "baseline.reject", second, { note: n2 }) }, a1);
  assert.equal(r.status, 200);
  assert.equal((await call("GET", `/api/baselines/versions/${second}`, undefined, a1)).body.status, "rejected");
  assert.equal((await call("POST", `/api/baselines/versions/${second}/reject`, { note: n2, stepUpToken: await codeToken(a1, "baseline.reject", second, { note: n2 }) }, a1)).body.error, "not_pending");
  // A proposal can be withdrawn to a draft by its author, not by someone else.
  const third = (await call("POST", "/api/baselines/drafts", { scope, description: "To be withdrawn", content: c("C") }, a2)).body.id as string;
  await call("POST", `/api/baselines/versions/${third}/propose`, {}, a2);
  assert.equal((await call("POST", `/api/baselines/versions/${third}/withdraw`, {}, await account("tier2"))).status, 403);
  assert.equal((await call("POST", `/api/baselines/versions/${third}/withdraw`, {}, a2)).status, 200);
  assert.equal((await call("GET", `/api/baselines/versions/${third}`, undefined, a2)).body.status, "draft");
});

test("hostile baseline bodies are refused before anything is stored", async () => {
  const t2 = await account("tier2");
  const { siteId } = await newSite();
  const scope = { kind: "site", id: siteId };
  const good = { items: [{ category: "services", key: "service:A", mode: "present" }] };
  for (const body of [
    { scope, description: "ok ok", content: { items: [{ category: "services", key: "service:A", mode: "match" }] } },
    { scope, description: "ok ok", content: { items: [{ category: "registry", key: "reg:A", mode: "present" }] } },
    { scope, description: "ok ok", content: { items: [{ category: "services", key: "service:A", mode: "match", expect: { startType: { cmd: "x" } } }] } },
    { scope, description: "ok ok", content: { items: [{ category: "services", key: "service:A", mode: "match", expect: { startType: 1.5 } }] } },
    { scope, description: "ok ok", content: { items: [{ category: "services", key: "service:A\u0007", mode: "present" }] } },
    { scope, description: "ok ok", content: { items: [{ category: "services", key: "service:A", mode: "present", note: "<img src=x>" }] } },
    { scope: { kind: "global", id: siteId }, description: "ok ok", content: good },
    { scope: { kind: "site", id: "not-a-uuid" }, description: "ok ok", content: good },
    { scope: { kind: "model", id: "x'; DROP TABLE baselines;--" }, description: "ok ok", content: good },
    { scope, description: "<script>", content: good },
    { scope, description: "ok ok", content: good, approved: true },
    { scope, description: "ok ok", content: { ...good, health: { maxOfflineMinutes: 1 } } },
  ]) assert.equal((await call("POST", "/api/baselines/drafts", body, t2)).status, 400, JSON.stringify(body).slice(0, 90));
  // More items than a baseline may hold.
  const huge = await call("POST", "/api/baselines/drafts", { scope, description: "ok ok", content: { items: Array.from({ length: 5001 }, (_, i) => ({ category: "services", key: `service:${i}`, mode: "present" })) } }, t2);
  assert.ok([400, 413].includes(huge.status), String(huge.status));
  // Keys from the wrong category, and a key listed twice, pass the shape but not the rules.
  assert.equal((await call("POST", "/api/baselines/drafts", { scope, description: "ok ok", content: { items: [{ category: "services", key: "rule:Allow", mode: "present" }] } }, t2)).body.error, "bad_item");
  assert.equal((await call("POST", "/api/baselines/drafts", { scope, description: "ok ok", content: { items: [good.items[0], good.items[0]] } }, t2)).body.error, "duplicate_item");
  assert.equal((await call("POST", "/api/baselines/drafts", { scope: { kind: "site", id: randomUUID() }, description: "ok ok", content: good }, t2)).status, 404, "a site that does not exist");
  assert.equal((await call("GET", "/api/baselines?scopeKind=site%27%20OR%201=1", undefined, t2)).status, 400);
  assert.equal((await call("GET", "/api/baselines", undefined)).status, 401);
  assert.equal((await call("POST", `/api/baselines/versions/${randomUUID()}/propose`, { script: "x" }, t2)).status, 400, "a route that takes no body refuses one");
  assert.equal((await call("GET", "/api/baselines/versions/not-an-id", undefined, t2)).status, 404);
  assert.equal(await count("SELECT COUNT(*) AS n FROM baseline_versions v JOIN baselines b ON b.id = v.baseline_id WHERE b.scope_id = $1", [siteId]), 0, "nothing was stored");
});

// ---- Resolution, drift, health -----------------------------------------------------------------------------------------

test("the whole story: healthy, a DNS change, what changed, the last healthy state, and healthy again; never healthy without a baseline", async () => {
  const a1 = await account("admin"), a2 = await account("admin"), t1 = await account("tier1");
  const { siteId } = await newSite();
  const cab = await newCabinet(siteId, "Surgery");
  const healthState = async () => (await call("GET", `/api/cabinets/${cab}/condition`, undefined, t1)).body;
  // No snapshot, then a snapshot but no baseline: unknown, never healthy.
  assert.equal((await healthState()).state, "unknown");
  await ingestAndEvaluate(db.app, cab, [snap("network", [eth()], 0), snap("services", [svc("BioScanSvc")], 0)], "agent");
  const noBaseline = await healthState();
  assert.equal(noBaseline.state, "unknown");
  assert.equal(noBaseline.reasons[0].code, "no_baseline");
  // The site baseline: DNS and the fingerprint service are required.
  await approve(a1, a2, { kind: "site", id: siteId }, { items: [
    { category: "network", key: "adapter:Ethernet", mode: "match", expect: { dnsServers: ["10.21.4.10", "10.21.4.11"], dhcp: true }, required: true, severity: "major" },
    { category: "services", key: "service:BioScanSvc", mode: "match", expect: { startType: "automatic" }, required: true }] });
  await evaluateHealth(db.app, cab, new Date(), new Date(base + 2 * MIN));
  const healthy = await healthState();
  assert.equal(healthy.state, "healthy");
  assert.equal(healthy.degradedSince, null);
  const firstMark = healthy.lastMarkId;
  assert.ok(firstMark);
  // DNS changes to a public server; the cabinet is first seen that way ten minutes later.
  await ingestAndEvaluate(db.app, cab, [snap("network", [eth(["8.8.8.8"])], nowMin())], "agent");
  const bad = await healthState();
  assert.equal(bad.state, "degraded");
  assert.match(bad.reasons[0].text, /adapter:Ethernet \(dnsServers\)/);
  assert.equal(bad.changesSinceHealthy, 1);
  assert.ok(bad.degradedSince && bad.lastHealthyAt);
  const drift = (await call("GET", `/api/cabinets/${cab}/drift`, undefined, t1)).body.drift;
  assert.deepEqual(drift.map((d: { itemKey: string; field: string; expected: unknown; actual: unknown; severity: string }) => [d.itemKey, d.field, d.expected, d.actual, d.severity]),
    [["adapter:Ethernet", "dnsServers", ["10.21.4.10", "10.21.4.11"], ["8.8.8.8"], "major"]]);
  assert.equal(drift[0].origin.kind, "site", "where the expectation comes from");
  // The three comparisons stay apart: the change record, the drift, and the difference from the last healthy state.
  const changes = (await call("GET", `/api/cabinets/${cab}/config-changes`, undefined, t1)).body.changes;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].violatesBaseline, true);
  assert.equal(changes[0].viaPlatform, false);
  assert.deepEqual(changes[0].fields.dnsServers.before, ["10.21.4.10", "10.21.4.11"]);
  assert.deepEqual(changes[0].fields.dnsServers.after, ["8.8.8.8"]);
  const cmp = (await call("GET", `/api/cabinets/${cab}/compare-healthy`, undefined, t1)).body;
  assert.equal(cmp.markId, firstMark);
  assert.deepEqual(cmp.changes.map((c: { category: string; key: string }) => [c.category, c.key]), [["network", "adapter:Ethernet"]]);
  // The configuration the cabinet reported last, by category.
  const config = (await call("GET", `/api/cabinets/${cab}/config?category=network`, undefined, t1)).body.categories;
  assert.equal(config.length, 1);
  assert.deepEqual(config[0].items[0].values.dnsServers, ["8.8.8.8"]);
  // The history: the change is flagged as shortly before the problem was first observed, never as its cause.
  const tl = (await call("GET", `/api/cabinets/${cab}/config-history`, undefined, t1)).body;
  assert.ok(tl.problemStartedBetween.from && tl.problemStartedBetween.to);
  const entry = tl.entries.find((e: { kind: string }) => e.kind === "change");
  assert.equal(entry.nearProblem, true);
  assert.ok(entry.window.notBefore && entry.window.observedAt, "the window, not an invented instant");
  assert.ok(tl.entries.some((e: { kind: string; title: string }) => e.kind === "health" && e.title === "Cabinet degraded"));
  assert.ok(!JSON.stringify(tl).toLowerCase().includes("caused"));
  assert.equal((await call("GET", `/api/cabinets/${cab}/config-history?q=dnsservers`, undefined, t1)).body.entries.every((e: { title: string; detail: string }) => `${e.title} ${e.detail}`.toLowerCase().includes("dnsservers")), true);
  // Put back by hand: healthy again, and a new mark for what is now in force.
  await ingestAndEvaluate(db.app, cab, [snap("network", [eth()], nowMin() + 0.5)], "agent");
  const back = await healthState();
  assert.equal(back.state, "healthy");
  assert.equal(back.degradedSince, null);
  assert.ok(back.lastMarkId > firstMark);
  assert.equal((await rows("SELECT to_state FROM health_transitions WHERE cabinet_id = $1 ORDER BY id", [cab])).map(r => r.to_state).join(","), "unknown,healthy,degraded,healthy");
  // Reading is Tier 1, and an unknown cabinet is a plain 404.
  assert.equal((await call("GET", `/api/cabinets/${randomUUID()}/drift`, undefined, t1)).status, 404);
  assert.equal((await call("GET", `/api/cabinets/${cab}/drift`, undefined)).status, 401);
  assert.equal((await call("GET", `/api/cabinets/${cab}/config-changes?category=registry`, undefined, t1)).status, 400);
  assert.equal((await call("GET", `/api/cabinets/${cab}/config-changes?days=9999`, undefined, t1)).status, 400);
  assert.equal((await call("GET", `/api/cabinets/${cab}/config-changes?q=${encodeURIComponent("100%_[a]")}`, undefined, t1)).status, 200, "wildcards in a search are text");
});

test("a required item that is missing, a critical alert, and a quiet cabinet each make it not healthy, for their own stated reason", async () => {
  const a1 = await account("admin"), a2 = await account("admin");
  const { siteId } = await newSite();
  const cab = await newCabinet(siteId);
  await approve(a1, a2, { kind: "site", id: siteId }, { items: [{ category: "services", key: "service:BioScanSvc", mode: "present", required: true }] });
  await ingestAndEvaluate(db.app, cab, [snap("services", [svc("Spooler")], 0)], "agent");
  let state = await evaluateHealth(db.app, cab);
  assert.equal(state.state, "degraded");
  assert.equal(state.reasons[0]!.code, "required_item");
  await ingestAndEvaluate(db.app, cab, [snap("services", [svc("Spooler"), svc("BioScanSvc")], 5)], "agent");
  assert.equal((await evaluateHealth(db.app, cab)).state, "healthy");
  // A major alert (a failing drive) is a reason; a cabinet-only alert is not.
  await db.app.query(`INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen, scope) VALUES ($1, '00000000-0000-4000-8000-000000000102', 'major', 'issue:drive', 'Drive failing', SYSUTCDATETIME(), SYSUTCDATETIME(), 'fleet')`, [cab]);
  state = await evaluateHealth(db.app, cab);
  assert.equal(state.state, "degraded");
  assert.deepEqual(state.reasons.map(r => r.code), ["critical_alert"]);
  await db.app.query("UPDATE alerts SET state = 'resolved' WHERE cabinet_id = $1", [cab]);
  await db.app.query(`INSERT INTO alerts (cabinet_id, issue_type_id, severity, signature, title, first_seen, last_seen, scope) VALUES ($1, '00000000-0000-4000-8000-000000000122', 'major', 'issue:usb', 'USB', SYSUTCDATETIME(), SYSUTCDATETIME(), 'cabinet')`, [cab]);
  assert.equal((await evaluateHealth(db.app, cab)).state, "healthy", "a cabinet alert is for the cabinet, not its health");
  // No contact for longer than the limit: offline, with the time it was last heard.
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(minute, -45, SYSUTCDATETIME()) WHERE id = $1", [cab]);
  state = await evaluateHealth(db.app, cab);
  assert.equal(state.state, "offline");
  assert.ok(state.degradedSince && state.lastHealthyAt);
  // The periodic sweep keeps this up to date with no event to trigger it, picking first the cabinets whose state disagrees with their contact.
  await db.app.query("UPDATE cabinets SET last_heartbeat_at = SYSUTCDATETIME() WHERE id = $1", [cab]);
  await db.app.query("UPDATE cabinet_health SET evaluated_at = DATEADD(minute, -2, SYSUTCDATETIME()) WHERE cabinet_id = $1", [cab]);
  assert.ok(await sweepHealth(db.app) >= 1);
  assert.equal((await rows("SELECT state FROM cabinet_health WHERE cabinet_id = $1", [cab]))[0].state, "healthy");
});

test("judging is pure and does not trust a cabinet that cannot be judged: unknown, never healthy", () => {
  const hl = { maxOfflineMinutes: 10, requireRequiredItems: true, requireNoCriticalAlerts: true };
  const b = { lastContactAt: new Date(), now: new Date(), hasConfig: true, hasBaseline: true, requiredDrift: [], criticalAlerts: [] };
  assert.equal(judge(b, hl).state, "healthy");
  assert.equal(judge({ ...b, hasBaseline: false }, hl).state, "unknown");
  assert.equal(judge({ ...b, hasConfig: false }, hl).state, "unknown");
  assert.equal(judge({ ...b, lastContactAt: null }, hl).state, "offline");
  assert.equal(judge({ ...b, criticalAlerts: [{ title: "x" }] }, { ...hl, requireNoCriticalAlerts: false }).state, "healthy");
  assert.equal(judge({ ...b, requiredDrift: [{ itemKey: "service:A", field: "", category: "services" }] }, { ...hl, requireRequiredItems: false }).state, "healthy");
  const origin = { kind: "global" as const, id: null, name: "All", baselineId: "b", versionId: "v", version: 1 };
  const expectation = { category: "services" as const, key: "service:X", mode: "match" as const, expect: { startType: "automatic" }, required: false, severity: "minor" as const, note: null, origin };
  assert.deepEqual(computeDrift([expectation], new Map()), [], "a category the cabinet has not reported is unknown, not drift");
  assert.equal(computeDrift([expectation], new Map([["services", [] as Item[]]])).length, 1, "reported, but the item is missing");
  assert.deepEqual(computeDrift([{ ...expectation, mode: "absent", expect: null }], new Map([["services", [svc("X")]]])).map(d => [d.mode, d.actual]), [["absent", true]]);
  assert.equal(computeDrift([expectation], new Map([["services", [item("service:X", { startType: "automatic" })]]])).length, 0);
  // A list compares by its order and content, a number by its value.
  assert.equal(computeDrift([{ ...expectation, key: "adapter:E", category: "network", expect: { dnsServers: ["a", "b"], metric: 25 } }], new Map([["network", [item("adapter:E", { dnsServers: ["b", "a"], metric: 25 })]]])).length, 1);
  assert.deepEqual(diffContent(null, { items: [{ category: "services", key: "service:A", mode: "present" }] }).added.length, 1);
});

test("a capture is only a draft and leaves out what differs from cabinet to cabinet; an import copies approved content", async () => {
  const t2 = await account("tier2"), a1 = await account("admin"), t1 = await account("tier1");
  const { siteId } = await newSite();
  const cab = await newCabinet(siteId);
  assert.equal((await call("POST", "/api/baselines/capture", { cabinetId: cab, scope: { kind: "site", id: siteId }, description: "Nothing reported yet" }, t2)).body.error, "no_configuration");
  await ingestAndEvaluate(db.app, cab, [snap("network", [eth()], 0), snap("services", [svc("BioScanSvc"), svc("Spooler", "automatic", "stopped")], 0),
    snap("devices", [item("device:USB\\VID_1&PID_2\\6&1", { name: "Reader", status: "OK" })], 0), snap("updates", [item("update:KB1", { installedAt: at(-10), result: "succeeded" })], 0),
    snap("system", [hardware("OptiPlex 7090"), item("identity", { joinType: "workgroup" })], 0)], "agent");
  const cap = await call("POST", "/api/baselines/capture", { cabinetId: cab, scope: { kind: "site", id: siteId }, description: "Captured from a known-good cabinet" }, t2);
  assert.equal(cap.status, 201, JSON.stringify(cap.body));
  const v = (await call("GET", `/api/baselines/versions/${cap.body.id}`, undefined, t1)).body;
  assert.equal(v.status, "draft", "capturing approves nothing");
  assert.equal(v.origin.kind, "capture");
  const keys = v.content.items.map((i: { key: string }) => i.key);
  assert.ok(keys.includes("adapter:Ethernet") && keys.includes("service:BioScanSvc") && keys.includes("hardware"));
  assert.ok(!keys.some((k: string) => k.startsWith("device:")), "devices are per machine; left out of a site's capture");
  const adapter = v.content.items.find((i: { key: string }) => i.key === "adapter:Ethernet");
  assert.equal(adapter.expect.addresses, undefined, "an address is not what every cabinet at the site has");
  assert.equal(v.content.items.find((i: { key: string }) => i.key === "service:Spooler").expect.state, undefined, "a state changes by itself");
  assert.equal(v.content.items.find((i: { key: string }) => i.key === "update:KB1").expect.installedAt, undefined, "an install time differs per cabinet");
  // A capture for this very cabinet keeps its address and its devices.
  const own = await call("POST", "/api/baselines/capture", { cabinetId: cab, scope: { kind: "cabinet", id: cab }, description: "This cabinet as it is" }, t2);
  assert.ok((await call("GET", `/api/baselines/versions/${own.body.id}`, undefined, t1)).body.content.items.some((i: { key: string; expect: { addresses?: string[] } }) => i.key.startsWith("device:") || i.expect.addresses));
  // Only some categories can be asked for, and only the wide scopes need an Admin.
  assert.equal((await call("POST", "/api/baselines/capture", { cabinetId: cab, scope: { kind: "site", id: siteId }, description: "Only the time", categories: ["time"] }, t2)).body.error, "no_configuration");
  assert.equal((await call("POST", "/api/baselines/capture", { cabinetId: cab, scope: { kind: "global", id: null }, description: "Tier two tries" }, t2)).status, 403);
  assert.equal((await call("GET", `/api/cabinets/${cab}/baseline`, undefined, t1)).body.items.length, 0, "not in force until approved");
  await call("POST", `/api/baselines/versions/${cap.body.id}/propose`, {}, t2);
  const note = "Reviewed against the site.";
  await call("POST", `/api/baselines/versions/${cap.body.id}/approve`, { note, stepUpToken: await codeToken(a1, "baseline.approve", cap.body.id, { note }) }, a1);
  await reevaluationsSettled();
  assert.equal((await rows("SELECT state FROM cabinet_health WHERE cabinet_id = $1", [cab]))[0].state, "healthy", "the cabinet it was captured from meets it");
  // Import into another site.
  const other = await newSite();
  assert.equal((await call("POST", "/api/baselines/import", { from: { kind: "site", id: other.siteId }, to: { kind: "site", id: siteId }, description: "Nothing to import" }, t2)).body.error, "no_approved_baseline");
  const imp = await call("POST", "/api/baselines/import", { from: { kind: "site", id: siteId }, to: { kind: "site", id: other.siteId }, description: "Same layout as the first site" }, t2);
  assert.equal(imp.status, 201);
  assert.equal((await call("GET", `/api/baselines/versions/${imp.body.id}`, undefined, t1)).body.content.items.length, v.content.items.length);
  assert.equal((await call("POST", "/api/baselines/import", { from: { kind: "site", id: siteId }, to: { kind: "model", id: "X1" }, description: "Tier two to a model" }, t2)).status, 403);
});

test("a capture too big for a baseline is refused with the reason instead of being cut short", async () => {
  const t2 = await account("tier2");
  const { siteId } = await newSite();
  const cab = await newCabinet(siteId);
  const items = (p: string) => Array.from({ length: 1700 }, (_, i) => item(`${p}:item ${i}`, { v: "x" }));
  await ingestAndEvaluate(db.app, cab, [snap("services", items("service"), 0), snap("drivers", items("driver"), 0), snap("applications", items("app"), 0)], "agent");
  assert.equal((await call("POST", "/api/baselines/capture", { cabinetId: cab, scope: { kind: "site", id: siteId }, description: "Everything at once" }, t2)).body.error, "too_many_items");
  assert.equal((await call("POST", "/api/baselines/capture", { cabinetId: cab, scope: { kind: "site", id: siteId }, description: "Two categories", categories: ["services", "drivers"] }, t2)).status, 201);
});

test("approving a baseline re-evaluates the cabinets it applies to", async () => {
  const a1 = await account("admin"), a2 = await account("admin");
  const { siteId } = await newSite();
  const one = await newCabinet(siteId), two = await newCabinet(siteId);
  for (const c of [one, two]) await ingestAndEvaluate(db.app, c, [snap("services", [svc("Spooler", "manual")], 0)], "agent");
  await approve(a1, a2, { kind: "site", id: siteId }, { items: [{ category: "services", key: "service:Spooler", mode: "match", expect: { startType: "automatic" }, required: true }] });
  assert.equal(await count("SELECT COUNT(*) AS n FROM cabinet_drift WHERE cabinet_id IN ($1, $2)", [one, two]), 2);
  assert.deepEqual((await rows("SELECT state FROM cabinet_health WHERE cabinet_id IN ($1, $2)", [one, two])).map(r => r.state), ["degraded", "degraded"]);
  // A later version that drops the item clears the drift on both.
  await approve(a1, a2, { kind: "site", id: siteId }, { items: [] });
  assert.equal(await count("SELECT COUNT(*) AS n FROM cabinet_drift WHERE cabinet_id IN ($1, $2)", [one, two]), 0);
});

// ---- The fleet ---------------------------------------------------------------------------------------------------------

test("the fleet view counts the cabinets that differ in each way, for all of them or one client or site, and compares them with those that do not", async () => {
  const a1 = await account("admin"), a2 = await account("admin"), t1 = await account("tier1");
  const mine = await newSite(), theirs = await newSite();
  const cabs = [await newCabinet(mine.siteId), await newCabinet(mine.siteId), await newCabinet(mine.siteId)];
  const stray = await newCabinet(theirs.siteId);
  for (const [i, c] of cabs.entries()) await ingestAndEvaluate(db.app, c, [snap("services", [svc("BioScanSvc", i === 2 ? "automatic" : "disabled")], 0), snap("network", [eth(i === 0 ? ["8.8.8.8"] : undefined)], 0)], "agent");
  await ingestAndEvaluate(db.app, stray, [snap("services", [svc("BioScanSvc", "disabled")], 0)], "agent");
  const content = { items: [{ category: "services", key: "service:BioScanSvc", mode: "match", expect: { startType: "automatic" }, severity: "major" }, { category: "network", key: "adapter:Ethernet", mode: "match", expect: { dnsServers: ["10.21.4.10", "10.21.4.11"] } }] };
  await approve(a1, a2, { kind: "site", id: mine.siteId }, content);
  await approve(a1, a2, { kind: "site", id: theirs.siteId }, content);
  const all = (await call("GET", `/api/fleet/differences?siteId=${mine.siteId}`, undefined, t1)).body;
  assert.equal(all.cabinetsReporting, 3);
  assert.deepEqual(all.groups.map((g: { itemKey: string; field: string; cabinets: number; major: number }) => [g.itemKey, g.field, g.cabinets, g.major]), [["service:BioScanSvc", "startType", 2, 2], ["adapter:Ethernet", "dnsServers", 1, 0]]);
  const client = (await call("GET", `/api/fleet/differences?clientId=${theirs.clientId}`, undefined, t1)).body;
  assert.deepEqual(client.groups.map((g: { cabinets: number }) => g.cabinets), [1]);
  const group = (await call("GET", `/api/fleet/differences/group?category=services&itemKey=${encodeURIComponent("service:BioScanSvc")}&field=startType&siteId=${mine.siteId}`, undefined, t1)).body;
  assert.equal(group.affected, 2);
  assert.equal(group.unaffected, 1, "the cabinet at the same site that reports the item and does not differ");
  assert.deepEqual(group.cabinets.map((c: { expected: unknown; actual: unknown }) => [c.expected, c.actual]), [["automatic", "disabled"], ["automatic", "disabled"]]);
  assert.equal((await call("GET", "/api/fleet/differences?siteId=1%20OR%201=1", undefined, t1)).status, 400);
  assert.equal((await call("GET", "/api/fleet/differences/group?category=services", undefined, t1)).status, 400);
  assert.equal((await call("GET", "/api/fleet/differences/group?category=services&itemKey=service:x&field=a;b", undefined, t1)).status, 400);
  assert.equal((await call("GET", "/api/fleet/differences", undefined)).status, 401);
});

// ---- The database holds its own rules ---------------------------------------------------------------------------------------

test("the database refuses a malformed stored form whoever asks: bad hashes, categories, states and JSON", async () => {
  const { siteId } = await newSite();
  const cab = await newCabinet(siteId);
  const bad = async (sql: string, args: unknown[], why: string) => await assert.rejects(asOwner(db, c => c.query(sql, args)), /./, why);
  await bad("INSERT INTO config_versions (cabinet_id, category, hash, items, item_count, first_observed_at, last_observed_at, source) VALUES ($1, 'registry', $2, $3, 0, SYSUTCDATETIME(), SYSUTCDATETIME(), 'agent')", [cab, "a".repeat(64), Buffer.from("x")], "a category outside the list");
  await bad("INSERT INTO config_versions (cabinet_id, category, hash, items, item_count, first_observed_at, last_observed_at, source) VALUES ($1, 'time', $2, $3, 0, SYSUTCDATETIME(), SYSUTCDATETIME(), 'agent')", [cab, "g".repeat(64), Buffer.from("x")], "a hash that is not hex");
  await bad("INSERT INTO config_versions (cabinet_id, category, hash, items, item_count, first_observed_at, last_observed_at, source) VALUES ($1, 'time', $2, $3, 5000, SYSUTCDATETIME(), SYSUTCDATETIME(), 'agent')", [cab, "a".repeat(64), Buffer.from("x")], "more items than a category may hold");
  await bad("INSERT INTO config_changes (cabinet_id, version_id, category, item_key, change, fields, observed_at) VALUES ($1, 1, 'time', 'time', 'changed', 'not json', SYSUTCDATETIME())", [cab], "fields that are not JSON");
  await bad("INSERT INTO cabinet_health (cabinet_id, state, evaluated_at, since, reasons) VALUES ($1, 'fine', SYSUTCDATETIME(), SYSUTCDATETIME(), '[]')", [cab], "a state outside the list");
  await bad("INSERT INTO baselines (id, scope_kind, scope_id, name, created_by) VALUES ($1, 'global', 'x', 'bad', $2)", [randomUUID(), randomUUID()], "a global baseline with a scope id");
  // The application's account has the rights it needs and not more: it cannot change the schema.
  await assert.rejects(db.app.query("ALTER TABLE baselines ADD x int"), /permission/i);
  await assert.rejects(db.app.query("DROP TABLE baseline_versions"), /permission/i);
  // Deleting a cabinet takes its whole configuration with it (the simulated fleet is deleted this way).
  const { siteId: s2 } = await newSite();
  const gone = await newCabinet(s2);
  await ingestAndEvaluate(db.app, gone, [snap("services", [svc("A")], 0), snap("system", [hardware("M")], 0)], "agent");
  await ingestAndEvaluate(db.app, gone, [snap("services", [svc("A", "disabled")], 5)], "agent");
  await db.app.query("DELETE FROM cabinets WHERE id = $1", [gone]);
  for (const t of ["config_current", "config_versions", "config_changes", "cabinet_health", "cabinet_drift", "healthy_marks", "health_transitions"])
    assert.equal(await count(`SELECT COUNT(*) AS n FROM ${t} WHERE cabinet_id = $1`, [gone]), 0, t);
});

test("the baselines of a client or site that no longer exists can be deleted, and no others", async () => {
  const a1 = await account("admin"), a2 = await account("admin");
  const real = await newSite(), doomed = await newSite();
  await approve(a1, a2, { kind: "site", id: real.siteId }, { items: [] });
  await approve(a1, a2, { kind: "site", id: doomed.siteId }, { items: [] });
  await approve(a1, a2, { kind: "global", id: null }, { items: [] });
  const orphan = `scope_id = '${doomed.siteId}'`;
  await assert.rejects(db.app.query(`DELETE FROM baseline_versions WHERE baseline_id IN (SELECT id FROM baselines WHERE ${orphan})`), /never deleted/, "the site is still there");
  await db.app.query("DELETE FROM sites WHERE id = $1", [doomed.siteId]);
  await assert.rejects(db.app.query("DELETE FROM baseline_versions WHERE baseline_id IN (SELECT id FROM baselines WHERE scope_kind = 'global')"), /never deleted/, "a global baseline is never deleted");
  await assert.rejects(db.app.query(`DELETE FROM baseline_versions WHERE baseline_id IN (SELECT id FROM baselines WHERE scope_id = '${real.siteId}')`), /never deleted/);
  await db.app.query(`DELETE FROM baseline_versions WHERE baseline_id IN (SELECT id FROM baselines WHERE ${orphan})`);
  await db.app.query(`DELETE FROM baselines WHERE ${orphan}`);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM baselines WHERE ${orphan}`), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM baselines WHERE scope_id = $1", [real.siteId]), 1);
});

// Last: it approves baselines for all cabinets and a model, which then apply to every cabinet the earlier tests made.
test("a narrower scope replaces a wider one item by item, an ignore cancels an inherited expectation, and every expectation says where it came from", async () => {
  const a1 = await account("admin"), a2 = await account("admin"), t1 = await account("tier1");
  const { siteId } = await newSite();
  const cab = await newCabinet(siteId, "Unique Cab", "HP ProDesk 400 G7");
  await approve(a1, a2, { kind: "global", id: null }, { items: [
    { category: "services", key: "service:Spooler", mode: "match", expect: { startType: "automatic" } },
    { category: "services", key: "service:Legacy", mode: "present" },
    { category: "firewall", key: "rule:Allow Sync 1433", mode: "match", expect: { enabled: true }, required: true }], health: { maxOfflineMinutes: 15 } });
  await approve(a1, a2, { kind: "model", id: "HP ProDesk 400 G7" }, { items: [{ category: "drivers", key: "driver:oem42.inf", mode: "match", expect: { version: "3.1.0.7" } }] });
  await approve(a1, a2, { kind: "site", id: siteId }, { items: [
    { category: "services", key: "service:Spooler", mode: "match", expect: { startType: "manual" } },
    { category: "services", key: "service:Legacy", mode: "ignore" }], health: { requireNoCriticalAlerts: false } });
  await approve(a1, a2, { kind: "cabinet", id: cab }, { items: [{ category: "network", key: "adapter:Ethernet", mode: "match", expect: { addresses: ["10.21.4.25/24"] }, required: true }] });
  const r = (await call("GET", `/api/cabinets/${cab}/baseline`, undefined, t1)).body;
  const by = (k: string) => r.items.find((i: { key: string }) => i.key === k);
  assert.equal(by("service:Spooler").expect.startType, "manual", "the site replaces the global item");
  assert.equal(by("service:Spooler").origin.kind, "site");
  assert.equal(by("service:Legacy"), undefined, "ignored at the site");
  assert.equal(by("rule:Allow Sync 1433").origin.kind, "global");
  assert.equal(by("driver:oem42.inf").origin.kind, "model");
  assert.equal(by("adapter:Ethernet").origin.kind, "cabinet");
  assert.deepEqual(r.scopes.map((s: { kind: string }) => s.kind), ["global", "model", "site", "cabinet"]);
  assert.deepEqual([r.health.maxOfflineMinutes, r.health.requireNoCriticalAlerts, r.health.requireRequiredItems], [15, false, true]);
  assert.equal(r.healthOrigin.maxOfflineMinutes.kind, "global");
  assert.equal(r.healthOrigin.requireNoCriticalAlerts.kind, "site");
  // The model baseline applies to a cabinet because it reported that model; one that reported another model is not judged by it.
  const other = await newCabinet(siteId, "Other model", "OptiPlex 3080");
  assert.equal((await call("GET", `/api/cabinets/${other}/baseline`, undefined, t1)).body.items.some((i: { key: string }) => i.key === "driver:oem42.inf"), false);
  await ingestAndEvaluate(db.app, other, [snap("system", [hardware("HP ProDesk 400 G7")], 0)], "agent");
  assert.equal((await call("GET", `/api/cabinets/${other}/baseline`, undefined, t1)).body.items.some((i: { key: string }) => i.key === "driver:oem42.inf"), true);
});

// ---- Role baselines (F7, decision-log D33) -----------------------------------------------------------------------------------

test("a role baseline is an Admin's, names one of the three roles, and nothing else is accepted as a role", async () => {
  const t2 = await account("tier2"), a1 = await account("admin");
  const content = { items: [{ category: "services", key: "service:RoleOnly" + randomUUID().slice(0, 6), mode: "present" }] };
  assert.equal((await call("POST", "/api/baselines/drafts", { scope: { kind: "role", id: "standalone" }, description: "Tier two tries", content }, t2)).status, 403);
  for (const id of ["admin", "Sync", "", null, "sync' OR 1=1 --", "satellite ", "x".repeat(65)])
    assert.equal((await call("POST", "/api/baselines/drafts", { scope: { kind: "role", id }, description: "A hostile role", content }, a1)).status, 400, JSON.stringify(id));
  // The database holds the line too, whatever reaches it.
  await assert.rejects(db.app.query("INSERT INTO baselines (id, scope_kind, scope_id, name, created_by) VALUES ($1, 'role', 'kiosk', 'x', $2)", [randomUUID(), a1.id]));
  assert.equal((await call("GET", "/api/baselines?scopeKind=role", undefined, a1)).status, 200);
});

test("a role baseline applies to every cabinet of that role and no other, between the fleet's and a model's; a cabinet missing what its role expects is degraded with the item named", async () => {
  const a1 = await account("admin"), a2 = await account("admin"), t1 = await account("tier1");
  const tag = randomUUID().slice(0, 6);
  const { siteId } = await newSite();
  const standalone = await newCabinet(siteId, `Role standalone ${tag}`, `Role Model ${tag}`);
  await db.app.query("UPDATE cabinets SET role = 'standalone' WHERE id = $1", [standalone]);
  const satellite = await newCabinet(siteId, `Role satellite ${tag}`);
  const expected = `service:DispenseSvc${tag}`, tuned = `service:Tuned${tag}`;
  await approve(a1, a2, { kind: "role", id: "standalone" }, { items: [
    { category: "services", key: expected, mode: "present", required: true },
    { category: "services", key: tuned, mode: "match", expect: { startType: "automatic" } }] });
  await approve(a1, a2, { kind: "model", id: `Role Model ${tag}` }, { items: [{ category: "services", key: tuned, mode: "match", expect: { startType: "manual" } }] });

  const mine = (await call("GET", `/api/cabinets/${standalone}/baseline`, undefined, t1)).body;
  const by = (k: string) => mine.items.find((i: { key: string }) => i.key === k);
  assert.equal(by(expected).origin.kind, "role");
  assert.equal(by(expected).origin.name, "Standalone cabinets");
  assert.equal(by(tuned).expect.startType, "manual", "a model baseline is narrower than a role's and replaces its item");
  const kinds = mine.scopes.map((s: { kind: string }) => s.kind);
  assert.ok(kinds.indexOf("role") >= 0 && kinds.indexOf("role") < kinds.indexOf("model"), `role sits before model: ${kinds}`);
  assert.ok(kinds.indexOf("global") === -1 || kinds.indexOf("global") < kinds.indexOf("role"), `the fleet's sits before role: ${kinds}`);
  // A cabinet of another role is not judged by it.
  const theirs = (await call("GET", `/api/cabinets/${satellite}/baseline`, undefined, t1)).body;
  assert.equal(theirs.items.some((i: { key: string }) => i.key === expected), false);

  // The standalone cabinet does not run the service its role expects: degraded, and the reason names the service.
  await ingestAndEvaluate(db.app, standalone, [snap("services", [svc("Spooler")], 0)], "agent");
  const state = await evaluateHealth(db.app, standalone);
  assert.equal(state.state, "degraded");
  assert.ok(state.reasons.some(r => r.code === "required_item" && r.text.includes(expected)), JSON.stringify(state.reasons));
  await ingestAndEvaluate(db.app, satellite, [snap("services", [svc("Spooler")], 0)], "agent");
  assert.ok(!(await evaluateHealth(db.app, satellite)).reasons.some(r => r.text.includes(expected)), "the satellite is not held to the standalone role");
  // Once it runs it, the role's expectation is met.
  await ingestAndEvaluate(db.app, standalone, [snap("services", [svc("Spooler"), svc(expected.slice("service:".length)), svc(tuned.slice("service:".length), "manual")], 5)], "agent");
  assert.ok(!(await evaluateHealth(db.app, standalone)).reasons.some(r => r.code === "required_item"));
});

test("the fleet view answers which cabinets of a client differ from their role, apart from what their site asks, and refuses a role or level it does not know", async () => {
  const a1 = await account("admin"), a2 = await account("admin"), t1 = await account("tier1");
  const tag = randomUUID().slice(0, 6);
  const north = await newSite(`R3 ${tag}`);
  const southId = randomUUID();
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [southId, north.clientId, `South ${tag}`]);
  const [n1, n2, s1] = [await newCabinet(north.siteId, `N1 ${tag}`), await newCabinet(north.siteId, `N2 ${tag}`), await newCabinet(southId, `S1 ${tag}`)];
  const sat = await newCabinet(north.siteId, `SAT ${tag}`);
  for (const k of [n1, n2, s1]) await db.app.query("UPDATE cabinets SET role = 'standalone' WHERE id = $1", [k]);
  const roleSvc = `Role${tag}`, siteSvc = `Site${tag}`;
  // The role asks for a service; the north site asks for another. n1 and s1 lack the role's; n2 has it; every cabinet lacks the site's.
  await approve(a1, a2, { kind: "role", id: "standalone" }, { items: [{ category: "services", key: `service:${roleSvc}`, mode: "present" }] });
  await approve(a1, a2, { kind: "site", id: north.siteId }, { items: [{ category: "services", key: `service:${siteSvc}`, mode: "present" }] });
  await ingestAndEvaluate(db.app, n1, [snap("services", [svc("Spooler")], 0)], "agent");
  await ingestAndEvaluate(db.app, n2, [snap("services", [svc("Spooler"), svc(roleSvc)], 0)], "agent");
  await ingestAndEvaluate(db.app, s1, [snap("services", [svc("Spooler")], 0)], "agent");
  await ingestAndEvaluate(db.app, sat, [snap("services", [svc("Spooler")], 0)], "agent");

  const groups = async (q: string) => ((await call("GET", `/api/fleet/differences?${q}`, undefined, t1)).body.groups as { itemKey: string; cabinets: number }[])
    .filter(g => g.itemKey.includes(tag)).map(g => [g.itemKey, g.cabinets]);
  const c = `clientId=${north.clientId}`;
  assert.deepEqual(await groups(`${c}&from=role`), [[`service:${roleSvc}`, 2]], "from the role: n1 and s1, not the site's item");
  assert.deepEqual(await groups(`${c}&from=site`), [[`service:${siteSvc}`, 3]], "from the north site: its three cabinets, the satellite among them");
  assert.deepEqual(await groups(`${c}&role=satellite`), [[`service:${siteSvc}`, 1]], "the satellite differs only from its site");
  assert.deepEqual((await groups(c)).sort(), [[`service:${roleSvc}`, 2], [`service:${siteSvc}`, 3]], "without a filter, both");

  const group = (await call("GET", `/api/fleet/differences/group?category=services&itemKey=${encodeURIComponent(`service:${roleSvc}`)}&${c}&from=role`, undefined, t1)).body;
  assert.deepEqual(group.cabinets.map((k: { name: string }) => k.name).sort(), [`N1 ${tag}`, `S1 ${tag}`]);
  assert.equal(group.unaffected, 2, "n2 reports services and meets its role; so does the satellite, which its role does not ask it for");
  const sats = (await call("GET", `/api/fleet/differences/group?category=services&itemKey=${encodeURIComponent(`service:${roleSvc}`)}&${c}&role=satellite`, undefined, t1)).body;
  assert.equal(sats.affected, 0);

  for (const bad of ["role=kiosk", "role=Sync", "from=everything", "from=role'%20OR%201=1%20--", "role=", "from="])
    assert.equal((await call("GET", `/api/fleet/differences?${c}&${bad}`, undefined, t1)).status, 400, bad);
  assert.equal((await call("GET", `/api/fleet/differences/group?category=services&itemKey=service:x&from=kiosk`, undefined, t1)).status, 400);
});
