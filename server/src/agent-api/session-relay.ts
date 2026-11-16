import type { NotificationFeed } from "../db/notifications.js";

export class RelayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export type SessionControl = "open" | "close" | "keepalive";

/** Diagnostic output flows from agent to console. The reverse direction carries fixed controls only. */
export class SessionRelay {
  static readonly maxFrameBytes = 16_384;
  private readonly queues = new Map<string, { toAgent: SessionControl[]; toConsole: Buffer[] }>();

  constructor(private readonly authorize: (cabinetId: string, sessionId: string, activity: boolean) => Promise<boolean>) {}

  private async queue(cabinetId: string, sessionId: string, activity = false) {
    const key = `${cabinetId}|${sessionId}`;
    try {
      if (!await this.authorize(cabinetId, sessionId, activity)) {
        this.queues.delete(key);
        return null;
      }
    } catch (error) {
      // A database failure revokes buffered access just as a false authorization does (F6).
      this.queues.delete(key);
      throw error;
    }
    let queue = this.queues.get(key);
    if (!queue) {
      // A second bound independent of the session service's fleet cap.
      if (this.queues.size >= 16) throw new RelayError(503, "relay_capacity");
      queue = { toAgent: [], toConsole: [] };
      this.queues.set(key, queue);
    }
    return queue;
  }

  async exchange(cabinetId: string, sessionId: string, side: "agent" | "console", bytes: Uint8Array): Promise<Buffer | null> {
    if (bytes.byteLength > SessionRelay.maxFrameBytes) throw new RelayError(413, "relay_frame_too_large");
    const queue = await this.queue(cabinetId, sessionId, side === "console" || bytes.byteLength > 0);
    if (!queue) return null;
    if (side === "console") {
      if (bytes.byteLength) throw new RelayError(400, "relay_control_required");
      return queue.toConsole.shift() ?? Buffer.alloc(0);
    }
    if (bytes.byteLength) {
      if (queue.toConsole.length >= 16) throw new RelayError(429, "relay_backpressure");
      queue.toConsole.push(Buffer.from(bytes));
    }
    return Buffer.from(JSON.stringify({ control: queue.toAgent.shift() ?? "keepalive" }));
  }

  async control(cabinetId: string, sessionId: string, control: SessionControl): Promise<boolean> {
    if (!["open", "close", "keepalive"].includes(control)) throw new RelayError(400, "relay_control_required");
    const queue = await this.queue(cabinetId, sessionId);
    if (!queue) return false;
    if (queue.toAgent.length >= 16) throw new RelayError(429, "relay_backpressure");
    queue.toAgent.push(control);
    return true;
  }

  watchClosures(feed: Pick<NotificationFeed, "on">): () => void {
    return feed.on("sessions_closed", payload => {
      const [cabinetId, sessionId] = payload.split("|");
      if (cabinetId && sessionId) this.close(cabinetId, sessionId);
    });
  }

  close(cabinetId: string, sessionId: string): void {
    this.queues.delete(`${cabinetId}|${sessionId}`);
  }
}
