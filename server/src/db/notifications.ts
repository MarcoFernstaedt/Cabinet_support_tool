// Wakes work in this server process when another one (or this one) writes a row to the notifications table: a new command wakes
// the long poll held for its cabinet, command results and alerts wake the consoles' live streams. Maintenance deletes rows older
// than an hour.
//
// IDENTITY values are handed out when a row is inserted, not when its transaction commits, so a row with a lower id can become
// visible after one with a higher id was already read. Each poll therefore also reads back a short window below the newest id it
// has seen (rows written in the last LOOK_BACK_SECONDS, at most LOOK_BACK_IDS ids back) and skips the ones it has already
// delivered, so a late commit still wakes its listener. A row is delivered at most once per process.
import type { Queryable } from "./db.js";

export type NotificationHandler = (payload: string) => void;

/** How far back each poll looks for rows that committed late. */
export const LOOK_BACK_IDS = 500;
export const LOOK_BACK_SECONDS = 10;
/** After this many failed polls in a row the feed reports itself not running, so a long poll re-checks the database on its own. */
export const FAILURES_UNTIL_DOWN = 3;
const MAX_ROWS = 2_000;

export class NotificationFeed {
  private readonly handlers = new Map<string, Set<NotificationHandler>>();
  private last = 0;
  /** Rows at or below this id existed before the feed started: never delivered, not even by the look-back window. */
  private floor = 0;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private failures = 0;
  /** Ids delivered recently (id → when), to skip them when the look-back window reads them again. */
  private readonly seen = new Map<number, number>();

  constructor(private readonly db: Queryable, private readonly intervalMs = 100) {}

  /** Starts after the newest row, so a restart does not replay old notifications. */
  async start(): Promise<void> {
    if (this.timer) return;
    const r = await this.db.query<{ id: string | null }>("SELECT MAX(id) AS id FROM notifications");
    this.last = Number(r.rows[0]?.id ?? 0);
    this.floor = this.last;
    this.failures = 0;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /**
   * True while the feed is running and its polls succeed (a long poll falls back to re-checking the database every few seconds when it is
   * not). It turns false after FAILURES_UNTIL_DOWN failed polls in a row and true again with the next successful one.
   */
  get running(): boolean { return this.timer !== null && this.failures < FAILURES_UNTIL_DOWN; }

  on(channel: string, handler: NotificationHandler): () => void {
    const set = this.handlers.get(channel) ?? new Set();
    this.handlers.set(channel, set);
    set.add(handler);
    return () => { set.delete(handler); };
  }

  /** One poll; the timer calls it, and tests may call it directly. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      // The last row carries the table's highest id (channel NULL), so a restored or reseeded table is noticed in the same round trip.
      const rows = (await this.db.query<{ id: string | null; channel: string | null; payload: string | null }>(
        `SELECT id, channel, payload FROM (
           SELECT * FROM (SELECT TOP (${MAX_ROWS}) id, channel, payload FROM notifications
                           WHERE id > $1 AND (id > $2 OR [at] > DATEADD(second, -${LOOK_BACK_SECONDS}, SYSUTCDATETIME())) ORDER BY id) n
           UNION ALL SELECT MAX(id), NULL, NULL FROM notifications) x
         ORDER BY CASE WHEN x.channel IS NULL THEN 1 ELSE 0 END, x.id`,
        [Math.max(this.floor, this.last - LOOK_BACK_IDS), this.last])).rows;
      this.failures = 0;
      const now = Date.now();
      let newest = this.last;
      for (const row of rows) {
        if (row.channel === null) {
          // The ids went back (a restore, or the identity was reseeded): carry on from the table's newest row. Rows written in the
          // last few seconds are still read by the look-back window.
          const max = row.id === null ? null : Number(row.id);
          if (max !== null && max < this.last) { newest = max; this.floor = 0; this.seen.clear(); }
          continue;
        }
        const id = Number(row.id);
        if (this.seen.has(id)) continue;
        this.seen.set(id, now);
        if (id > newest) newest = id;
        for (const h of this.handlers.get(row.channel) ?? []) { try { h(row.payload ?? ""); } catch { /* one listener's failure never stops the others */ } }
      }
      this.last = newest;
      this.forget(now);
    } catch {
      this.failures++; // the database is briefly away; the next tick tries again
    } finally { this.polling = false; }
  }

  /** Drops seen ids that can no longer come back in the look-back window. */
  private forget(now: number): void {
    const floor = this.last - LOOK_BACK_IDS;
    const old = now - (LOOK_BACK_SECONDS + 30) * 1000; // a margin for the database clock running ahead of this one
    for (const [id, at] of this.seen) if (id <= floor || at < old) this.seen.delete(id);
  }
}
