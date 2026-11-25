// An approved service entry that no cabinet can match is visible where the list is written (plan item 2.7, decision-log D149). The agent
// controls a service only when its key name is on the list and the program its image path names is the entry's program; the editor's
// responses count, per service entry, the cabinets of the level that reported their services, have the key name, and run that program.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { normalizeEntries, storedApprovedApps, writeApprovedLevel, type ApprovedApp } from "../src/services/approved-apps.js";
import { serviceEntryChecks } from "../src/services/approved-apps-match.js";
import { ConsoleHarness, ORIGIN } from "./console-harness.js";
import { createTestDatabase, type TestDatabase, startFeed } from "./database.js";
import { tempDir } from "./helpers.js";

let db: TestDatabase;
let app: FastifyInstance;
let stream: ResultStream;
const secrets = new SecretBox(randomBytes(32).toString("base64"));
const h = new ConsoleHarness(secrets);
let issuer: string;

test.before(async () => {
  db = await createTestDatabase();
  stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin: ORIGIN, stream, logger: false, now: () => h.clock });
  h.db = db; h.app = app;
  issuer = (await h.account("admin")).id;
});
test.after(async () => { await app.close(); await stream.stop(); await db.drop(); });

const SCANNER = { key: "app:scanner", kind: "service", name: "Scanner service", path: "C:\\Program Files\\Vendor\\scanner.exe", serviceName: "BioScanSvc" };
const entries = (raw: unknown[]): ApprovedApp[] => { const r = normalizeEntries(raw); if (!r.ok) throw new Error(r.reason); return r.entries; };

async function site(): Promise<{ client: string; site: string }> {
  const client = randomUUID(), site = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [client, `C ${client.slice(0, 8)}`]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'S')", [site, client]);
  return { client, site };
}
async function cabinet(siteId: string): Promise<string> {
  const id = randomUUID();
  await db.app.query("INSERT INTO cabinets (id, site_id, name, role, status) VALUES ($1, $2, $3, 'standalone', 'active')", [id, siteId, `K ${id.slice(0, 8)}`]);
  return id;
}
/** A stored services.list answer, as the agent API stores one; minutesAgo orders two answers of one cabinet. */
async function reported(cabinetId: string, services: { name: string; executablePath: string | null }[], minutesAgo = 5): Promise<void> {
  const output = { services: services.map(s => ({ ...s, displayName: s.name, state: "running", startType: "auto", account: null, processId: null, description: null, recovery: null })), watched: [] };
  await db.app.query<any>(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result, result_at)
     VALUES ($1, $2, 'services.list', '{}', $3, DATEADD(minute, -$4, SYSUTCDATETIME()), DATEADD(hour, 1, SYSUTCDATETIME()), 'succeeded', $5, DATEADD(minute, -$4, SYSUTCDATETIME()))`,
    [randomUUID(), cabinetId, issuer, minutesAgo, JSON.stringify({ output })]);
}

test("each service entry counts the cabinets that reported, have its key name, and run its program; applications are not counted", async () => {
  const s = await site();
  const [right, otherProgram, missing, silent] = [await cabinet(s.site), await cabinet(s.site), await cabinet(s.site), await cabinet(s.site)];
  await reported(right, [{ name: "bioscansvc", executablePath: "c:\\program files\\vendor\\SCANNER.EXE" }]);   // names and paths without case, as the agent compares
  await reported(otherProgram, [{ name: "BioScanSvc", executablePath: "C:\\Program Files\\Vendor\\old\\scanner.exe" }]);
  await reported(missing, [{ name: "Spooler", executablePath: "C:\\Windows\\System32\\spoolsv.exe" }]);
  void silent;   // never reported its services: not counted at all
  const list = entries([SCANNER, { key: "app:display", kind: "service", name: "Display name only", path: "C:\\Program Files\\Vendor\\scanner.exe", serviceName: "Bio Scan Service" },
    { key: "app:dispenser", kind: "application", name: "Dispenser", path: "C:\\Program Files\\Vendor\\dispenser.exe" }]);
  assert.deepEqual(await serviceEntryChecks(db.app, "site", s.site, list), [
    { key: "app:display", reported: 3, named: 0, matched: 0 },
    { key: "app:scanner", reported: 3, named: 2, matched: 1 },
  ]);
  // The cabinet that ran the wrong program now runs the named one: only its latest answer counts.
  await reported(otherProgram, [{ name: "BioScanSvc", executablePath: "C:\\Program Files\\Vendor\\scanner.exe" }], 1);
  assert.deepEqual((await serviceEntryChecks(db.app, "site", s.site, entries([SCANNER])))[0], { key: "app:scanner", reported: 3, named: 2, matched: 2 });
  // A cabinet only: its own answer.
  assert.deepEqual((await serviceEntryChecks(db.app, "cabinet", missing, entries([SCANNER])))[0], { key: "app:scanner", reported: 1, named: 0, matched: 0 });
});

test("the scope is the level's own cabinets: another client's cabinets and removed cabinets are not counted", async () => {
  const mine = await site(), theirs = await site();
  const here = await cabinet(mine.site), there = await cabinet(theirs.site), gone = await cabinet(mine.site);
  await reported(here, [{ name: "BioScanSvc", executablePath: "C:\\Program Files\\Vendor\\other.exe" }]);
  await reported(there, [{ name: "BioScanSvc", executablePath: "C:\\Program Files\\Vendor\\scanner.exe" }]);
  await reported(gone, [{ name: "BioScanSvc", executablePath: "C:\\Program Files\\Vendor\\scanner.exe" }]);
  await db.app.query("UPDATE cabinets SET status = 'removed' WHERE id = $1", [gone]);
  assert.deepEqual((await serviceEntryChecks(db.app, "client", mine.client, entries([SCANNER])))[0], { key: "app:scanner", reported: 1, named: 1, matched: 0 });
  assert.deepEqual((await serviceEntryChecks(db.app, "client", theirs.client, entries([SCANNER])))[0], { key: "app:scanner", reported: 1, named: 1, matched: 1 });
  const fleet = (await serviceEntryChecks(db.app, "fleet", null, entries([SCANNER])))[0]!;
  assert.ok(fleet.reported >= 2 && fleet.matched >= 1 && fleet.matched < fleet.reported, JSON.stringify(fleet));
});

test("a reported answer that is not a service list, or names are hostile text, counts as nothing and breaks nothing", async () => {
  const s = await site();
  const odd = await cabinet(s.site), hostile = await cabinet(s.site);
  await db.app.query<any>(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result, result_at)
     VALUES ($1, $2, 'services.list', '{}', $3, SYSUTCDATETIME(), DATEADD(hour, 1, SYSUTCDATETIME()), 'succeeded', $4, SYSUTCDATETIME())`,
    [randomUUID(), odd, issuer, JSON.stringify({ output: { services: "not a list" } })]);
  await reported(hostile, [{ name: "BioScanSvc' OR 1=1 --", executablePath: "C:\\Program Files\\Vendor\\scanner.exe" }, { name: "x".repeat(80), executablePath: null }]);
  assert.deepEqual((await serviceEntryChecks(db.app, "site", s.site, entries([SCANNER])))[0], { key: "app:scanner", reported: 2, named: 0, matched: 0 });
  assert.deepEqual(await serviceEntryChecks(db.app, "site", s.site, []), [], "no entries: no query, nothing to say");
});

test("the editor's responses carry the checks for the list it shows, at every level, to any signed-in role that can read it", async () => {
  const s = await site();
  const k = await cabinet(s.site);
  await reported(k, [{ name: "BioScanSvc", executablePath: "C:\\Program Files\\Vendor\\other.exe" }]);
  await writeApprovedLevel(db.app, "site", s.site, JSON.parse(storedApprovedApps([SCANNER], issuer)), issuer);
  const tier1 = await h.account("tier1");
  const got = await h.call("GET", `/api/sites/${s.site}/approved-apps`, undefined, tier1);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.deepEqual(got.body.checks, [{ key: "app:scanner", reported: 1, named: 1, matched: 0 }]);
  for (const url of ["/api/admin/approved-apps", `/api/clients/${s.client}/approved-apps`, `/api/cabinets/${k}/approved-apps`]) {
    const r = await h.call("GET", url, undefined, tier1);
    assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body.checks), url);
  }
  assert.equal((await h.call("GET", `/api/sites/${s.site}/approved-apps`, undefined)).status, 401, "not signed in");
});
