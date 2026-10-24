// The audit chain check (docs/spec/05-server-spec.md "Audit log", plan section 9): a full verification must not report success after the
// tail of the log was truncated or deleted, and a check a person asks for must not walk the whole log on every request.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { auditHashInput, verifyAuditChain, type Pool, type QueryResult, type Queryable } from "../src/db/db.js";
import { ON_DEMAND_CHAIN_ENTRIES, verifyChainAndAlert } from "../src/services/maintenance.js";

interface Entry { seq: number; at_text: string; actor_kind: string; actor_id: string; action: string; target_kind: string | null; target_id: string | null; outcome: string; details_raw: string; prev_hash: string; hash: string }

/** A hash chain of `n` genuine entries, built the way the append path builds it. */
function chain(n: number): Entry[] {
  const rows: Entry[] = [];
  let previous = "0".repeat(64);
  for (let seq = 1; seq <= n; seq++) {
    const base = { seq, at_text: `2026-10-01T00:00:0${seq % 10}.0000000`, actor_kind: "system", actor_id: "test", action: `test.action.${seq}`,
      target_kind: null, target_id: null, outcome: "succeeded", details_raw: "{}" };
    const hash = createHash("sha256").update(auditHashInput(previous, base), "utf16le").digest("hex");
    rows.push({ ...base, prev_hash: previous, hash });
    previous = hash;
  }
  return rows;
}

/** A stand-in for the audit log: it serves the stored entries and the append path's anchored high-water mark (audit_chain_head). */
class FakeLog implements Queryable {
  readonly calls: string[] = [];
  checkpoint = { seq: 0, hash: "0".repeat(64) };
  slow = 0;

  constructor(readonly entries: Entry[], readonly anchor: { seq: number; hash: string } | null) {}

  /** How many times the log itself was walked (a request that reuses a running or recent check does not walk it at all). */
  walks(): number {
    return this.calls.filter(t => /FROM audit_log WHERE seq >=/.test(t)).length;
  }

  private reply<R>(rows: unknown[], rowCount = rows.length): QueryResult<R> {
    return { rows: rows as R[], rowCount };
  }

  async query<R = any>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    this.calls.push(text);
    if (this.slow > 0) await new Promise(r => setTimeout(r, this.slow));
    if (/audit_head/.test(text)) return this.reply<R>(this.anchor === null ? [] : [{ seq: String(this.anchor.seq), hash: this.anchor.hash }]);
    if (/FROM audit_log WHERE seq >= \$1/.test(text)) {
      const from = Number(params[0]);
      const top = Number((/SELECT TOP \((\d+)\)/.exec(text)?.[1] ?? "0"));
      const rows = this.entries.filter(e => e.seq >= from).slice(0, top > 0 ? top : undefined);
      return this.reply<R>(rows);
    }
    if (/FROM audit_log WHERE seq = \$1/.test(text)) {
      const entry = this.entries.find(e => e.seq === Number(params[0]));
      return this.reply<R>(entry ? [{ hash: entry.hash }] : []);
    }
    if (/FROM audit_checkpoint/.test(text)) return this.reply<R>([{ seq: String(this.checkpoint.seq), hash: this.checkpoint.hash }]);
    if (/audit_checkpoint_advance/.test(text)) {
      this.checkpoint = { seq: Number(params[0]), hash: String(params[1]) };
      return this.reply<R>([]);
    }
    if (/MERGE security_alerts/.test(text)) return this.reply<R>([{ id: "alert-1", created: true }]);
    if (/audit_append/.test(text)) return this.reply<R>([{ seq: String(this.entries.length + 1) }]);
    return this.reply<R>([]);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

const pool = (log: FakeLog): Pool => log as unknown as Pool;
/** The anchored mark saying where the log ends: a check that reached a lower entry has been reading a truncated log. */
type Anchored = { headSeq?: number; behindHead?: boolean; more?: boolean; entries: number; lastSeq?: number };

describe("audit chain check", () => {
  it("does not report a whole chain when the last entries were deleted", async () => {
    const entries = chain(5);
    const log = new FakeLog(entries, { seq: 7, hash: "b".repeat(64) });
    const check = await verifyChainAndAlert(pool(log), "weekly", "full");
    assert.equal(check.ok, false);
    const shown = check as unknown as Anchored;
    assert.equal(shown.headSeq, 7);
    assert.equal(shown.behindHead, true);
  });

  it("reports the log as whole when the tail it reached is the tail the append path wrote", async () => {
    const entries = chain(5);
    const log = new FakeLog(entries, { seq: 5, hash: entries[4]!.hash });
    const check = await verifyChainAndAlert(pool(log), "weekly", "full");
    assert.equal(check.ok, true);
    assert.equal((check as unknown as Anchored).behindHead, undefined);
  });

  it("still reports a changed entry in the middle of the chain", async () => {
    const entries = chain(5);
    entries[2] = { ...entries[2]!, hash: "c".repeat(64) };
    const log = new FakeLog(entries, { seq: 5, hash: entries[4]!.hash });
    const check = await verifyChainAndAlert(pool(log), "weekly", "full");
    assert.equal(check.ok, false);
  });

  it("checks on from the checkpoint after a successful whole-log check", async () => {
    const entries = chain(5);
    const log = new FakeLog(entries, { seq: 5, hash: entries[4]!.hash });
    assert.equal((await verifyChainAndAlert(pool(log), "weekly", "full")).ok, true);
    assert.equal(log.checkpoint.seq, 5);
    const again = await verifyChainAndAlert(pool(log), "daily", "incremental");
    assert.equal(again.ok, true);
    assert.equal((again as unknown as Anchored).entries, 0, "an incremental check reads only what was added");
  });

  it("runs one check, not two, when two requests ask for one at the same time", async () => {
    const entries = chain(5);
    const log = new FakeLog(entries, { seq: 5, hash: entries[4]!.hash });
    log.slow = 25;
    const [a, b] = await Promise.all([verifyChainAndAlert(pool(log), { userId: "admin" }), verifyChainAndAlert(pool(log), { userId: "admin" })]);
    assert.equal(log.walks(), 1);
    assert.equal(a.ok, b.ok);
  });

  it("stops a bounded walk at its limit and says so, and reports where the log ends", async () => {
    const entries = chain(20);
    const log = new FakeLog(entries, { seq: 20, hash: entries[19]!.hash });
    const bounded = await verifyAuditChain(log, 10, undefined, { maxEntries: 5, head: { seq: 20, hash: entries[19]!.hash } });
    assert.equal(bounded.more, true);
    assert.equal(bounded.entries, 5);
    assert.equal(bounded.lastSeq, 5);
    assert.equal(bounded.headSeq, 20);
    assert.equal(bounded.behindHead, undefined, "a walk that stopped early says nothing about the end of the log");
    const rest = await verifyAuditChain(log, 10, { seq: 5, hash: entries[4]!.hash }, { head: { seq: 20, hash: entries[19]!.hash } });
    assert.equal(rest.ok, true);
    assert.equal(rest.lastSeq, 20);
    assert.equal(ON_DEMAND_CHAIN_ENTRIES > 5, true);
  });

  it("still checks the chain when the database has no anchored mark to compare with", async () => {
    const entries = chain(5);
    const log = new FakeLog(entries, null);
    const check = await verifyChainAndAlert(pool(log), "weekly", "full");
    assert.equal(check.ok, true);
  });
});
