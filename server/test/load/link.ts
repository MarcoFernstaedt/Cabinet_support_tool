// Simulated network links between a cabinet and the server, applied per agent in-process (no root, no tc/netem).
//
// Each agent's TLS socket runs over a LinkShim: a Duplex that relays bytes to a real TCP connection to the server
// with the link's delay, loss and bandwidth applied, and that can silently black-hole traffic the way a NAT or a mobile
// failover does. The server sees ordinary TCP connections; the agent's TLS and HTTP code sees an ordinary socket that
// may stall. Bytes are counted here, so "bytes per cabinet" are TLS bytes on the wire (TCP/IP headers estimated).
//
// Modelled:
//   - round-trip time per packet burst, lognormal per link class (median and p99 as given);
//   - loss as added retransmit delay (RTO = max(300 ms, 2 x RTT)), per 1,400-byte segment;
//   - bandwidth (serialisation delay) per direction;
//   - NAT idle timeout: a flow idle longer than the timeout is forgotten, and every later packet in either direction is
//     dropped silently. A TCP keepalive shorter than the timeout keeps it alive (keepalive probes carry no data, so they
//     are modelled here, not seen by the server's kernel);
//   - black-holes (mobile failover, regional outage): every current connection dies for good (the address changed or
//     the flow state is lost) and new connections cannot be opened until the link is back;
//   - how the client notices a dead connection: unacknowledged data is retransmitted and the connection reset after
//     about 20 s (Windows TcpMaxDataRetransmissions 5); an idle one is found by keepalive (idle time, then 10 probes
//     one second apart), or never when keepalive is off (the application's own timeout ends it);
//   - the server's side of a dead connection stays open until the server closes it or about 15 minutes pass
//     (Linux tcp_retries2), like a real half-dead socket.
import { Duplex } from "node:stream";
import { connect as netConnect, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { lognormal } from "./metrics.js";

export type LinkClassName = "fiber" | "dsl" | "4g" | "bad";

export interface LinkClass {
  name: LinkClassName;
  rttMedianMs: number;
  rttP99Ms: number;
  loss: number;
  /** NAT idle timeout range in seconds (uniform per agent); 0 = no NAT timeout worth modelling. */
  natIdleSec: [number, number];
  /** Mean hours between failovers that black-hole every socket (0 = none), its spread, and the blackout length range. */
  failoverEveryHours: number;
  failoverSpreadHours: number;
  failoverBlackoutSec: [number, number];
  downMbit: number;
  upMbit: number;
}

export const LINK_CLASSES: Record<LinkClassName, LinkClass> = {
  fiber: { name: "fiber", rttMedianMs: 25, rttP99Ms: 80, loss: 0, natIdleSec: [0, 0], failoverEveryHours: 0, failoverSpreadHours: 0, failoverBlackoutSec: [0, 0], downMbit: 100, upMbit: 40 },
  dsl: { name: "dsl", rttMedianMs: 60, rttP99Ms: 300, loss: 0.005, natIdleSec: [120, 120], failoverEveryHours: 0, failoverSpreadHours: 0, failoverBlackoutSec: [0, 0], downMbit: 16, upMbit: 1 },
  "4g": { name: "4g", rttMedianMs: 120, rttP99Ms: 800, loss: 0.02, natIdleSec: [30, 60], failoverEveryHours: 6, failoverSpreadHours: 3, failoverBlackoutSec: [30, 90], downMbit: 20, upMbit: 5 },
  bad: { name: "bad", rttMedianMs: 500, rttP99Ms: 1500, loss: 0.05, natIdleSec: [30, 30], failoverEveryHours: 0, failoverSpreadHours: 0, failoverBlackoutSec: [0, 0], downMbit: 1, upMbit: 0.25 },
};

/** Parses "fiber=60,dsl=25,4g=12,bad=3" into normalised weights. */
export function parseLinkMix(spec: string): [LinkClassName, number][] {
  const out: [LinkClassName, number][] = [];
  for (const part of spec.split(",").map(s => s.trim()).filter(Boolean)) {
    const m = /^(fiber|dsl|4g|bad)=(\d+(?:\.\d+)?)$/.exec(part);
    if (!m) throw new Error(`--links: "${part}" is not class=weight (classes: fiber, dsl, 4g, bad)`);
    out.push([m[1] as LinkClassName, Number(m[2])]);
  }
  const total = out.reduce((a, [, w]) => a + w, 0);
  if (!(total > 0)) throw new Error("--links: the weights must add up to more than 0");
  return out.map(([k, w]) => [k, w / total]);
}

/** Picks a class for a uniform sample u in [0, 1). */
export function pickLinkClass(mix: [LinkClassName, number][], u: number): LinkClassName {
  let acc = 0;
  for (const [k, w] of mix) { acc += w; if (u < acc) return k; }
  return mix[mix.length - 1]![0];
}

/** Per-segment wire overhead estimate: IPv4 + TCP headers with timestamps (52 bytes) on each 1,448-byte segment. */
export function wireBytes(payload: number): number { return payload + Math.ceil(payload / 1448) * 52; }

/**
 * One agent's link: its class, its NAT timeout, and whether it is black-holed right now. Every black-hole bumps the
 * epoch, which kills each connection opened before it.
 */
export class AgentLink extends EventEmitter {
  down = false;
  epoch = 0;
  downSince = 0;
  /** Closed down intervals [from, to] in ms since epoch, for "was the link up during this gap". */
  readonly downIntervals: [number, number][] = [];
  readonly natIdleMs: number;
  private reasons = new Set<string>();

  constructor(readonly cls: LinkClass, rand: () => number) {
    super();
    const [a, b] = cls.natIdleSec;
    this.natIdleMs = a > 0 ? (a + rand() * (b - a)) * 1000 : 0;
    this.setMaxListeners(0);
  }

  /** Black-holes the link for a reason (several reasons may overlap: a failover during a regional outage). */
  blackhole(reason: string): void {
    if (this.reasons.has(reason)) return;
    this.reasons.add(reason);
    if (this.down) return;
    this.down = true;
    this.downSince = Date.now();
    this.epoch++;
    this.emit("down", reason);
  }

  restore(reason: string): void {
    if (!this.reasons.delete(reason) || this.reasons.size > 0 || !this.down) return;
    this.down = false;
    this.downIntervals.push([this.downSince, Date.now()]);
    if (this.downIntervals.length > 64) this.downIntervals.shift();
    this.emit("up");
  }

  /** Milliseconds of the window [from, to] during which this link was down. */
  downWithin(from: number, to: number): number {
    let t = 0;
    for (const [a, b] of this.downIntervals) t += Math.max(0, Math.min(b, to) - Math.max(a, from));
    if (this.down) t += Math.max(0, to - Math.max(this.downSince, from));
    return t;
  }

  rttMs(): number { return Math.min(lognormal(this.cls.rttMedianMs, this.cls.rttP99Ms), this.cls.rttP99Ms * 4); }
}

export interface ShimOptions {
  host: string;
  port: number;
  /** TCP keepalive idle time in seconds; 0 = keepalive off. */
  keepaliveSec: number;
  connectTimeoutMs?: number;
  /** How long the client retransmits unacknowledged data on a dead connection before it gives up. */
  retransmitGiveUpMs?: number;
  /** How long the server's side of a dead connection is kept before it is dropped (its kernel giving up). */
  deadUpstreamMs?: number;
  onBytes?: (direction: "up" | "down", payload: number) => void;
}

export class LinkError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/**
 * Delivers in order at (or after) each item's time with one timer: separate setTimeouts can fire out of order (their
 * delays are rounded to whole milliseconds), and TLS records arriving out of order break the connection.
 */
export class DeliveryQueue {
  private items: { at: number; f: () => void }[] = [];
  private head = 0;
  private timer: NodeJS.Timeout | null = null;
  add(at: number, f: () => void): void {
    const last = this.items[this.items.length - 1];
    this.items.push({ at: Math.max(at, last?.at ?? 0), f });
    if (!this.timer) this.arm();
  }
  private arm(): void {
    const next = this.items[this.head];
    if (!next) { this.items = []; this.head = 0; this.timer = null; return; }
    this.timer = setTimeout(() => this.fire(), Math.max(0, Math.ceil(next.at - Date.now())));
  }
  private fire(): void {
    const now = Date.now();
    while (this.head < this.items.length && this.items[this.head]!.at <= now) this.items[this.head++]!.f();
    if (this.head > 1024) { this.items = this.items.slice(this.head); this.head = 0; }
    this.arm();
  }
  clear(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; this.items = []; this.head = 0; }
}

/** A Duplex that carries one TCP connection over an AgentLink. Hand it to tls.connect({ socket }). */
export class LinkShim extends Duplex {
  private upstream: Socket | null = null;
  private readonly epoch: number;
  private natDropped = false;
  private lastActivity = Date.now();
  private upDeliverAt = 0;
  private downDeliverAt = 0;
  private deadTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private upstreamKill: NodeJS.Timeout | null = null;
  private closedByUs = false;
  private readonly onLinkDown = (): void => this.becameDead();
  private readonly upQ = new DeliveryQueue();
  private readonly downQ = new DeliveryQueue();

  constructor(readonly link: AgentLink, private readonly o: ShimOptions) {
    super({ allowHalfOpen: false });
    this.epoch = link.epoch;
    if (link.down) {
      // The SYN goes nowhere: the connect attempt times out.
      this.connectTimer = setTimeout(() => this.destroy(new LinkError("ETIMEDOUT", "connect timed out (link down)")), o.connectTimeoutMs ?? 15_000);
      return;
    }
    link.on("down", this.onLinkDown);
    const rtt = link.rttMs();
    // The three-way handshake costs one round trip before the first byte can be delivered.
    this.upDeliverAt = Date.now() + rtt;
    this.downDeliverAt = Date.now() + rtt;
    const up = netConnect({ host: o.host, port: o.port });
    this.upstream = up;
    up.setNoDelay(true);
    up.on("data", (chunk: Buffer) => this.fromServer(chunk));
    up.on("end", () => this.serverClosed(null));
    up.on("error", (e: NodeJS.ErrnoException) => this.serverClosed(e));
    up.on("close", () => this.serverClosed(null));
  }

  /** Dead: black-holed since it was opened, or forgotten by the NAT. */
  get dead(): boolean { return this.natDropped || this.link.epoch !== this.epoch || this.link.down; }

  private checkNat(now: number): void {
    const nat = this.link.natIdleMs;
    if (nat <= 0 || this.natDropped) return;
    // A keepalive probe shorter than the NAT timeout refreshes the mapping while the connection is idle.
    if (this.o.keepaliveSec > 0 && this.o.keepaliveSec * 1000 < nat) return;
    if (now - this.lastActivity > nat) { this.natDropped = true; this.becameDead(); }
  }

  private oneWay(bytes: number, mbit: number, direction: "up" | "down"): number {
    const now = Date.now();
    const rtt = this.link.rttMs();
    let delay = rtt / 2;
    const segments = Math.max(1, Math.ceil(bytes / 1400));
    if (this.link.cls.loss > 0 && Math.random() < 1 - Math.pow(1 - this.link.cls.loss, segments)) {
      delay += Math.max(300, 2 * rtt);
      if (Math.random() < this.link.cls.loss) delay += Math.max(600, 4 * rtt); // a second loss: the RTO doubles
    }
    const serialise = (bytes * 8) / (mbit * 1000); // ms
    const prev = direction === "up" ? this.upDeliverAt : this.downDeliverAt;
    const at = Math.max(now + delay, prev + serialise);
    if (direction === "up") this.upDeliverAt = at; else this.downDeliverAt = at;
    return at - now;
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    const now = Date.now();
    this.checkNat(now);
    if (this.dead || !this.upstream) { this.unacked(); cb(); return; }
    this.lastActivity = now;
    this.o.onBytes?.("up", chunk.length);
    const up = this.upstream;
    this.upQ.add(now + this.oneWay(chunk.length, this.link.cls.upMbit, "up"), () => { if (!this.dead && !up.destroyed) up.write(chunk); });
    cb();
  }

  override _read(): void { /* data is pushed as it arrives */ }

  private fromServer(chunk: Buffer): void {
    const now = Date.now();
    this.checkNat(now);
    if (this.dead) {
      // The server wrote into a dead flow: its kernel retransmits for a long time, then gives up.
      this.upstreamKill ??= setTimeout(() => this.upstream?.destroy(), this.o.deadUpstreamMs ?? 900_000).unref();
      return;
    }
    this.lastActivity = now;
    this.o.onBytes?.("down", chunk.length);
    this.downQ.add(now + this.oneWay(chunk.length, this.link.cls.downMbit, "down"), () => { if (!this.dead && !this.destroyed) this.push(chunk); });
  }

  private serverClosed(e: NodeJS.ErrnoException | null): void {
    if (this.closedByUs || this.destroyed) return;
    if (this.dead) return; // the FIN or reset never reaches the client
    const delay = this.link.rttMs() / 2 + Math.max(0, this.downDeliverAt - Date.now());
    setTimeout(() => {
      if (this.dead || this.destroyed) return;
      if (e) this.destroy(new LinkError(e.code ?? "ECONNRESET", "connection reset by the server"));
      else { this.push(null); this.destroy(); }
    }, delay);
  }

  /** The client wrote into a dead connection: it retransmits, then gives up. */
  private unacked(): void {
    if (this.deadTimer) return;
    this.deadTimer = setTimeout(() => this.destroy(new LinkError("ETIMEDOUT", "retransmissions timed out")), this.o.retransmitGiveUpMs ?? 20_000);
  }

  /** The connection just died (black-hole or NAT). With keepalive, an idle client notices after the idle time plus 10 probes. */
  private becameDead(): void {
    if (this.destroyed || this.deadTimer || this.o.keepaliveSec <= 0) return;
    const idleFor = Date.now() - this.lastActivity;
    const wait = Math.max(0, this.o.keepaliveSec * 1000 - idleFor) + 10_000;
    this.deadTimer = setTimeout(() => this.destroy(new LinkError("ETIMEDOUT", "keepalive found the connection dead")), wait);
  }

  override _destroy(err: Error | null, cb: (e: Error | null) => void): void {
    this.closedByUs = true;
    this.link.off("down", this.onLinkDown);
    if (this.deadTimer) clearTimeout(this.deadTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.downQ.clear();
    const up = this.upstream;
    if (up && !up.destroyed) {
      if (this.dead) {
        // The client's FIN or reset is lost: the server's socket stays until the server closes it or gives up.
        this.upstreamKill ??= setTimeout(() => up.destroy(), this.o.deadUpstreamMs ?? 900_000).unref();
        up.once("close", () => { if (this.upstreamKill) clearTimeout(this.upstreamKill); });
      } else {
        setTimeout(() => up.destroy(), this.link.rttMs() / 2);
      }
    }
    cb(err);
  }
}
