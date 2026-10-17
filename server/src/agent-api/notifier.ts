// Wakes long polls when a command for their cabinet is inserted, from any server process: the commands table's trigger writes
// a row to the notifications table, and the NotificationFeed (one per server process) hands it to this class.
import type { NotificationFeed } from "../db/notifications.js";

export class CommandNotifier {
  private readonly waiters = new Map<string, Set<() => void>>();
  /** How many wakes each cabinet has had, so a long poll notices one that came between its database check and its wait. */
  private readonly woken = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;
  private sweep: NodeJS.Timeout | null = null;

  /** While the feed is not running (starting, or stopped), long polls fall back to re-checking the database every few seconds. */
  get listening(): boolean { return this.unsubscribe !== null && this.feed.running; }

  constructor(private readonly feed: NotificationFeed) {}

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = this.feed.on("cabinet_commands", payload => this.wake(payload));
    // Wake counters only need to outlive one long poll; forget the idle ones.
    this.sweep ??= setInterval(() => { for (const k of this.woken.keys()) if (!this.waiters.has(k)) this.woken.delete(k); }, 60_000);
    this.sweep.unref();
  }

  /** The cabinet's wake counter now; pass it to wait() so a wake in between is not lost. */
  mark(cabinetId: string): number { return this.woken.get(cabinetId) ?? 0; }

  /** Resolves when a command for this cabinet may be waiting (now, if it was woken since mark), or after the timeout, or on abort. */
  wait(cabinetId: string, timeoutMs: number, signal: AbortSignal, since?: number): Promise<void> {
    if (since !== undefined && this.mark(cabinetId) !== since) return Promise.resolve();
    return new Promise(resolve => {
      const set = this.waiters.get(cabinetId) ?? new Set();
      this.waiters.set(cabinetId, set);
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        set.delete(done);
        if (set.size === 0) this.waiters.delete(cabinetId);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      signal.addEventListener("abort", done, { once: true });
      set.add(done);
    });
  }

  wake(cabinetId: string): void {
    this.woken.set(cabinetId, (this.woken.get(cabinetId) ?? 0) + 1);
    for (const done of [...(this.waiters.get(cabinetId) ?? [])]) done();
  }

  get waiting(): number { let n = 0; for (const s of this.waiters.values()) n += s.size; return n; }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    for (const cabinet of [...this.waiters.keys()]) this.wake(cabinet);
  }
}
