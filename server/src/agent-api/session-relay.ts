export class RelayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** Transport only: the session service must authorize every access against its durable,
 * audited session record. Bytes are never interpreted as operations or executed. */
export class SessionRelay {
  static readonly maxFrameBytes = 16_384;
  private readonly queues = new Map<string, { toAgent: Buffer[]; toConsole: Buffer[] }>();

  constructor(private readonly authorize: (cabinetId: string, sessionId: string) => Promise<boolean>) {}

  private async queue(cabinetId: string, sessionId: string) {
    const key = `${cabinetId}|${sessionId}`;
    if (!await this.authorize(cabinetId, sessionId)) {
      this.queues.delete(key);
      return null;
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
    const queue = await this.queue(cabinetId, sessionId);
    if (!queue) return null;
    const outgoing = side === "agent" ? queue.toConsole : queue.toAgent;
    const incoming = side === "agent" ? queue.toAgent : queue.toConsole;
    // Empty frames poll; a full queue refuses rather than silently losing a frame.
    if (bytes.byteLength) {
      if (outgoing.length >= 16) throw new RelayError(429, "relay_backpressure");
      outgoing.push(Buffer.from(bytes));
    }
    return incoming.shift() ?? Buffer.alloc(0);
  }

  close(cabinetId: string, sessionId: string): void {
    this.queues.delete(`${cabinetId}|${sessionId}`);
  }
}
