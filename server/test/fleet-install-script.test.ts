// The fleet install script (decision-log D57): for a site installer, a PowerShell script a remote management tool runs as SYSTEM on each of
// the site's cabinets. It downloads the agent package from the console with the site installer's token in the Authorization header, refuses
// it unless its SHA-256 is the one the script was made with, and installs. Through the real console routes on a real SQL Server, with the
// hostile and malformed requests a script on a cabinet, or someone without one, could make.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { SecretBox } from "../src/auth/secrets.js";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { NotificationFeed } from "../src/db/notifications.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { fleetInstallScript } from "../src/console-api/fleet-install-script.js";
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
let admin: Account;
let siteId: string;
let caPem: string;
const downloadDir = tempDir();
const x64 = Buffer.from("PK\u0003\u0004 the 64-bit agent package, as the server serves it");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test.before(async () => {
  db = await createTestDatabase();
  feed = new NotificationFeed(db.app, 50);
  await feed.start();
  stream = new ResultStream(feed, db.app);
  await stream.start();
  writeFileSync(join(downloadDir, "CabinetAgent-win-x64.zip"), x64);
  const issuingKey = await developmentIssuingKey(tempDir());
  caPem = issuingKey.certificatePem;
  app = await buildConsoleApi({ pool: db.app, secrets, issuingKey, origin: ORIGIN, stream, logger: false, now: () => h.clock,
    agentSetup: { host: "agents.example.test", port: 8443, downloadDir } });
  h.db = db; h.app = app;
  admin = await h.account("admin");
  const clientId = randomUUID();
  siteId = randomUUID();
  await db.app.query("INSERT INTO clients (id, name) VALUES ($1, 'Harbour')", [clientId]);
  await db.app.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Pier')", [siteId, clientId]);
});
test.after(async () => { await app.close(); await stream.stop(); feed.stop(); await db.drop(); });

async function makeScript(cabinets = 3): Promise<{ status: number; body: { fileName: string; script: string; cabinets?: number; error?: string } }> {
  const body = { format: "fleet-script", site: { siteId, cabinets, days: 7 } };
  return call("POST", "/api/admin/installer", { ...body, stepUpToken: await h.codeToken(admin, "token.create", "fleet", body) }, admin);
}
const tokenIn = (script: string) => /\$token = '([A-Za-z0-9_-]+)'/.exec(script)![1]!;
const download = (headers: Record<string, string>, query = "?architecture=windows-x64") => app.inject({ method: "GET", url: `/api/install/package${query}`, headers });

test("a fleet install script is made for a site installer: it pins the package's SHA-256 and the console address, and holds the token", async () => {
  const r = await makeScript();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.fileName, "Install-CabinetAgent-Fleet.ps1");
  assert.equal(r.body.cabinets, 3);
  const s = r.body.script;
  assert.ok(s.includes(`'windows-x64' = '${sha(x64)}'`), "the 64-bit package's SHA-256 is pinned");
  assert.ok(s.includes("'windows-x86' = $null"), "no 32-bit package on this server: the script says so rather than guess");
  assert.ok(s.includes(`$consoleOrigin = '${ORIGIN}'`));
  assert.ok(s.includes("$serverHost = 'agents.example.test'") && s.includes("$serverPort = 8443"));
  assert.ok(s.includes("Authorization = ('Bearer ' + $token)"), "the token goes in the header");
  assert.ok(!s.includes("architecture=' + $architecture + '&"), "and never in the address");
  assert.ok(!s.includes("Downloads"), "nothing is looked for in a person's folders");
  assert.ok([...s].every(c => c.charCodeAt(0) < 128), "ASCII only");
  // A fleet script is never made for one cabinet's token.
  const single = { format: "fleet-script" };
  const refused = await call("POST", "/api/admin/installer", { ...single, stepUpToken: await h.codeToken(admin, "token.create", "fleet", single) }, admin);
  assert.deepEqual([refused.status, refused.body.error], [400, "site_required"]);
  // A code confirmed for a launcher does not make a fleet script: the format is part of what was confirmed.
  const launcher = { site: { siteId, cabinets: 3, days: 7 } };
  const swapped = await call("POST", "/api/admin/installer", { format: "fleet-script", ...launcher, stepUpToken: await h.codeToken(admin, "token.create", "fleet", launcher) }, admin);
  assert.notEqual(swapped.status, 200);
});

test("the package is served to a usable site installer token in the header, audited, and the download never counts as a use", async () => {
  const token = tokenIn((await makeScript(2)).body.script);
  const ok = await download({ authorization: `Bearer ${token}` });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(sha(ok.rawPayload), sha(x64), "exactly the bytes the script pinned");
  assert.equal(ok.headers["cache-control"], "no-store");
  const tokenRow = (await db.app.query<{ id: string; uses: number }>("SELECT id, uses FROM bootstrap_tokens WHERE token_hash = $1",
    [createHash("sha256").update(token, "utf8").digest()])).rows[0]!;
  assert.equal(Number(tokenRow.uses), 0, "downloading is not enrolling");
  const audited = (await db.app.query<{ details: { architecture: string; sha256: string; siteId: string } }>(
    "SELECT details FROM audit_log WHERE action = 'install.package' AND target_id = $1", [tokenRow.id.toLowerCase()])).rows;
  assert.deepEqual(audited.map(a => [a.details.architecture, a.details.sha256, a.details.siteId]), [["windows-x64", sha(x64), siteId]]);
  // An architecture this server does not have is a plain 404, not the other build.
  assert.equal((await download({ authorization: `Bearer ${token}` }, "?architecture=windows-x86")).statusCode, 404);
});

test("no token, a malformed one, a one-cabinet token, or one stopped, expired or used up gets nothing", async () => {
  const token = tokenIn((await makeScript(1)).body.script);
  for (const headers of [{}, { authorization: token }, { authorization: "Bearer " }, { authorization: "Bearer ' OR 1=1 --" }, { authorization: `Basic ${token}` },
    { authorization: `Bearer ${"A".repeat(43)}` }])
    assert.equal((await download(headers)).statusCode, 401, JSON.stringify(headers));
  // A token in the address, an unknown architecture or a path is refused by the contract before anything else.
  for (const q of [`?architecture=windows-x64&token=${token}`, "?architecture=linux-arm64", "?architecture=..%2F..%2Fetc%2Fpasswd", ""])
    assert.equal((await download({ authorization: `Bearer ${token}` }, q)).statusCode, 400, q);
  const hashOf = (t: string) => createHash("sha256").update(t, "utf8").digest();
  const states: [string, string][] = [
    ["stopped", "UPDATE bootstrap_tokens SET revoked_at = SYSUTCDATETIME() WHERE token_hash = $1"],
    ["expired", "UPDATE bootstrap_tokens SET expires_at = DATEADD(second, -1, SYSUTCDATETIME()) WHERE token_hash = $1"],
    ["used up", "UPDATE bootstrap_tokens SET uses = max_uses WHERE token_hash = $1"],
    ["one cabinet", "UPDATE bootstrap_tokens SET site_id = NULL, role = NULL, max_uses = 1 WHERE token_hash = $1"],
  ];
  for (const [what, sql] of states) {
    const t = tokenIn((await makeScript(1)).body.script);
    assert.equal((await download({ authorization: `Bearer ${t}` })).statusCode, 200, `${what}: usable before`);
    await db.app.query(sql, [hashOf(t)]);
    assert.equal((await download({ authorization: `Bearer ${t}` })).statusCode, 401, what);
  }
});

test("the script is never made from a value that could close a quote, or from a console that is not https", () => {
  const base = { consoleOrigin: "https://console.example.test", host: "agents.example.test", port: 8443, caPem, caSha256: "A".repeat(64),
    packages: { "windows-x64": "a".repeat(64), "windows-x86": null }, token: "A".repeat(43), unsigned: false };
  assert.ok(fleetInstallScript(base).includes("$token = 'AAAA"));
  for (const bad of [{ consoleOrigin: "http://console.example.test" }, { consoleOrigin: "https://x.test/'; Remove-Item C:\\ -Recurse; '" }, { token: "abc'def".padEnd(43, "x") },
    { host: "agents.test'; calc; '" }, { packages: { "windows-x64": "not-a-hash", "windows-x86": null } }, { packages: { "windows-x64": null, "windows-x86": null } }])
    assert.throws(() => fleetInstallScript({ ...base, ...bad } as never), /cannot be made|not valid/, JSON.stringify(bad));
  assert.ok(fleetInstallScript({ ...base, unsigned: true }).includes("-AllowUnsigned"), "a development build is said so in the script");
  assert.ok(!fleetInstallScript(base).includes("-AllowUnsigned"));
});
