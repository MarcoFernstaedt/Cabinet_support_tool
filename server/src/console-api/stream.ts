// The live stream (Server-Sent Events): one per signed-in tab. It carries the results of
// commands that user issued, every new major alert (to everyone signed in), and each
// alert's claim and resolution, so every console shows who has what. Security alerts go to Admins only.
import type { FastifyReply, FastifyRequest } from "fastify";
import pg from "pg";
import type { SessionUser } from "../auth/sessions.js";
import { alertById } from "../services/alerts.js";

interface Subscriber { userId: string; role: SessionUser["role"]; reply: FastifyReply; close: () => void; }

export class ResultStream {
  private readonly subscribers = new Set<Subscriber>();
  private client: pg.Client | null = null;
  private stopped = false;

  constructor(private readonly connectionString: string, private readonly pool: pg.Pool) {}

  async start(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on("notification", msg => {
      if (msg.channel === "command_results" && msg.payload) void this.deliver(msg.payload);
      if (msg.channel === "alerts" && msg.payload) void this.deliverAlert(msg.payload);
      if (msg.channel === "security_alerts" && msg.payload) this.deliverSecurity(msg.payload);
    });
    client.on("error", () => { if (!this.stopped && this.client === client) void this.restart(); });
    await client.connect();
    await client.query("LISTEN command_results");
    await client.query("LISTEN alerts");
    await client.query("LISTEN security_alerts");
    this.client = client;
  }

  /**
   * Reconnects after the listener's connection fails, retrying with a growing pause (1 s up to 30 s) until it is back,
   * so a database restart only pauses live updates; the failed connection is closed.
   */
  private async restart(delayMs = 1000): Promise<void> {
    const old = this.client;
    this.client = null;
    old?.end().catch(() => undefined);
    await new Promise(r => setTimeout(r, delayMs));
    if (this.stopped) return;
    await this.start().catch(() => this.restart(Math.min(delayMs * 2, 30_000)));
  }

  private async deliver(payload: string): Promise<void> {
    const [commandId, issuedBy] = payload.split(" ");
    if (!commandId || !issuedBy || ![...this.subscribers].some(s => s.userId === issuedBy)) return;
    const row = (await this.pool.query<{ status: string; cabinet_id: string; operation: string }>(
      "SELECT status, cabinet_id, operation FROM commands WHERE id = $1", [commandId])).rows[0];
    if (!row) return;
    const data = JSON.stringify({ commandId, cabinetId: row.cabinet_id, operation: row.operation, status: row.status });
    for (const s of this.subscribers) if (s.userId === issuedBy) s.reply.raw.write(`event: result\ndata: ${data}\n\n`);
  }

  /** Security alerts (new ones and repeats) go to Admins only; a role change ends that person's sessions, and so their streams. */
  private deliverSecurity(payload: string): void {
    let p: { id?: unknown; created?: unknown; kind?: unknown; title?: unknown };
    try { p = JSON.parse(payload) as typeof p; } catch { return; }
    if (typeof p.id !== "string" || typeof p.title !== "string") return;
    const data = JSON.stringify({ id: p.id, created: p.created === true, kind: p.kind, title: p.title });
    for (const s of this.subscribers) if (s.role === "admin") s.reply.raw.write(`event: security\ndata: ${data}\n\n`);
  }

  /** New major alerts go to everyone; claims and resolutions of any alert too, so lists and the badge stay current. */
  private async deliverAlert(payload: string): Promise<void> {
    const [alertId, change] = payload.split(" ");
    if (!alertId || !change || this.subscribers.size === 0) return;
    const a = await alertById(this.pool, alertId).catch(() => null);
    if (!a || (change === "created" && a.severity !== "major")) return;
    const data = JSON.stringify({
      change, alertId: a.id, severity: a.severity, title: a.title, state: a.state, cabinet: a.cabinet, site: a.site, client: a.client,
      claimedBy: a.claimedBy, sitePattern: a.sitePattern,
    });
    for (const s of this.subscribers) s.reply.raw.write(`event: alert\ndata: ${data}\n\n`);
  }

  attach(user: SessionUser, request: FastifyRequest, reply: FastifyReply, stillValid: () => Promise<SessionUser | null>): void {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff",
    });
    reply.raw.write(": connected\n\n");
    // A comment every 25 s keeps proxies from closing the stream; the session is re-checked each time.
    const ping = setInterval(() => {
      void stillValid().then(u => {
        if (!u || u.stage !== "complete") { reply.raw.end(); return; }
        reply.raw.write(": ping\n\n");
      }, () => reply.raw.end());
    }, 25_000);
    const subscriber = { userId: user.userId, role: user.role, reply, close: () => { clearInterval(ping); this.subscribers.delete(subscriber); } };
    this.subscribers.add(subscriber);
    // Every way the stream can end clears its timer, including a client that left before these listeners were attached.
    request.raw.on("close", subscriber.close);
    reply.raw.on("close", subscriber.close);
    if (request.raw.destroyed || reply.raw.destroyed || request.raw.socket?.destroyed) subscriber.close();
  }

  get count(): number { return this.subscribers.size; }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const s of [...this.subscribers]) { s.close(); s.reply.raw.end(); }
    await this.client?.end().catch(() => undefined);
  }
}
