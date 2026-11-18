import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { transaction, audit, type Pool } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { requireCabinetPermission, sshTransportPermission } from "./user-permissions.js";
import { Refused } from "./errors.js";

const host = "127.0.0.1";
const chunkBytes = 16_384;

class Transport {
  readonly id = randomUUID();
  readonly listener = createServer({ pauseOnConnect: true }, socket => {
    if (!this.endpoint || this.socket || this.closed) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => this.onClose("client_disconnected"));
    this.listener.close();
  });
  endpoint?: { host: string; port: number };
  socket?: Socket;
  timer?: NodeJS.Timeout;
  lease?: NodeJS.Timeout;
  claimed = false;
  reading = false;
  writing = false;
  closed?: Promise<void>;

  constructor(readonly cabinetId: string, readonly operatorId: string, readonly onClose: (reason: string) => void) {}
}

/** Process-local, single-client relay for the development SSH operation. */
export class SshTransport {
  private readonly cabinets = new Map<string, Transport>();
  private stopping = false;

  constructor(private readonly pool: Pool, private readonly reportError: (error: unknown) => void = console.error) {}

  async open(operatorId: string, cabinetId: string, stepUpToken: string) {
    if (this.stopping || this.cabinets.size >= 8 || this.cabinets.has(cabinetId))
      throw new Refused("ssh_transport_busy", 409, "SSH transport is unavailable or already open");
    const session = new Transport(cabinetId, operatorId, reason => {
      void this.close(session, reason).catch(this.reportError);
    });
    this.cabinets.set(cabinetId, session);
    try {
      const endpoint = await transaction(this.pool, async tx => {
        await requireCabinetPermission(tx, operatorId, cabinetId, sshTransportPermission);
        await consumeStepUpToken(tx, stepUpToken, operatorId, sshTransportPermission, cabinetId);
        const cabinet = await tx.query("SELECT id FROM cabinets WHERE id = $1 AND read_only = 0 AND demo_scenario IS NULL", [cabinetId]);
        if (!cabinet.rows.length) throw new Refused("ssh_transport_unavailable", 403, "a writable real cabinet is required");
        await new Promise<void>((resolve, reject) => {
          session.listener.once("error", reject);
          session.listener.listen({ host, port: 0 }, resolve);
        });
        const address = session.listener.address();
        if (!address || typeof address === "string") throw new Error("SSH transport listener has no TCP address");
        const endpoint = { host, port: address.port };
        await audit(tx, { actorKind: "user", actorId: operatorId, action: "ssh.transport.open", targetKind: "cabinet",
          targetId: cabinetId, outcome: "succeeded", details: { transportId: session.id, endpoint } });
        return endpoint;
      });
      session.endpoint = endpoint;
      session.timer = setTimeout(() => session.onClose("expired"), 60_000);
      if (this.stopping) {
        await this.close(session, "platform_shutdown");
        throw new Refused("ssh_transport_unavailable", 503, "platform is shutting down");
      }
      return { transportId: session.id, endpoint };
    } catch (error) {
      session.listener.close();
      this.cabinets.delete(cabinetId);
      throw error;
    }
  }

  claim(cabinetId: string): string | null {
    const session = this.cabinets.get(cabinetId);
    if (!session?.socket || session.claimed || session.closed) return null;
    session.claimed = true;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => session.onClose("expired"), 30 * 60_000);
    session.lease = setTimeout(() => session.onClose("agent_timeout"), 20_000);
    return session.id;
  }

  private active(cabinetId: string, transportId: string) {
    const session = this.cabinets.get(cabinetId);
    if (!session?.socket || !session.claimed || session.closed || session.id !== transportId)
      throw new Refused("not_found", 404, "no such SSH transport");
    return { session, socket: session.socket };
  }

  async receive(cabinetId: string, transportId: string): Promise<Buffer | null> {
    const { session, socket } = this.active(cabinetId, transportId);
    if (session.reading) throw new Refused("ssh_transport_busy", 409, "SSH receive already pending");
    session.lease?.refresh();
    session.reading = true;
    try {
      if (!socket.readableLength && !socket.destroyed && !socket.readableEnded) {
        await new Promise<void>(resolve => {
          const done = () => {
            clearTimeout(timer);
            socket.off("readable", done).off("close", done).off("end", done);
            resolve();
          };
          const timer = setTimeout(done, 5_000);
          socket.once("readable", done).once("close", done).once("end", done);
          socket.read(0);
        });
      }
      this.active(cabinetId, transportId);
      return socket.read(Math.min(socket.readableLength, chunkBytes)) as Buffer | null;
    } finally {
      session.reading = false;
    }
  }

  async send(cabinetId: string, transportId: string, data: Buffer): Promise<void> {
    const { session, socket } = this.active(cabinetId, transportId);
    if (session.writing) throw new Refused("ssh_transport_busy", 409, "SSH send already pending");
    session.writing = true;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.write(data, error => error ? reject(error) : resolve());
      });
    } finally {
      session.writing = false;
    }
  }

  async disconnect(cabinetId: string, transportId: string): Promise<void> {
    await this.close(this.active(cabinetId, transportId).session, "agent_disconnected", true);
  }

  async end(operatorId: string, cabinetId: string, transportId: string): Promise<void> {
    const session = this.cabinets.get(cabinetId);
    if (!session?.endpoint || session.operatorId !== operatorId || session.id !== transportId)
      throw new Refused("not_found", 404, "no such SSH transport");
    await this.close(session, "operator_closed");
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.cabinets.values()].filter(session => session.endpoint)
      .map(session => this.close(session, "platform_shutdown")));
  }

  private close(session: Transport, reason: string, flush = false): Promise<void> {
    if (session.closed) return session.closed;
    clearTimeout(session.timer);
    clearTimeout(session.lease);
    if (session.listener.listening) session.listener.close();
    if (flush) session.socket?.destroySoon();
    else session.socket?.destroy();
    const closed = transaction(this.pool, async tx => {
      await audit(tx, { actorKind: "user", actorId: session.operatorId,
        action: "ssh.transport.close", targetKind: "cabinet", targetId: session.cabinetId, outcome: "succeeded",
        details: { transportId: session.id, endpoint: session.endpoint, reason } });
    }).finally(() => this.cabinets.delete(session.cabinetId));
    session.closed = closed;
    return closed;
  }
}
