// Wakes long polls when a command for their cabinet is inserted, from any
// server process: the commands table's trigger NOTIFYs, one connection LISTENs.
import pg from "pg";

export class CommandNotifier {
  private readonly waiters = new Map<string, Set<() => void>>();
  private client: pg.Client | null = null;
  private stopped = false;

  constructor(private readonly connectionString: string) {}

  async start(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on("notification", msg => { if (msg.channel === "cabinet_commands" && msg.payload) this.wake(msg.payload); });
    client.on("error", () => { if (!this.stopped) void this.restart(); });
    await client.connect();
    await client.query("LISTEN cabinet_commands");
    this.client = client;
  }

  private async restart(): Promise<void> {
    this.client = null;
    // Wake everyone so they re-check the database while the listener reconnects.
    for (const cabinet of [...this.waiters.keys()]) this.wake(cabinet);
    await new Promise(r => setTimeout(r, 1000));
    if (!this.stopped) await this.start().catch(() => this.restart());
  }

  /** Resolves when a command for this cabinet may be waiting, or after the timeout, or on abort. */
  wait(cabinetId: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
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
    for (const done of [...(this.waiters.get(cabinetId) ?? [])]) done();
  }

  get waiting(): number { let n = 0; for (const s of this.waiters.values()) n += s.size; return n; }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const cabinet of [...this.waiters.keys()]) this.wake(cabinet);
    await this.client?.end().catch(() => undefined);
  }
}
