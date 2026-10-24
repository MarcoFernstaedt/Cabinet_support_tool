// Lists that grow with the size of a site (plan section 9): a site's cabinets are read a page at a time and counted once, their open-alert
// counts come from one grouped query instead of a correlated count per row, and a fleet-wide reading search reads its page and its counts in
// one round trip and only runs as often as the server has room for.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QueryResult, Queryable } from "../src/db/db.js";
import { MAX_CABINET_PAGE, SITE_CABINET_PAGE, site } from "../src/services/fleet.js";
import { searchReadings } from "../src/services/readings.js";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const CABINETS = [
  { id: "cab-1", name: "Cabinet One", role: "primary", status: "active", last_heartbeat_at: new Date(), agent_version: "1.0.0", read_only: false, hostname: "kc-1", demo_scenario: null, open_alerts: "0" },
  { id: "cab-2", name: "Cabinet Two", role: "secondary", status: "active", last_heartbeat_at: new Date(), agent_version: "1.0.0", read_only: false, hostname: "kc-2", demo_scenario: null, open_alerts: "0" },
];
const SITE_ROW = { id: "site-1", name: "Site One", client_id: "client-1", client_name: "Client One", scanner_hardware_ids: [], client_scanner: null, time_zone: "Europe/Amsterdam",
  network_baseline: null, address: "10.0.0.0", s: "[80]", c: null };

/** A stand-in for the database: statements are answered by their text, and every one it is asked for is kept. */
class FakeDb implements Queryable {
  readonly calls: { text: string; params: readonly unknown[] }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  /** Only when a test asks for it: every fleet-wide search is held until the test lets it go. */
  gate = false;
  private blocked: (() => void)[] = [];

  protected reply<R>(rows: unknown[], rowCount = rows.length): QueryResult<R> {
    return { rows: rows as R[], rowCount };
  }

  /** Holds every fleet-wide reading search until the test lets it go, so overlapping searches are countable. */
  protected async hold(text: string): Promise<void> {
    if (!this.gate || !/WITH latest AS/.test(text)) return;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise<void>(r => this.blocked.push(r));
    this.inFlight -= 1;
  }

  /** Lets the searches that are waiting for a slot go on. */
  open(): void {
    const waiting = this.blocked;
    this.blocked = [];
    for (const r of waiting) r();
  }

  async query<R = any>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    this.calls.push({ text, params });
    if (/WITH latest AS/.test(text)) {
      await this.hold(text);
      const counts = /cabinets_read FROM counted/.test(text) ? { cabinets_read: "1", total: "1" } : {};
      return this.reply<R>([{ id: "cab-1", name: "Cabinet One", role: "primary", site: "Site One", client: "Client One", demo: false, read_at: new Date(), output: null, ...counts }]);
    }
    if (/SELECT COUNT\(\*\) AS n FROM cabinets k WHERE k\.site_id = \$1/.test(text)) return this.reply<R>([{ n: "5" }]);
    if (/FROM cabinets k WHERE k\.site_id = \$1 AND k\.status <> 'removed'/.test(text)) return this.reply<R>(CABINETS);
    if (/FROM alerts WHERE state <> 'resolved' AND cabinet_id IN/.test(text)) return this.reply<R>([{ cabinet_id: "cab-1", n: "2" }, { cabinet_id: "cab-2", n: "0" }]);
    if (/FROM sites s JOIN clients c ON c\.id = s\.client_id WHERE s\.id = \$1/.test(text)) return this.reply<R>([SITE_ROW]);
    return this.reply<R>([]);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

type SitePage = { cabinets: { id: string; openAlerts?: number }[]; cabinetCount?: number; cabinetsPage?: { limit: number; offset: number; hasMore: boolean } };

describe("a site's cabinets are read one page at a time", () => {
  const readPage = async (db: FakeDb, page: { limit?: number; offset?: number }) => (await site(db, "site-1", page)) as unknown as SitePage;

  it("asks for one page of cabinets, and never for more than the most a caller may have", async () => {
    const db = new FakeDb();
    const result = await readPage(db, { limit: 10_000, offset: 0 });
    const query = db.calls.find(c => /FROM cabinets k WHERE k\.site_id = \$1 AND k\.status <> 'removed'/.test(c.text));
    assert.ok(query, "the cabinets were read");
    assert.match(query.text, /ORDER BY k\.name OFFSET \$2 ROWS FETCH NEXT \$3 ROWS ONLY/);
    assert.deepEqual(query.params, ["site-1", 0, MAX_CABINET_PAGE]);
    assert.equal(result.cabinetCount, 5, "the page says how many cabinets the site has");
    assert.deepEqual(result.cabinetsPage, { limit: MAX_CABINET_PAGE, offset: 0, hasMore: true });
    assert.equal(SITE_CABINET_PAGE < MAX_CABINET_PAGE, true);
  });

  it("counts the open alerts of the page's cabinets in one query, not one per cabinet", async () => {
    const db = new FakeDb();
    const result = await readPage(db, {});
    assert.equal(result.cabinets.length, 2);
    assert.equal(result.cabinets[0]!.openAlerts, 2);
    assert.equal(result.cabinets[1]!.openAlerts, 0);
    assert.equal(db.calls.filter(c => /FROM alerts WHERE state <> 'resolved' AND cabinet_id IN/.test(c.text)).length, 1);
    assert.equal(db.calls.some(c => /FROM alerts a WHERE a\.cabinet_id = k\.id/.test(c.text)), false, "no correlated count per row");
  });
});

describe("a fleet-wide reading search", () => {
  it("reads its page and its counts in one round trip", async () => {
    const db = new FakeDb();
    const result = (await searchReadings(db, "system.security", "defender_off", {})) as unknown as { cabinetsInScope: number };
    assert.equal(db.calls.length, 1);
    assert.match(db.calls[0]!.text, /cabinets_read/);
    assert.match(db.calls[0]!.text, /cabinets k JOIN sites s ON s\.id = k\.site_id WHERE k\.status = 'active'/, "what the page was drawn from is counted in the same statement");
    assert.equal(result.cabinetsInScope, 1);
  });

  it("runs no more searches at once than the server has room for", async () => {
    const db = new FakeDb();
    db.gate = true;
    const searches = [0, 1, 2].map(() => searchReadings(db, "system.security", "defender_off", {}).then(() => "done", () => "failed"));
    await sleep(80);
    assert.equal(db.maxInFlight, 2, "the third search waits for a slot");
    for (let i = 0; i < 5; i++) {
      db.open();
      await sleep(20);
    }
    assert.deepEqual(await Promise.all(searches), ["done", "done", "done"]);
  });

  it("refuses a search when the ones already running and waiting fill the queue", async () => {
    const db = new FakeDb();
    db.gate = true;
    const running = [0, 1, 2, 3, 4, 5].map(() => searchReadings(db, "system.security", "defender_off", {}).then(() => "done", () => "failed"));
    const outcome = await Promise.race([
      searchReadings(db, "system.security", "defender_off", {}).then(() => "ran", (e: unknown) => (e as { code?: string }).code ?? "error"),
      sleep(300).then(() => "still waiting"),
    ]);
    assert.equal(outcome, "busy");
    for (let i = 0; i < 8; i++) {
      db.open();
      await sleep(20);
    }
    await Promise.all(running);
  });
});
