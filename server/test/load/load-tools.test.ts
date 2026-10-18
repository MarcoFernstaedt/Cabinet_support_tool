// Tests for the load generator's own parts: the HTTP/1.1 response parser (with malformed and hostile answers), the
// link shim (delay, ordering, black-holes, NAT drops, how a dead connection is noticed), the agent's backoff and
// Retry-After handling, event batching, link mixes and the histograms.
//   npm run build && node --test dist/test/load/load-tools.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { ResponseParser, NetError, MAX_RESPONSE_BYTES } from "./transport.js";
import { AgentLink, DeliveryQueue, LINK_CLASSES, LinkShim, parseLinkMix, pickLinkClass, type LinkClass } from "./link.js";
import { Backoff, Connectivity, classify, retryAfterMs, takeBatch } from "./agent-sim.js";
import { Histogram, seeded } from "./metrics.js";
import { SimAgent } from "./agent-sim.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureServer } from "node:http2";
import { gunzipSync } from "node:zlib";
import { developmentIssuingKey, developmentServerCertificate, issueAgentCertificate } from "../../src/pki/issuing.js";
import { csrFor, ecKey } from "../helpers.js";

const parse = (text: string | Buffer, method = "GET") => new ResponseParser(method).push(Buffer.isBuffer(text) ? text : Buffer.from(text, "latin1"));

test("parses a Content-Length response and keeps what follows it", () => {
  const r = parse("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}EXTRA");
  assert.ok(r.done);
  if (!r.done) return;
  assert.equal(r.response.status, 200);
  assert.equal(r.response.body.toString(), "{}");
  assert.equal(r.rest.toString(), "EXTRA");
  assert.equal(r.close, false);
});

test("parses a response delivered one byte at a time", () => {
  const p = new ResponseParser("GET");
  const text = Buffer.from("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 7\r\nConnection: close\r\nContent-Length: 5\r\n\r\nhello");
  let last;
  for (let i = 0; i < text.length; i++) last = p.push(text.subarray(i, i + 1));
  assert.ok(last?.done);
  if (!last?.done) return;
  assert.equal(last.response.headers["retry-after"], "7");
  assert.equal(last.close, true);
});

test("parses chunked bodies, with extensions and trailers", () => {
  const r = parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3;x=1\r\nabc\r\n2\r\nde\r\n0\r\nX-T: 1\r\n\r\n");
  assert.ok(r.done);
  if (r.done) assert.equal(r.response.body.toString(), "abcde");
});

test("refuses malformed and hostile responses", () => {
  const bad: [string, string][] = [
    ["HTTP/2 200\r\n\r\n", "malformed status line"],
    ["SSH-2.0-OpenSSH\r\n\r\n", "malformed status line"],
    ["HTTP/1.1 200 OK\r\nno colon here\r\n\r\n", "malformed header line"],
    ["HTTP/1.1 200 OK\r\nBad Name: x\r\n\r\n", "malformed header name"],
    ["HTTP/1.1 200 OK\r\nContent-Length: -5\r\n\r\n", "bad content-length"],
    ["HTTP/1.1 200 OK\r\nContent-Length: 1e3\r\n\r\n", "bad content-length"],
    [`HTTP/1.1 200 OK\r\nContent-Length: ${MAX_RESPONSE_BYTES + 1}\r\n\r\n`, "response too large"],
    ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n", "bad chunk size"],
    ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nFFFFFFFF\r\n", "response too large"],
    ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nabXY", "bad chunk terminator"],
  ];
  for (const [text, message] of bad) assert.throws(() => parse(text), (e: Error) => e instanceof NetError && e.message === message, text);
  // A head that never ends is cut off at 64 KB.
  assert.throws(() => parse("HTTP/1.1 200 OK\r\n" + "X: " + "a".repeat(70_000)), /response head too large/);
});

test("a body without a length ends with the connection; a truncated one is an error", () => {
  const p = new ResponseParser("GET");
  assert.equal(p.push(Buffer.from("HTTP/1.0 200 OK\r\n\r\npartial")).done, false);
  assert.equal(p.end().body.toString(), "partial");
  const q = new ResponseParser("GET");
  q.push(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc"));
  assert.throws(() => q.end(), /truncated/);
  assert.throws(() => new ResponseParser("GET").end(), /before a response/);
});

test("Retry-After: seconds, an HTTP date, or nothing usable", () => {
  assert.equal(retryAfterMs("12"), 12_000);
  const now = Date.parse("2026-10-17T12:00:00Z");
  assert.equal(retryAfterMs("Sat, 17 Oct 2026 12:00:30 GMT", now), 30_000);
  assert.equal(retryAfterMs(undefined), null);
  assert.equal(retryAfterMs("soon"), null);
  assert.equal(retryAfterMs("-1"), null);
  assert.equal(retryAfterMs("2026"), 2_026_000);
  assert.equal(retryAfterMs("1e9"), null);
});

test("decorrelated jitter grows from 2 s and is capped at 5 minutes", () => {
  const b = new Backoff(2_000, 300_000, seeded(3));
  let max = 0;
  for (let i = 0; i < 50; i++) { const w = b.next(); assert.ok(w >= 2_000 && w <= 300_000); max = Math.max(max, w); }
  assert.ok(max > 100_000, "reaches minutes after many failures");
  b.reset();
  assert.ok(b.next() <= 6_000, "starts small again after a reset");
});

test("shared connectivity: one probe while down, everyone after a success; 429 is local; Retry-After capped at 10 min", async () => {
  let now = 1_000_000;
  const c = new Connectivity(new Backoff(2_000, 300_000, seeded(5)), seeded(6), 30_000, () => now);
  const stopped = () => false;
  assert.equal(classify(new NetError("ECONNRESET", "x")), "network");
  assert.equal(c.failed("network", null), "network");
  assert.equal(c.connected, false);
  now += 400_000; // past any backoff
  const probe = await c.enter(stopped);
  assert.ok(probe);
  let second = false;
  const other = c.enter(stopped).then(r => { second = true; return r; });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(second, false, "a second loop waits while one probes");
  c.reached();
  probe!();
  assert.ok(await other);
  // A quota refusal leaves the shared state connected.
  c.failed("quota", 60_000);
  assert.equal(c.connected, true);
  // 503 with Retry-After of a day is honoured for 10 minutes only.
  c.failed("unavailable", 86_400_000);
  assert.equal(c.serverWaitUntil - now, 600_000);
  // A reset of a live connection retries within 0-30 s, not after the backoff step.
  const d = new Connectivity(new Backoff(2_000, 300_000, () => 0.99), () => 0.5, 30_000, () => now);
  d.reached();
  d.failed("network", null);
  let entered = false;
  void d.enter(stopped).then(() => { entered = true; });
  now += 15_001;
  d.wake();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(entered, true);
});

test("event batches keep to 100 events and 256 KB, priority events first", () => {
  const ev = (n: number, bytes: number) => Array.from({ length: n }, (_, i) => ({ id: String(i), json: "x".repeat(bytes), bytes, failures: 0 }));
  assert.equal(takeBatch([], ev(250, 100), 100, 256 * 1024).length, 100);
  const big = takeBatch([], ev(50, 10_000), 100, 256 * 1024);
  assert.equal(big.length, 26); // 26 x 10,001 bytes fit in 256 KB, 27 do not
  const pri = ev(3, 10);
  assert.deepEqual(takeBatch(pri, ev(5, 10), 4, 1e6).slice(0, 3), pri);
  // One event larger than the cap still goes alone, so it can be refused and set aside.
  assert.equal(takeBatch([], ev(2, 300_000), 100, 256 * 1024).length, 1);
});

test("link mixes are parsed strictly", () => {
  const m = parseLinkMix("fiber=60,dsl=25,4g=12,bad=3");
  assert.equal(Math.round(m.reduce((a, [, w]) => a + w, 0) * 1000), 1000);
  assert.equal(pickLinkClass(m, 0.0), "fiber");
  assert.equal(pickLinkClass(m, 0.99), "bad");
  for (const bad of ["fiber", "wifi=10", "fiber=-1", "fiber=0", "fiber=1;rm -rf /"]) assert.throws(() => parseLinkMix(bad), Error, bad);
});

test("histogram percentiles are within 2%", () => {
  const h = new Histogram();
  for (let i = 1; i <= 10_000; i++) h.add(i);
  for (const p of [50, 95, 99]) assert.ok(Math.abs(h.pct(p) - p * 100) / (p * 100) < 0.021, `p${p} = ${h.pct(p)}`);
  assert.equal(h.pct(100), 10_000);
  h.add(NaN); h.add(-1);
  assert.equal(h.count, 10_000);
});

test("the delivery queue keeps order even when times go backwards", async () => {
  const q = new DeliveryQueue();
  const out: number[] = [];
  const now = Date.now();
  q.add(now + 20, () => out.push(1));
  q.add(now + 5, () => out.push(2));
  q.add(now + 10.7, () => out.push(3));
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(out, [1, 2, 3]);
});

// ---- The shim against a real TCP server -------------------------------------------------------

const FAST: LinkClass = { ...LINK_CLASSES.fiber, rttMedianMs: 4, rttP99Ms: 6 };

async function echoServer(): Promise<{ server: Server; port: number; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server = createServer(s => { sockets.push(s); s.on("data", d => s.write(d)); s.on("error", () => undefined); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port, sockets };
}

test("the shim relays in order with delay, and counts bytes", async () => {
  const { server, port, sockets } = await echoServer();
  const link = new AgentLink({ ...FAST, rttMedianMs: 40, rttP99Ms: 50 }, Math.random);
  let up = 0, down = 0;
  const shim = new LinkShim(link, { host: "127.0.0.1", port, keepaliveSec: 0, onBytes: (d, n) => { if (d === "up") up += n; else down += n; } });
  const got: Buffer[] = [];
  shim.on("data", (d: Buffer) => got.push(d));
  const t = Date.now();
  for (let i = 0; i < 50; i++) shim.write(Buffer.from(`${i},`));
  await new Promise(r => setTimeout(r, 400));
  assert.equal(Buffer.concat(got).toString(), Array.from({ length: 50 }, (_, i) => `${i},`).join(""));
  assert.ok(Date.now() - t >= 80);
  assert.equal(up, down);
  shim.destroy();
  for (const s of sockets) s.destroy();
  server.close();
});

test("a black-hole kills existing connections for good; keepalive notices an idle one", async () => {
  const { server, port, sockets } = await echoServer();
  const link = new AgentLink(FAST, Math.random);
  const shim = new LinkShim(link, { host: "127.0.0.1", port, keepaliveSec: 0.05, keepaliveProbesMs: 300 });
  await new Promise(r => setTimeout(r, 50));
  const t = Date.now();
  link.blackhole("test");
  const err = await new Promise<Error>(r => shim.on("error", r));
  assert.match(err.message, /keepalive/);
  assert.ok(Date.now() - t >= 300 - 20, "the probes run out after the idle time");
  link.restore("test");
  // The old connection stays dead after the link is back; a new one works.
  const fresh = new LinkShim(link, { host: "127.0.0.1", port, keepaliveSec: 0 });
  const echoed = new Promise<string>(r => fresh.once("data", (d: Buffer) => r(d.toString())));
  fresh.write(Buffer.from("ping"));
  assert.equal(await echoed, "ping");
  fresh.destroy();
  for (const s of sockets) s.destroy();
  server.close();
});

test("writing into a dead connection fails after the retransmissions; connecting while down times out", async () => {
  const { server, port, sockets } = await echoServer();
  const link = new AgentLink(FAST, Math.random);
  const shim = new LinkShim(link, { host: "127.0.0.1", port, keepaliveSec: 0, retransmitGiveUpMs: 200 });
  await new Promise(r => setTimeout(r, 30));
  link.blackhole("test");
  let got = false;
  shim.on("data", () => { got = true; });
  shim.write(Buffer.from("lost"));
  const err = await new Promise<Error>(r => shim.on("error", r));
  assert.match(err.message, /retransmissions/);
  assert.equal(got, false);
  const t = Date.now();
  const late = new LinkShim(link, { host: "127.0.0.1", port, keepaliveSec: 0, connectTimeoutMs: 150 });
  const e2 = await new Promise<Error>(r => late.on("error", r));
  assert.match(e2.message, /connect timed out/);
  assert.ok(Date.now() - t >= 140);
  for (const s of sockets) s.destroy();
  server.close();
});

test("a NAT forgets an idle flow unless keepalive is shorter than its timeout", async () => {
  const { server, port, sockets } = await echoServer();
  const cls: LinkClass = { ...FAST, natIdleSec: [0.2, 0.2] };
  const check = async (keepaliveSec: number): Promise<boolean> => {
    const link = new AgentLink(cls, Math.random);
    const shim = new LinkShim(link, { host: "127.0.0.1", port, keepaliveSec, retransmitGiveUpMs: 100 });
    shim.on("error", () => undefined);
    let echoed = false;
    shim.on("data", () => { echoed = true; });
    shim.write(Buffer.from("a"));
    await new Promise(r => setTimeout(r, 350)); // idle longer than the NAT timeout
    assert.equal(echoed, true);
    echoed = false;
    shim.write(Buffer.from("b"));
    await new Promise(r => setTimeout(r, 100));
    shim.destroy();
    return echoed;
  };
  assert.equal(await check(0), false, "without keepalive the flow is gone");
  assert.equal(await check(0.1), true, "keepalive every 0.1 s keeps a 0.2 s NAT mapping");
  for (const s of sockets) s.destroy();
  server.close();
});

// ---- The agent model against a small Protocol 1.1 server ---------------------------------------
// The platform server does not speak 1.1 yet, so its features are exercised here: HTTP/2 through ALPN, leased delivery
// with ?ack= and a repeat offer answered from the outbox, server-directed intervals, a 429 with Retry-After, and gzip
// event batches once the server has shown 1.1.

test("a 1.1 agent against a 1.1 server: HTTP/2, acks, repeat offer, intervals, 429 Retry-After, gzip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "load-test-pki-"));
  try {
    const key = await developmentIssuingKey(dir);
    const tls = await developmentServerCertificate(key, dir, ["localhost"]);
    const cabinetId = "6f1c2a3b-4d5e-4f60-8a71-b2c3d4e5f607";
    const k = ecKey();
    const cert = await issueAgentCertificate(key, csrFor(k), cabinetId);
    const commandId = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
    const seen = { acks: [] as string[], polls: 0, results: 0, gzip: 0, plain: 0, events: 0, refusedOnce: false, protocols: new Set<string>() };
    const server = createSecureServer({ allowHTTP1: true, key: tls.keyPem, cert: tls.certPem, ca: key.certificatePem, requestCert: true, rejectUnauthorized: true }, (req, res) => {
      seen.protocols.add(req.httpVersion);
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url, "https://localhost");
        const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
          res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body));
        };
        const serverTime = new Date().toISOString();
        if (url.pathname === "/agent/v1/heartbeat") { send(200, { serverTime, scanner: { hardwareIds: null }, intervals: { heartbeatSeconds: 60, pollSeconds: 20, eventsPaceMs: 0 } }); return; }
        if (url.pathname === "/agent/v1/commands") {
          seen.polls++;
          const ack = url.searchParams.get("ack");
          if (ack) seen.acks.push(ack);
          const command = { commandId, cabinetId, operation: "system.info", params: {}, issuedBy: cabinetId, issuedAt: serverTime, expiresAt: new Date(Date.now() + 300_000).toISOString() };
          // The command is offered on the first poll and, as a lease re-offer, again on the third.
          if (seen.polls === 1 || seen.polls === 3) { send(200, { serverTime, commands: [command] }); return; }
          setTimeout(() => send(200, { serverTime, commands: [], pollSeconds: 20 }), 300);
          return;
        }
        if (url.pathname === "/agent/v1/results") { seen.results++; if (seen.results === 1) send(200, { serverTime }); else send(409, { error: "result_not_expected" }); return; }
        if (url.pathname === "/agent/v1/events") {
          if (!seen.refusedOnce) { seen.refusedOnce = true; send(429, { error: "rate_limited" }, { "retry-after": "1" }); return; }
          const raw = Buffer.concat(chunks);
          const gz = req.headers["content-encoding"] === "gzip";
          if (gz) seen.gzip++; else seen.plain++;
          seen.events += (JSON.parse((gz ? gunzipSync(raw) : raw).toString()) as { events: unknown[] }).events.length;
          send(200, { serverTime });
          return;
        }
        send(404, { error: "not_found" });
      });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const counts: Record<string, number> = {};
    const outcomes: string[] = [];
    const protocolsSeen: string[] = [];
    const hooks = {
      phase: () => "test", outputs: { "system.info": { ok: true } },
      request: () => undefined, contact: () => undefined, received: () => undefined, drained: () => undefined, bytes: () => undefined,
      resultDone: (_a: unknown, _id: string, outcome: string) => { outcomes.push(outcome); },
      count: (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; },
      handshake: (_a: unknown, _r: boolean, _ms: number, p: string) => { protocolsSeen.push(p); },
    };
    const agent = new SimAgent({ index: 0, cabinetId, keyPem: k.keyPem, certPem: cert.pem }, new AgentLink(FAST, Math.random),
      { protocol: "1.1", host: "localhost", port, servername: "localhost", ca: key.certificatePem, eventsPerHour: 40, storm: false, timeCompression: 1,
        installMinutes: 0, gzip: "auto", clockOffsetMs: 0, httpOffer: "auto", keepaliveSec: 20 }, hooks as never);
    agent.preload(1); // a backlog of 40 events
    const running = agent.run(0);
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && !(outcomes.length >= 2 && seen.events >= 40 && seen.acks.length >= 2)) await new Promise(r => setTimeout(r, 100));
    agent.stop();
    await running;
    server.close();
    assert.equal(protocolsSeen[0], "h2", "HTTP/2 negotiated through ALPN");
    assert.ok(seen.protocols.has("2.0"));
    assert.equal(seen.acks[0], commandId.toLowerCase(), "the next poll acknowledges the command, lower-case");
    assert.deepEqual(outcomes, ["accepted", "already"], "the repeat offer is answered from the outbox; the server's 409 settles it");
    assert.equal(counts["commands.answeredFromOutbox"], 1);
    assert.equal(counts["refused.429.retryAfter"], 1, "the 429 and its Retry-After were seen (and only the event loop waited)");
    assert.equal(counts["reconnected"], undefined, "a quota refusal does not count as losing the server");
    assert.equal(counts["server11.detected"], 1);
    assert.ok(seen.gzip >= 1, "event batches are gzip-compressed once the server has shown 1.1");
    assert.ok(seen.events >= 40);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
