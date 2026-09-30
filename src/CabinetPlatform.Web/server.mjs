import http from 'node:http';
import { readFile } from 'node:fs/promises';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/bootstrap.mjs', ['bootstrap.mjs', 'text/javascript; charset=utf-8']]
]);
export function createPreviewServer(host = '127.0.0.1') {
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('Preview must bind to loopback only');
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    if (req.method !== 'GET' || !files.has(req.url)) { res.writeHead(404); res.end('Not found'); return; }
    const [name, contentType] = files.get(req.url);
    try {
      const body = await readFile(new URL(name, import.meta.url));
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(body);
    } catch { res.writeHead(500); res.end('Preview unavailable'); }
  });
}
if (process.argv[1] && new URL(process.argv[1], 'file:').href === import.meta.url) {
  createPreviewServer().listen(4173, '127.0.0.1', () => console.log('Local-only synthetic web preview: http://127.0.0.1:4173'));
}
