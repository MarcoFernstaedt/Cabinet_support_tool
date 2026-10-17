// Wakes work in this server process when another one (or this one) writes a row to the notifications table: a new command wakes
// the long poll held for its cabinet, command results and alerts wake the consoles' live streams. The table is read by id, so a
// row is seen exactly once per process; maintenance deletes rows older than an hour.
import type { Queryable } from "./db.js";

export type NotificationHandler = (payload: string) => void;

export class NotificationFeed {
  private readonly handlers = new Map<string, Set<NotificationHandler>>();
  private last = 0;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(private readonly db: Queryable, private readonly intervalMs = 100) {}

  /** Starts after the newest row, so a restart does not replay old notifications. */
  async start(): Promise<void> {
    if (this.timer) return;
    const r = await this.db.query<{ id: string | null }>("SELECT MAX(id) AS id FROM notifications");
    this.last = Number(r.rows[0]?.id ?? 0);
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** True while the feed is running (a long poll falls back to re-checking the database every few seconds when it is not). */
  get running(): boolean { return this.timer !== null; }

  on(channel: string, handler: NotificationHandler): () => void {
    const set = this.handlers.get(channel) ?? new Set();
    this.handlers.set(channel, set);
    set.add(handler);
    return () => { set.delete(handler); };
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const rows = (await this.db.query<{ id: string; channel: string; payload: string }>(
        "SELECT TOP (500) id, channel, payload FROM notifications WHERE id > $1 ORDER BY id", [this.last])).rows;
      for (const row of rows) {
        this.last = Number(row.id);
        for (const h of this.handlers.get(row.channel) ?? []) { try { h(row.payload); } catch { /* one listener's failure never stops the others */ } }
      }
    } catch { /* the database is briefly away; the next tick tries again */ } finally { this.polling = false; }
  }
}
