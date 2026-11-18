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
import { pe, zip } from "./package-pki.js";
import { agentPackage } from "./release-kit.js";

const VERSION = "1.2.3";
const ARCHITECTURE = "windows-x64";
// The package is a real zip whose programs are readable Windows programs: the server reads the architecture out of them before
// it publishes anything, so bytes that are not a package at all can no longer reach the store (its own case is below).
// A release package holds every program the updater installs, one folder per program at the zip root: a package with
// only some of them is refused at upload (`missingReleasePrograms`), because the updater would fail on the name it
// cannot find. The kit's agentPackage is that layout, which is what makes it the right fixture here.
const programs = (architecture: "windows-x64" | "windows-x86"): Buffer => agentPackage(architecture);
const PAYLOAD = programs("windows-x64");
const OTHER_ARCHITECTURE = programs("windows-x86");
const NOT_A_PACKAGE = Buffer.from("these are not the bytes of any package");
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const SHA = sha(PAYLOAD);
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

const listRow = (state: string) => ({ version: VERSION, architecture: ARCHITECTURE, minimum_version: "1.0.0", sha256: SHA, size_bytes: String(PAYLOAD.length), released_at: new Date(), notes: null,
  state, refusal: null, key_id: "test-key", added_by: OWNER, added_by_name: "Admin", added_at: new Date(), package_at: null });

const storeIn = async (): Promise<ReleaseStore> => ({ dir: await mkdtemp(join(tmpdir(), "cabinet-release-")), maxBytes: 10_000_000, keys: {} as ReleaseStore["keys"] });
const packageFile = (s: ReleaseStore): string => join(s.dir, `agent-${VERSION}-${ARCHITECTURE}.zip`);
const inIncoming = (s: ReleaseStore): Promise<string[]> => readdir(join(s.dir, ".incoming")).catch(() => []);
const exists = (p: string): Promise<boolean> => readFile(p).then(() => true, () => false);
const refused = (code: string) => (e: unknown): boolean => {
  assert.equal((e as { code?: string }).code, code);
  return true;
};
/** The refusal itself, so a test can read the message a human would be shown. */
const failed = async (run: Promise<unknown>): Promise<{ code?: string; message?: string }> => {
  try {
    await run;
  } catch (e) {
    return e as { code?: string; message?: string };
  }
  throw new Error("this upload was expected to be refused, and was not");
};
const upload = (db: FakeDb, s: ReleaseStore, admin = OWNER, body: Readable = Readable.from([PAYLOAD])) =>
  receiveReleasePackage(db as unknown as Pool, s, admin, VERSION, ARCHITECTURE, body);

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

  // The architecture a release was added under is a declaration by the pipeline; the programs inside the package are what it
  // really is. They have to agree, or a cabinet would be handed a package it cannot run.
  it("refuses a package whose programs are built for the other Windows architecture, and stores nothing", async () => {
    const s = await storeIn();
    const db = new FakeDb();
    db.state = { state: "awaiting_package", added_by: OWNER, sha256: sha(OTHER_ARCHITECTURE), size_bytes: String(OTHER_ARCHITECTURE.length) };
    const e = await failed(upload(db, s, OWNER, Readable.from([OTHER_ARCHITECTURE])));
    assert.equal(e.code, "architecture_mismatch");
    assert.match(e.message!, /windows-x86/, "the message names what the programs really are");
    assert.match(e.message!, /windows-x64/, "and what the release claimed");
    assert.equal(await exists(packageFile(s)), false, "the other architecture's package is never published");
    assert.deepEqual(await inIncoming(s), [], "and its bytes are not kept either");
    assert.equal(db.state.state, "refused", "the release goes back with the reason, so the right package can be added");
  });

  it("refuses bytes that are not a package at all, rather than guessing what they are", async () => {
    const s = await storeIn();
    const db = new FakeDb();
    db.state = { state: "awaiting_package", added_by: OWNER, sha256: sha(NOT_A_PACKAGE), size_bytes: String(NOT_A_PACKAGE.length) };
    const e = await failed(upload(db, s, OWNER, Readable.from([NOT_A_PACKAGE])));
    assert.equal(e.code, "package_architecture_unknown");
    assert.match(e.message!, /not a zip/, "the message says what could not be read");
    assert.equal(await exists(packageFile(s)), false);
    assert.equal(db.state.state, "refused");
  });

  it("streams to a temporary file of its own, named for that upload", async () => {
    const s = await storeIn();
    const db = new FakeDb();
    const body = new Readable({ read() { /* nothing yet: the upload is still in flight */ } });
    const running = upload(db, s, OWNER, body);
    await waitFor(async () => (await inIncoming(s)).length === 1, 2_000);
    const files = await inIncoming(s);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^agent-1\.2\.3-windows-x64\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.zip$/);
    assert.equal(await exists(packageFile(s)), false, "nothing is published before the upload is complete");
    body.push(PAYLOAD);
    body.push(null);
    await running;
    assert.equal(db.state.state, "ready");
    assert.deepEqual(await inIncoming(s), [], "the temporary file is gone once the package is in place");
  });
});
