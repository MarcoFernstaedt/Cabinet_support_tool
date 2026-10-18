// Presence (docs/spec/03-protocol.md "Protocol 1.1"): a long poll counts as contact. Contact is kept in memory and written in one
// batched statement a minute, into cabinets.last_heartbeat_at, which every "offline after 5 minutes" judgement reads. With polls every
// 25 s and a flush every 60 s, a connected cabinet's recorded contact is never more than about 90 s old, well inside the threshold.
import { errorInfo, type Queryable } from "../db/db.js";

/** Rows per statement: OPENJSON of 2,000 small objects is one cheap set-based update. */
const CHUNK = 2_000;

export class Presence {
  private seen = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<unknown> | null = null;

  constructor(private readonly db: Queryable, private readonly log: (message: string) => void = () => undefined) {}

  /** This cabinet was heard from now. */
  touch(cabinetId: string): void { this.seen.set(cabinetId, Date.now()); }

  /** Contacts waiting for the next flush. */
  get size(): number { return this.seen.size; }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.flush().catch(e => this.log(`presence flush failed: ${JSON.stringify(errorInfo(e))}`)); }, intervalMs);
    this.timer.unref();
  }

  /** Stops the timer and writes what is left (on shutdown). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush().catch(e => this.log(`presence flush failed: ${JSON.stringify(errorInfo(e))}`));
  }

  /** Writes every contact noted since the last flush; a contact is never moved backwards. Returns the rows written. */
  flush(): Promise<number> {
    // One flush at a time; a second caller waits for the running one and then writes what arrived meanwhile.
    const run = async (): Promise<number> => {
      if (this.seen.size === 0) return 0;
      const batch = this.seen;
      this.seen = new Map();
      const entries = [...batch].map(([id, at]) => ({ id, at: new Date(at).toISOString() }));
      let written = 0;
      try {
        for (let i = 0; i < entries.length; i += CHUNK) {
          const r = await this.db.query(
            `UPDATE k SET last_heartbeat_at = j.[at]
               FROM cabinets k JOIN OPENJSON($1) WITH (id uniqueidentifier '$.id', [at] datetime2(3) '$.at') j ON k.id = j.id
              WHERE k.status = 'active' AND (k.last_heartbeat_at IS NULL OR k.last_heartbeat_at < j.[at])`, [JSON.stringify(entries.slice(i, i + CHUNK))]);
          written += r.rowCount;
        }
      } catch (e) {
        // Kept for the next try, unless a newer contact arrived meanwhile.
        for (const [id, at] of batch) if ((this.seen.get(id) ?? 0) < at) this.seen.set(id, at);
        throw e;
      }
      return written;
    };
    const next = (this.flushing ?? Promise.resolve(0)).then(run);
    this.flushing = next.catch(() => 0);
    return next;
  }
}
