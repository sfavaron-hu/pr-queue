const { test } = require('node:test');
const assert = require('node:assert');
const { createServer, DEFAULT_PORT, resolvePort } = require('../serve.js');
const { collect } = require('../collect.js');

function listen(server) {
  return new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

test('GET /api/local returns the collector payload as JSON', async () => {
  const server = createServer({ collectFn: async () => ({ processes: [], warnings: [], workspaceRoot: '/w' }) });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/local`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual((await res.json()).processes, []);
  server.close();
});

test('GET /api/local returns 500 with a message when the collector throws', async () => {
  const server = createServer({ collectFn: async () => { throw new Error('boom'); } });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/local`);
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /boom/);
  server.close();
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
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/local`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.processes, []);
  assert.equal(body.warnings.length, 1);
  assert.match(body.warnings[0].message, /PRQ_WORKSPACE/);
  server.close();
});

test('serves index.html at the root', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const body = await res.text();
  assert.match(body, /<script src="state\.js">/);
  assert.match(body, /<script src="classify\.js">/);
  assert.match(body, /<script src="local\.js">/);
  server.close();
});

test('serves a static js file with the right content type', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/classify.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  server.close();
});

test('refuses a dotfile segment inside ROOT', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/.git/config`);
  assert.equal(res.status, 403);
  server.close();
});

test('unknown paths 404', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  const port = await listen(server);
  assert.equal((await fetch(`http://127.0.0.1:${port}/nope.js`)).status, 404);
  server.close();
});

test('refuses an encoded path traversal', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`);
  assert.ok(res.status === 403 || res.status === 404);
  server.close();
});

test('a malformed percent-encoded path returns 400 and the server stays alive', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  const port = await listen(server);
  const bad = await fetch(`http://127.0.0.1:${port}/%`);
  assert.equal(bad.status, 400);
  const ok = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(ok.status, 200);
  server.close();
});

test('a malformed percent-encoded path deeper in the URL also returns 400 and the server stays alive', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  const port = await listen(server);
  const bad = await fetch(`http://127.0.0.1:${port}/foo/%zz`);
  assert.equal(bad.status, 400);
  const ok = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(ok.status, 200);
  server.close();
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
