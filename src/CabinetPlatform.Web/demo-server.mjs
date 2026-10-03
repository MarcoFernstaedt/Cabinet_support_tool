import http from "node:http";
import { readFile } from "node:fs/promises";

const assets = new Map([
  ["/", ["demo.html", "text/html; charset=utf-8"]],
  ["/demo.css", ["demo.css", "text/css; charset=utf-8"]],
  ["/demo-app.mjs", ["demo-app.mjs", "text/javascript; charset=utf-8"]],
  ["/demo-data.mjs", ["demo-data.mjs", "text/javascript; charset=utf-8"]],
]);
export function createDemoServer({ tailnetHost = null } = {}) {
  return http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const expectedHost = `127.0.0.1:${serverPort(req)}`;
    if (req.headers.host !== expectedHost && req.headers.host !== tailnetHost) { res.writeHead(421); res.end("Invalid host"); return; }
    const asset = assets.get(req.url);
    if (req.method !== "GET" || !asset) { res.writeHead(404); res.end("Not found"); return; }
    try {
      const body = await readFile(new URL(asset[0], import.meta.url));
      res.writeHead(200, { "Content-Type": asset[1] });
      res.end(body);
    } catch {
      res.writeHead(500); res.end("Demo asset unavailable");
    }
  });
}
function serverPort(req) { return req.socket.localPort; }
if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  createDemoServer().listen(4174, "127.0.0.1", () => console.log("Cabinet Demo (synthetic sample data): http://127.0.0.1:4174/"));
}
