// The release package upload (docs/spec/07-upgrade-channel.md "Signing flow" step 3, plan section 9): the temporary file belongs to one
// upload only and is created exclusively, and the release row is read again, re-authorized and its changed-row count counted at the moment
// the package is published — not only before the body is streamed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import type { Pool, QueryResult, Queryable } from "../src/db/db.js";
import { receiveReleasePackage, type ReleaseStore } from "../src/services/releases.js";

const VERSION = "1.2.3";
const PAYLOAD = Buffer.from("package bytes, exactly the ones the signed manifest hashes");
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");
const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

interface ReleaseState { state: string; added_by: string; sha256: string; size_bytes: string }

/** A stand-in for the database: statements are answered by their text, and a test says what the row became and how many rows changed. */
class FakeDb implements Queryable {
  readonly calls: { text: string; params: readonly unknown[] }[] = [];
  readonly audits: { action: string; outcome: string }[] = [];
  state: ReleaseState = { state: "awaiting_package", added_by: OWNER, sha256: SHA, size_bytes: String(PAYLOAD.length) };
  /** What the row looks like when the publish reads it again: the world changing while the body streams. */
  atCommit: ReleaseState | null = null;
  /** How many rows the statement that publishes the package reports it changed. */
  updateRows = 1;

  private reply<R>(rows: unknown[], rowCount = rows.length): QueryResult<R> {
    return { rows: rows as R[], rowCount };
  }

  async query<R = any>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    this.calls.push({ text, params });
    if (/audit_append/.test(text)) {
      this.audits.push({ action: String(params[2]), outcome: String(params[5]) });
      return this.reply<R>([{ seq: String(this.audits.length) }]);
    }
    if (/sp_getapplock/.test(text)) return this.reply<R>([]);
    if (/WITH \(UPDLOCK\)/.test(text)) return this.reply<R>([{ ...(this.atCommit ?? this.state) }]);
    if (/FROM agent_releases WHERE version = \$1/.test(text)) return this.reply<R>([{ ...this.state }]);
    if (/UPDATE agent_releases SET state = 'ready'/.test(text)) {
      if (this.updateRows === 1) this.state = { ...this.state, state: "ready" };
      return this.reply<R>([], this.updateRows);
    }
    if (/UPDATE agent_releases SET state = 'refused'/.test(text)) {
      this.state = { ...this.state, state: "refused" };
      return this.reply<R>([], 1);
    }
    if (/FROM agent_releases r JOIN users/.test(text)) return this.reply<R>([listRow(this.state.state)]);
    return this.reply<R>([]);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

const listRow = (state: string) => ({ version: VERSION, minimum_version: "1.0.0", sha256: SHA, size_bytes: String(PAYLOAD.length), released_at: new Date(), notes: null,
  state, refusal: null, key_id: "test-key", added_by: OWNER, added_by_name: "Admin", added_at: new Date(), package_at: null });

const storeIn = async (): Promise<ReleaseStore> => ({ dir: await mkdtemp(join(tmpdir(), "cabinet-release-")), maxBytes: 10_000_000, keys: {} as ReleaseStore["keys"] });
const packageFile = (s: ReleaseStore): string => join(s.dir, `agent-${VERSION}.zip`);
const inIncoming = (s: ReleaseStore): Promise<string[]> => readdir(join(s.dir, ".incoming")).catch(() => []);
const exists = (p: string): Promise<boolean> => readFile(p).then(() => true, () => false);
const refused = (code: string) => (e: unknown): boolean => {
  assert.equal((e as { code?: string }).code, code);
  return true;
};
const upload = (db: FakeDb, s: ReleaseStore, admin = OWNER, body: Readable = Readable.from([PAYLOAD])) =>
  receiveReleasePackage(db as unknown as Pool, s, admin, VERSION, body);

const waitFor = async (done: () => Promise<boolean>, ms: number): Promise<void> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await done()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.fail("the upload never reached the point this test waits for");
};

describe("release package upload", () => {
  it("refuses the package of an Admin who did not add the release", async () => {
    const s = await storeIn();
    const db = new FakeDb();
    await assert.rejects(upload(db, s, OTHER), refused("not_yours"));
    assert.equal(db.state.state, "awaiting_package");
    assert.equal(await exists(packageFile(s)), false);
    assert.deepEqual(await inIncoming(s), []);
  });

  it("refuses when the release is no longer waiting for its package by the time it is published", async () => {
    const s = await storeIn();
    const db = new FakeDb();
    db.atCommit = { ...db.state, state: "withdrawn" };
    await assert.rejects(upload(db, s), refused("not_awaiting_package"));
    assert.equal(db.state.state, "awaiting_package");
    assert.equal(await exists(packageFile(s)), false);
  });

  it("refuses when the release changed owner while the package was streaming", async () => {
    const s = await storeIn();
    const db = new FakeDb();
    db.atCommit = { ...db.state, added_by: OTHER };
    await assert.rejects(upload(db, s), refused("not_yours"));
    assert.equal(await exists(packageFile(s)), false);
  });

  it("refuses when the signed manifest changed while the package was streaming", async () => {
    const s = await storeIn();
    const db = new FakeDb();
    db.atCommit = { ...db.state, sha256: "f".repeat(64) };
    await assert.rejects(upload(db, s), refused("release_changed"));
    assert.equal(await exists(packageFile(s)), false);
  });

  it("counts the rows the publishing statement changed, and publishes nothing when it was not one", async () => {
    const s = await storeIn();
    const db = new FakeDb();
    db.updateRows = 0; // a concurrent change: the statement matched no row
    await assert.rejects(upload(db, s), refused("release_changed"));
    assert.equal(await exists(packageFile(s)), false);
  });

  it("publishes a valid package: the release is ready, the file is exactly what was uploaded, and an audit entry says so", async () => {
    const s = await storeIn();
    const db = new FakeDb();
    await upload(db, s);
    assert.equal(db.state.state, "ready");
    assert.deepEqual(await readFile(packageFile(s)), PAYLOAD);
    assert.deepEqual(await inIncoming(s), []);
    assert.equal(db.audits.filter(a => a.action === "release.package" && a.outcome === "succeeded").length, 1);
  });

  it("streams to a temporary file of its own, named for that upload", async () => {
    const s = await storeIn();
    const db = new FakeDb();
    const body = new Readable({ read() { /* nothing yet: the upload is still in flight */ } });
    const running = upload(db, s, OWNER, body);
    await waitFor(async () => (await inIncoming(s)).length === 1, 2_000);
    const files = await inIncoming(s);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^agent-1\.2\.3\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.zip$/);
    assert.equal(await exists(packageFile(s)), false, "nothing is published before the upload is complete");
    body.push(PAYLOAD);
    body.push(null);
    await running;
    assert.equal(db.state.state, "ready");
    assert.deepEqual(await inIncoming(s), [], "the temporary file is gone once the package is in place");
  });
});
