const { test } = require('node:test');
const assert = require('node:assert');
const { createServer, DEFAULT_PORT, resolvePort } = require('../serve.js');
const { collect } = require('../collect.js');

function listen(server) {
  return new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

function closeServer(server) {
  return new Promise(res => server.close(res));
}

// Every test must close its server even when an assertion throws — otherwise
// a failing assertion leaves the listener open and node:test's runner hangs
// waiting for the event loop to drain instead of exiting. Wrapping the test
// body in try/finally (awaiting close) makes cleanup unconditional.
async function withServer(server, body) {
  try {
    const port = await listen(server);
    await body(port);
  } finally {
    await closeServer(server);
  }
}

test('GET /api/local returns the collector payload as JSON', async () => {
  const server = createServer({ collectFn: async () => ({ processes: [], warnings: [], workspaceRoot: '/w' }) });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/local`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual((await res.json()).processes, []);
  });
});

test('GET /api/local still carries its own cache-control: no-store (regression guard)', async () => {
  const server = createServer({ collectFn: async () => ({ processes: [], warnings: [], workspaceRoot: '/w' }) });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/local`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

test('GET /api/local returns 500 with a message when the collector throws', async () => {
  const server = createServer({ collectFn: async () => { throw new Error('boom'); } });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/local`);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /boom/);
  });
});

test('GET /api/local returns 200 with a warning, not 500, when the workspace root is unreadable (e.g. a typo\'d PRQ_WORKSPACE)', async () => {
  const collectFn = () => collect({
    env: {}, homeDir: '/home/dev', checkoutDir: '/w/pr-queue', now: () => 1785000000000,
    run: async (cmd) => (cmd === 'claude' ? '[]' : ''),
    listDirs: async () => { throw new Error('ENOENT: no such file or directory'); },
    listFiles: async () => [],
    readTail: async () => '',
  });
  const server = createServer({ collectFn });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/local`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.processes, []);
    assert.equal(body.warnings.length, 1);
    assert.match(body.warnings[0].message, /PRQ_WORKSPACE/);
  });
});

test('serves index.html at the root', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const body = await res.text();
    assert.match(body, /<script src="state\.js">/);
    assert.match(body, /<script src="classify\.js">/);
    assert.match(body, /<script src="local\.js">/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

test('serves a static js file with the right content type', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/classify.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
  });
});

test('a static file response carries cache-control: no-store so browsers never heuristically cache stale JS', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/classify.js`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

test('refuses a dotfile segment inside ROOT', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/.git/config`);
    assert.equal(res.status, 403);
  });
});

test('unknown paths 404', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  await withServer(server, async (port) => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope.js`)).status, 404);
  });
});

test('refuses an encoded path traversal', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`);
    assert.ok(res.status === 403 || res.status === 404);
  });
});

test('a malformed percent-encoded path returns 400 and the server stays alive', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  await withServer(server, async (port) => {
    const bad = await fetch(`http://127.0.0.1:${port}/%`);
    assert.equal(bad.status, 400);
    const ok = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(ok.status, 200);
  });
});

test('a malformed percent-encoded path deeper in the URL also returns 400 and the server stays alive', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  await withServer(server, async (port) => {
    const bad = await fetch(`http://127.0.0.1:${port}/foo/%zz`);
    assert.equal(bad.status, 400);
    const ok = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(ok.status, 200);
  });
});

// `new URL(req.url, 'http://127.0.0.1')` throws TypeError (not URIError) for
// a scheme-relative request target: `//` parses as `http://` with an empty
// authority, which is invalid. This used to fall through to the generic 500
// handler — a 500 in the log reads as a server bug when it's really a
// malformed client request. These three guard the fix and that it doesn't
// regress the "process survives" property the URIError case already had.
test('GET // (scheme-relative target) returns 400, and the server stays alive for a subsequent request', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  await withServer(server, async (port) => {
    const bad = await fetch(`http://127.0.0.1:${port}//`);
    assert.equal(bad.status, 400);
    const ok = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(ok.status, 200);
  });
});

test('GET /// (scheme-relative target) returns 400, and the server stays alive for a subsequent request', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  await withServer(server, async (port) => {
    const bad = await fetch(`http://127.0.0.1:${port}///`);
    assert.equal(bad.status, 400);
    const ok = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(ok.status, 200);
  });
});

// Unlike `//` and `///`, `//evil.com/x` is NOT malformed as a URL: `new URL`
// parses it successfully as a protocol-relative reference, with host
// "evil.com" and pathname "/x" — it does not throw, so it never reaches the
// 400 path at all. Only `url.pathname` is ever used to resolve a file (the
// host is never consulted), so "/x" still resolves under ROOT like any
// other request and cannot be used to escape it or reach evil.com's content.
test('GET //evil.com/x parses as a URL (pathname "/x"), is not treated as malformed, and is not served from outside ROOT', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}//evil.com/x`);
    // No file named "x" exists under ROOT, so this 404s — it must NOT be a
    // 400 (that would mean we started treating a validly-parsed URL as
    // malformed) and must NOT be a 200 serving something unexpected.
    assert.equal(res.status, 404);
  });
});

test('a genuine internal error (thrown outside URL parsing) still returns 500, not 400', async () => {
  // Reuses the collectFn seam to throw a TypeError from deep inside the
  // request handling that has nothing to do with parsing the request
  // target — proving the 400 path is scoped to URL-parse failures only and
  // fix 1 did not relabel real server errors as client errors.
  const server = createServer({ collectFn: async () => { throw new TypeError('boom: not a URL parse failure'); } });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/local`);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /boom/);
  });
});

test('resolvePort: unset PRQ_PORT falls back to the default', () => {
  assert.equal(resolvePort({}), DEFAULT_PORT);
});

test('resolvePort: empty string PRQ_PORT falls back to the default', () => {
  assert.equal(resolvePort({ PRQ_PORT: '' }), DEFAULT_PORT);
});

test('resolvePort: a valid numeric string is parsed', () => {
  assert.equal(resolvePort({ PRQ_PORT: '8080' }), 8080);
});

test('resolvePort: a non-numeric string throws', () => {
  assert.throws(() => resolvePort({ PRQ_PORT: 'abc' }), /PRQ_PORT/);
});

test('resolvePort: 0 throws', () => {
  assert.throws(() => resolvePort({ PRQ_PORT: '0' }), /PRQ_PORT/);
});

test('resolvePort: a port above 65535 throws', () => {
  assert.throws(() => resolvePort({ PRQ_PORT: '70000' }), /PRQ_PORT/);
});

test('resolvePort: a non-integer throws', () => {
  assert.throws(() => resolvePort({ PRQ_PORT: '80.5' }), /PRQ_PORT/);
});
