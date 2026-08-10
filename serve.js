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

async function handle(req, res, collectFn) {
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch (err) {
    // A scheme-relative target like `//` or `///` parses as `http://` with
    // an empty (or bogus) authority and throws TypeError here — not
    // URIError, so it doesn't hit the existing decodeURIComponent guard
    // below. Tag it so the outer handler can tell "target failed to parse"
    // (client's fault, 400) apart from a TypeError thrown by anything else
    // in this function (our fault, 500) without broadening that catch-all.
    err.isMalformedTarget = true;
    throw err;
  }

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
  // Escaping ROOT isn't the only way in: a dotfile/dotdir segment (`.git`,
  // `.env`) can resolve *inside* ROOT and still be sensitive. Refuse any
  // segment starting with `.` other than the root itself.
  if (rel.split('/').some(seg => seg.startsWith('.'))) {
    res.writeHead(403); return res.end('forbidden');
  }

  try {
    const data = await fs.readFile(full);
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream',
                         'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

function createServer(opts) {
  const collectFn = (opts && opts.collectFn) || realCollect;

  return http.createServer(async (req, res) => {
    // The whole handler is wrapped: a synchronous throw in here (notably
    // decodeURIComponent on a malformed escape like `/%`) would otherwise
    // escape as an uncaught exception and kill the process, taking
    // /api/local down with it.
    try {
      await handle(req, res, collectFn);
    } catch (err) {
      if (!res.headersSent) {
        const bad = err instanceof URIError || err.isMalformedTarget === true;
        res.writeHead(bad ? 400 : 500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(bad ? 'bad request' : 'internal error');
      } else {
        res.destroy();
      }
    }
  });
}

// Validates PRQ_PORT before listen(). server.listen(NaN) throws synchronously
// and bypasses the 'error' handler, so an invalid value would surface as a raw
// stack trace instead of a message naming the offending variable.
function resolvePort(env) {
  const raw = env.PRQ_PORT;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`PRQ_PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return n;
}

if (require.main === module) {
  let port;
  try {
    port = resolvePort(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
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

module.exports = { createServer, DEFAULT_PORT, resolvePort };
