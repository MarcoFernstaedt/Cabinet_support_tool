// Automatic, system-side changes that touch alerts must leave an audit entry of their own (plan section 9): the site-outage check closes
// alerts by itself and a retention batch deletes rows by itself, so what the system did to a customer's data has to be readable afterwards.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QueryResult, Queryable } from "../src/db/db.js";
import { inBatches } from "../src/services/maintenance.js";
import { raiseSecurityAlert } from "../src/services/security.js";
import { checkSiteOutages } from "../src/services/site-outage.js";

/** A stand-in for the database: statements are answered by their text, and every audit entry it is asked to write is kept as text. */
class FakeDb implements Queryable {
  readonly calls: { text: string; params: readonly unknown[] }[] = [];
  readonly audits: { action: string; details: string }[] = [];
  /** What the security-alert merge says it did: still true only for the first occurrence of a signature. */
  securityCreated = true;
  /** Row counts for the deletion statements, in the order they are asked for. */
  rowCounts: number[] = [];

  private reply<R>(rows: unknown[], rowCount = rows.length): QueryResult<R> {
    return { rows: rows as R[], rowCount };
  }

  async query<R = any>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    this.calls.push({ text, params });
    if (/audit_append_many/.test(text)) {
      const list = JSON.parse(String(params[0] ?? "[]")) as { action: string; details: string }[];
      const first = this.audits.length + 1;
      for (const e of list) this.audits.push({ action: e.action, details: e.details });
      return this.reply<R>([{ first: String(first), last: String(first + list.length - 1) }]);
    }
    if (/audit_append/.test(text)) {
      this.audits.push({ action: String(params[2]), details: String(params[6]) });
      return this.reply<R>([{ seq: String(this.audits.length) }]);
    }
    if (/FROM issue_types/.test(text)) return this.reply<R>([{ name: "Site outage", severity: "major" }]);
    if (/WITH sites_down AS/.test(text)) return this.reply<R>([]);
    if (/SELECT a\.id FROM alerts a JOIN cabinets k/.test(text)) return this.reply<R>([{ id: "11111111-1111-1111-1111-111111111111" }]);
    // The close's rows as closeAutomatically reads them back from its table variable (D99): the alert, its cabinet and the resolution.
    if (/UPDATE a SET a\.state = 'resolved'/.test(text))
      return this.reply<R>([{ id: "11111111-1111-1111-1111-111111111111", cabinet_id: "22222222-2222-2222-2222-222222222222", resolution: "A cabinet at the site is reporting again." }]);
    if (/UPDATE alerts SET state = 'resolved'/.test(text)) return this.reply<R>([], 1);
    if (/MERGE security_alerts/.test(text)) return this.reply<R>([{ id: "security-1", created: this.securityCreated }]);
    if (/DELETE TOP \(\$1\)/.test(text)) return this.reply<R>([], this.rowCounts.shift() ?? 0);
    return this.reply<R>([]);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

describe("automatic changes are audited", () => {
  it("records an audit entry for every change to a security alert, not only the first", async () => {
    const db = new FakeDb();
    await raiseSecurityAlert(db, { kind: "audit_chain", signature: "audit_chain|7", title: "The audit chain is broken at entry 7" });
    db.securityCreated = false; // the same signature again: it folds into the open alert
    await raiseSecurityAlert(db, { kind: "audit_chain", signature: "audit_chain|7", title: "The audit chain is broken at entry 7" });
    assert.equal(db.audits.filter(a => a.action === "security.alert").length, 2);
  });

  it("records the alerts the site-outage check closes by itself, and re-checks the site in the closing statement", async () => {
    const db = new FakeDb();
    const r = await checkSiteOutages(db);
    assert.equal(r.resolved, 1);
    const closing = db.calls.find(c => /SET a\.state = 'resolved'/.test(c.text));
    assert.ok(closing, "the alert was closed");
    assert.match(closing.text, /EXISTS \(SELECT 1 FROM cabinets y WHERE y\.site_id = k\.site_id AND y\.status = 'active'/);
    assert.equal(db.audits.filter(a => a.action === "alert.resolve").length, 1);
    assert.match(db.audits.find(a => a.action === "alert.resolve")!.details, /"automatic":true/);
  });

  it("leaves an audit entry for every retention batch that removed anything", async () => {
    const db = new FakeDb();
    db.rowCounts = [1000, 3]; // a full batch, then the last, short one
    const total = await inBatches(db, "DELETE TOP ($1) FROM events WHERE received_at < $2", [new Date(0)], { batch: 1000, pauseMs: 0, timeoutMs: 1_000 },
      { table: "events", cutoff: new Date(0) });
    assert.equal(total, 1003);
    const entries = db.audits.filter(a => a.action === "retention.batch");
    assert.equal(entries.length, 2);
    assert.match(entries[0]!.details, /"table":"events"/);
    assert.match(entries[0]!.details, /"rows":1000/);
    assert.match(entries[1]!.details, /"rows":3/);
  });
});
