// The live stream (Server-Sent Events): one per signed-in tab. It carries the results of
// commands that user issued, every new major alert (to everyone signed in), and each
// alert's claim and resolution, so every console shows who has what. Security alerts go to Admins only.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SessionUser } from "../auth/sessions.js";
import type { Queryable } from "../db/db.js";
import type { NotificationFeed } from "../db/notifications.js";
import { alertById } from "../services/alerts.js";

interface Subscriber { userId: string; role: SessionUser["role"]; reply: FastifyReply; close: () => void; }

const MAX_STREAMS_PER_USER = 5;

export class ResultStream {
  private readonly subscribers = new Set<Subscriber>();
  private unsubscribe: Array<() => void> = [];

  /** The feed wakes this stream when a command result, an alert change or a security alert is written to the notifications table (by any server process). */
  constructor(private readonly feed: NotificationFeed, private readonly pool: Queryable) {}

  /** Starts listening to the feed. The feed itself is started by whoever created it. */
  async start(): Promise<void> {
    if (this.unsubscribe.length > 0) return;
    this.unsubscribe = [
      this.feed.on("command_results", payload => { void this.deliver(payload).catch(() => undefined); }),
      this.feed.on("alerts", payload => { void this.deliverAlert(payload).catch(() => undefined); }),
      this.feed.on("security_alerts", payload => this.deliverSecurity(payload)),
    ];
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
    // At most 5 streams per person: a sixth closes their oldest (a stolen or runaway session cannot hold thousands open).
    const mine = [...this.subscribers].filter(x => x.userId === user.userId);
    while (mine.length >= MAX_STREAMS_PER_USER) mine.shift()!.reply.raw.end();
    const subscriber = { userId: user.userId, role: user.role, reply, close: () => { clearInterval(ping); this.subscribers.delete(subscriber); } };
    this.subscribers.add(subscriber);
    // Every way the stream can end clears its timer, including a client that left before these listeners were attached.
    request.raw.on("close", subscriber.close);
    reply.raw.on("close", subscriber.close);
    if (request.raw.destroyed || reply.raw.destroyed || request.raw.socket?.destroyed) subscriber.close();
  }

  get count(): number { return this.subscribers.size; }

  async stop(): Promise<void> {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    for (const s of [...this.subscribers]) { s.close(); s.reply.raw.end(); }
  }
}
