// Local sidecar: serves the static site plus GET /api/local.
// Bound to 127.0.0.1 only — this exposes local filesystem state and must
// never be reachable from the network.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { collect } = require('./collect.js');
// bin/collect.js only runs main() when invoked directly, so requiring it here
// is safe and avoids duplicating the real IO implementations.
const { run, listDirs, listFiles, readTail } = require('./bin/collect.js');

const ROOT = __dirname;
const DEFAULT_PORT = 7777;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
};

function realCollect() {
  return collect({
    env: process.env,
    homeDir: os.homedir(),
    checkoutDir: ROOT,
    run, listDirs, listFiles, readTail,
    now: () => Date.now(),
  });
}

function createServer(opts) {
  const collectFn = (opts && opts.collectFn) || realCollect;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/api/local') {
      try {
        const payload = await collectFn();
        const body = JSON.stringify(payload);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
                             'cache-control': 'no-store' });
        return res.end(body);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: String(err && err.message || err) }));
      }
    }

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const full = path.resolve(ROOT, rel);
    if (!full.startsWith(ROOT + path.sep)) {
      res.writeHead(403); return res.end('forbidden');
    }

    try {
      const data = await fs.readFile(full);
      res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PRQ_PORT || DEFAULT_PORT);
  const server = createServer({});
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Never auto-increment: the whole point is a stable bookmark.
      console.error(`Port ${port} is already in use. Free it, or set PRQ_PORT to another port.`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`pr-queue local → http://localhost:${port}`);
  });
}

module.exports = { createServer, DEFAULT_PORT };
