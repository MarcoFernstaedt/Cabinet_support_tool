// One simulated agent's connections to the agent API, over its LinkShim.
//
// Protocol 1.1 keeps one long-lived TLS connection: HTTP/2 when the server offers it through ALPN (polls, heartbeats,
// events and results are multiplexed on it), otherwise HTTP/1.1 keep-alive, where a request that finds the
// connection busy (a long poll is held on it) opens another one, and idle extra connections are closed after the
// idle timeout. TLS sessions are resumed when the server allows it; each new connection is reported as a full or a
// resumed handshake (tlsSocket.isSessionReused()).
//
// The HTTP/1.1 client is a small one written here (Content-Length and chunked bodies, keep-alive), so the generator
// controls exactly which connection each request uses and nothing is pooled or retried behind its back.
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { connect as h2Connect, constants as h2c, type ClientHttp2Session } from "node:http2";
import { LinkShim, type AgentLink } from "./link.js";

export interface HttpResponse { status: number; headers: Record<string, string>; body: Buffer }

/** A request that never got an HTTP answer: connect failure, reset, timeout. */
export class NetError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_HEAD_BYTES = 64 * 1024;

export interface TransportOptions {
  host: string;
  port: number;
  servername: string;
  ca: string;
  cert: string;
  key: string;
  link: AgentLink;
  /** "h2" offers HTTP/2 then HTTP/1.1 through ALPN; "h1" offers only HTTP/1.1 (the 1.0 agent's HttpClient default). */
  offer: "h2" | "h1";
  idleTimeoutMs: number;
  /** A connection older than this takes no new requests (SocketsHttpHandler.PooledConnectionLifetime). */
  lifetimeMs: number;
  keepaliveSec: number;
  connectTimeoutMs?: number;
  onHandshake?: (reused: boolean, ms: number, protocol: string) => void;
  onBytes?: (direction: "up" | "down", n: number) => void;
}

// ---- HTTP/1.1 response parsing -------------------------------------------------------------------

type ParseResult = { done: false } | { done: true; response: HttpResponse; rest: Buffer; close: boolean };

/**
 * An incremental HTTP/1.1 response parser. Throws on anything malformed or oversized: a status line that is not
 * HTTP/1.x nnn, a header line without a colon, a bad Content-Length or chunk size, a head over 64 KB or a body over 4 MB.
 */
export class ResponseParser {
  private buf: Buffer = Buffer.alloc(0);
  private head: { status: number; headers: Record<string, string> } | null = null;
  private bodyStart = 0;

  constructor(private readonly method: string) {}

  push(chunk: Buffer): ParseResult {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (!this.head) {
      const end = this.buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (this.buf.length > MAX_HEAD_BYTES) throw new NetError("EPROTO", "response head too large");
        return { done: false };
      }
      if (end > MAX_HEAD_BYTES) throw new NetError("EPROTO", "response head too large");
      const lines = this.buf.subarray(0, end).toString("latin1").split("\r\n");
      const m = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(lines[0] ?? "");
      if (!m) throw new NetError("EPROTO", "malformed status line");
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(":");
        if (i <= 0) throw new NetError("EPROTO", "malformed header line");
        const name = line.slice(0, i).trim().toLowerCase();
        if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new NetError("EPROTO", "malformed header name");
        headers[name] = line.slice(i + 1).trim();
      }
      this.head = { status: Number(m[1]), headers };
      this.bodyStart = end + 4;
    }
    const { status, headers } = this.head;
    const close = (headers["connection"] ?? "").toLowerCase() === "close";
    const finish = (body: Buffer, consumed: number): ParseResult =>
      ({ done: true, response: { status, headers, body }, rest: this.buf.subarray(consumed), close });
    if (this.method === "HEAD" || status === 204 || status === 304 || (status >= 100 && status < 200)) return finish(Buffer.alloc(0), this.bodyStart);
    if ((headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked")) return this.chunked(finish);
    const cl = headers["content-length"];
    if (cl !== undefined) {
      if (!/^\d{1,10}$/.test(cl)) throw new NetError("EPROTO", "bad content-length");
      const n = Number(cl);
      if (n > MAX_RESPONSE_BYTES) throw new NetError("EPROTO", "response too large");
      if (this.buf.length - this.bodyStart < n) return { done: false };
      return finish(Buffer.from(this.buf.subarray(this.bodyStart, this.bodyStart + n)), this.bodyStart + n);
    }
    // No length: the body runs to the end of the connection (handled by end()).
    if (this.buf.length - this.bodyStart > MAX_RESPONSE_BYTES) throw new NetError("EPROTO", "response too large");
    return { done: false };
  }

  private chunked(finish: (body: Buffer, consumed: number) => ParseResult): ParseResult {
    let at = this.bodyStart;
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const eol = this.buf.indexOf("\r\n", at);
      if (eol < 0) { if (this.buf.length - at > 1024) throw new NetError("EPROTO", "bad chunk size"); return { done: false }; }
      const sizeText = this.buf.subarray(at, eol).toString("latin1").split(";")[0]!.trim();
      if (!/^[0-9a-fA-F]{1,8}$/.test(sizeText)) throw new NetError("EPROTO", "bad chunk size");
      const size = parseInt(sizeText, 16);
      total += size;
      if (total > MAX_RESPONSE_BYTES) throw new NetError("EPROTO", "response too large");
      if (size === 0) {
        // Trailers (if any) end with an empty line.
        const end = this.buf.indexOf("\r\n\r\n", eol);
        if (this.buf.subarray(eol, eol + 4).toString("latin1") === "\r\n\r\n") return finish(Buffer.concat(parts), eol + 4);
        if (end < 0) return { done: false };
        return finish(Buffer.concat(parts), end + 4);
      }
      if (this.buf.length < eol + 2 + size + 2) return { done: false };
      parts.push(this.buf.subarray(eol + 2, eol + 2 + size));
      if (this.buf.subarray(eol + 2 + size, eol + 4 + size).toString("latin1") !== "\r\n") throw new NetError("EPROTO", "bad chunk terminator");
      at = eol + 4 + size;
    }
  }

  /** The connection ended: a body without a length is complete; anything else is truncated. */
  end(): HttpResponse {
    if (!this.head) throw new NetError("ECONNRESET", "connection closed before a response");
    const { status, headers } = this.head;
    if (headers["content-length"] !== undefined || (headers["transfer-encoding"] ?? "").includes("chunked")) throw new NetError("ECONNRESET", "response truncated");
    return { status, headers, body: Buffer.from(this.buf.subarray(this.bodyStart)) };
  }
}

// ---- Connections ---------------------------------------------------------------------------------

interface Pending { resolve: (r: HttpResponse) => void; reject: (e: Error) => void; parser: ResponseParser; timer: NodeJS.Timeout }

class H1Connection {
  busy = false;
  closed = false;
  readonly openedAt = Date.now();
  lastUsed = Date.now();
  private pending: Pending | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(readonly socket: TLSSocket, private readonly idleTimeoutMs: number, private readonly onClose: (c: H1Connection) => void) {
    socket.on("data", (chunk: Buffer) => this.data(chunk));
    socket.on("error", e => this.fail(new NetError((e as NodeJS.ErrnoException).code ?? "ECONNRESET", e.message)));
    socket.on("close", () => this.fail(null));
    this.idle();
  }

  private idle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.idleTimeoutMs);
  }

  request(method: string, path: string, host: string, headers: Record<string, string>, body: Buffer | undefined, timeoutMs: number): Promise<HttpResponse> {
    this.busy = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new NetError("ETIMEDOUT", "request timed out")); }, timeoutMs);
      this.pending = { resolve, reject, parser: new ResponseParser(method), timer };
      let head = `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n`;
      for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
      if (body) head += `Content-Length: ${body.length}\r\n`;
      head += "\r\n";
      this.socket.write(body ? Buffer.concat([Buffer.from(head, "latin1"), body]) : Buffer.from(head, "latin1"));
    });
  }

  private data(chunk: Buffer): void {
    const p = this.pending;
    if (!p) { this.close(); return; } // bytes nobody asked for: the connection is no longer trustworthy
    let r: ParseResult;
    try { r = p.parser.push(chunk); } catch (e) { this.fail(e as Error); return; }
    if (!r.done) return;
    clearTimeout(p.timer);
    this.pending = null;
    this.busy = false;
    this.lastUsed = Date.now();
    if (r.close || r.rest.length > 0) this.close(); else this.idle();
    p.resolve(r.response);
  }

  private fail(e: Error | null): void {
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      if (e === null) { try { p.resolve(p.parser.end()); } catch (x) { p.reject(x as Error); } }
      else p.reject(e instanceof NetError ? e : new NetError("ECONNRESET", e.message));
    }
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.busy = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.socket.destroy();
    this.onClose(this);
  }
}

/** All connections of one simulated agent. */
export class AgentTransport {
  private h1: H1Connection[] = [];
  private h2: { session: ClientHttp2Session; openedAt: number; streams: number; idleTimer: NodeJS.Timeout | null } | null = null;
  private h2Opening: Promise<void> | null = null;
  private session: Buffer | undefined;
  /** What the server chose the first time; "h2" once it offered HTTP/2. */
  protocol: "h2" | "http/1.1" | null = null;
  private stopped = false;

  constructor(private readonly o: TransportOptions) {}

  get openConnections(): number { return this.h1.length + (this.h2 ? 1 : 0); }

  /** Opens a TLS connection over the link; resolves when the handshake is done. */
  private openTls(): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const shim = new LinkShim(this.o.link, { host: this.o.host, port: this.o.port, keepaliveSec: this.o.keepaliveSec, connectTimeoutMs: this.o.connectTimeoutMs ?? 15_000,
        ...(this.o.onBytes ? { onBytes: this.o.onBytes } : {}) });
      const socket = tlsConnect({ socket: shim, servername: this.o.servername, ca: this.o.ca, cert: this.o.cert, key: this.o.key, minVersion: "TLSv1.2",
        ALPNProtocols: this.o.offer === "h2" ? ["h2", "http/1.1"] : ["http/1.1"], ...(this.session ? { session: this.session } : {}) });
      socket.on("session", (s: Buffer) => { this.session = s; });
      const timer = setTimeout(() => { socket.destroy(); reject(new NetError("ETIMEDOUT", "TLS handshake timed out")); }, (this.o.connectTimeoutMs ?? 15_000) + 15_000);
      const onError = (e: Error): void => { clearTimeout(timer); socket.destroy(); reject(new NetError((e as NodeJS.ErrnoException).code ?? "ECONNRESET", e.message)); };
      socket.once("error", onError);
      shim.once("error", onError);
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        socket.off("error", onError);
        const proto = socket.alpnProtocol === "h2" ? "h2" : "http/1.1";
        this.protocol = proto;
        this.o.onHandshake?.(socket.isSessionReused(), Date.now() - started, proto);
        socket.on("error", () => { /* handled by the connection that owns it */ });
        resolve(socket);
      });
    });
  }

  async request(method: "GET" | "POST", path: string, headers: Record<string, string>, body: Buffer | undefined, timeoutMs: number): Promise<HttpResponse> {
    if (this.stopped) throw new NetError("ESTOPPED", "stopped");
    if (this.protocol === "h2" || (this.protocol === null && this.o.offer === "h2" && this.h2Opening)) return this.h2Request(method, path, headers, body, timeoutMs);
    // HTTP/1.1: an idle connection young enough, else a new one (which may turn out to be HTTP/2).
    const now = Date.now();
    const conn = this.h1.filter(c => !c.busy && !c.closed && now - c.openedAt < this.o.lifetimeMs).sort((a, b) => b.lastUsed - a.lastUsed)[0];
    if (conn) return conn.request(method, path, `${this.o.servername}:${this.o.port}`, headers, body, timeoutMs);
    if (this.o.offer === "h2" && this.protocol === null) return this.h2Request(method, path, headers, body, timeoutMs);
    const socket = await this.openTls();
    if (this.stopped) { socket.destroy(); throw new NetError("ESTOPPED", "stopped"); }
    const c = new H1Connection(socket, this.o.idleTimeoutMs, x => { this.h1 = this.h1.filter(y => y !== x); });
    this.h1.push(c);
    // Retire idle connections past their lifetime.
    for (const old of this.h1) if (!old.busy && now - old.openedAt >= this.o.lifetimeMs) old.close();
    return c.request(method, path, `${this.o.servername}:${this.o.port}`, headers, body, timeoutMs);
  }

  private async ensureH2(): Promise<void> {
    if (this.h2 && !this.h2.session.closed && !this.h2.session.destroyed && Date.now() - this.h2.openedAt < this.o.lifetimeMs) return;
    if (this.h2 && this.h2.streams === 0) this.h2.session.close();
    this.h2 = null;
    this.h2Opening ??= (async () => {
      try {
        const socket = await this.openTls();
        if (socket.alpnProtocol !== "h2") {
          // The server does not speak HTTP/2: keep this connection as HTTP/1.1.
          this.h1.push(new H1Connection(socket, this.o.idleTimeoutMs, x => { this.h1 = this.h1.filter(y => y !== x); }));
          return;
        }
        const session = h2Connect(`https://${this.o.servername}:${this.o.port}`, { createConnection: () => socket, maxSessionMemory: 10 });
        const entry = { session, openedAt: Date.now(), streams: 0, idleTimer: null as NodeJS.Timeout | null };
        session.on("error", () => session.destroy());
        session.on("goaway", () => { if (this.h2 === entry) this.h2 = null; });
        session.on("close", () => { if (this.h2 === entry) this.h2 = null; });
        this.h2 = entry;
      } finally { this.h2Opening = null; }
    })();
    await this.h2Opening;
  }

  private async h2Request(method: string, path: string, headers: Record<string, string>, body: Buffer | undefined, timeoutMs: number): Promise<HttpResponse> {
    await this.ensureH2();
    if (this.stopped) throw new NetError("ESTOPPED", "stopped");
    if (this.protocol === "http/1.1") return this.request(method as "GET" | "POST", path, headers, body, timeoutMs);
    const entry = this.h2;
    if (!entry) throw new NetError("ECONNRESET", "HTTP/2 session closed");
    return new Promise((resolve, reject) => {
      let stream;
      try {
        stream = entry.session.request({ [h2c.HTTP2_HEADER_METHOD]: method, [h2c.HTTP2_HEADER_PATH]: path, ...headers,
          ...(body ? { "content-length": String(body.length) } : {}) }, { endStream: !body });
      } catch (e) { entry.session.destroy(); reject(new NetError("ECONNRESET", (e as Error).message)); return; }
      entry.streams++;
      let status = 0;
      let resHeaders: Record<string, string> = {};
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const done = (e: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry.streams--;
        if (e) reject(e instanceof NetError ? e : new NetError("ECONNRESET", e.message));
        else resolve({ status, headers: resHeaders, body: Buffer.concat(chunks) });
      };
      const timer = setTimeout(() => {
        // An HTTP/2 request timing out means the connection is likely dead: drop it, as the agent's handler would.
        stream.close(h2c.NGHTTP2_CANCEL);
        entry.session.destroy();
        done(new NetError("ETIMEDOUT", "request timed out"));
      }, timeoutMs);
      stream.on("response", h => {
        status = Number(h[h2c.HTTP2_HEADER_STATUS] ?? 0);
        resHeaders = Object.fromEntries(Object.entries(h).filter(([k]) => !k.startsWith(":")).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]));
      });
      stream.on("data", (c: Buffer) => { size += c.length; if (size > MAX_RESPONSE_BYTES) { stream.close(h2c.NGHTTP2_CANCEL); done(new NetError("EPROTO", "response too large")); } else chunks.push(c); });
      stream.on("end", () => done(status ? null : new NetError("ECONNRESET", "stream ended without a response")));
      stream.on("error", e => done(e));
      stream.on("close", () => done(status ? null : new NetError("ECONNRESET", "stream closed")));
      if (body) stream.end(body);
    });
  }

  /** Drops every connection (the agent noticed it is offline, or the run is over). */
  reset(): void {
    for (const c of [...this.h1]) c.close();
    this.h1 = [];
    this.h2?.session.destroy();
    this.h2 = null;
  }

  stop(): void { this.stopped = true; this.reset(); }
}
