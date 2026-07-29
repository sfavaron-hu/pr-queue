const { test } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../serve.js');

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

test('serves index.html at the root', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<script src="state\.js">/);
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

test('refuses path traversal', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/../../etc/passwd`);
  assert.ok(res.status === 403 || res.status === 404);
  server.close();
});

test('unknown paths 404', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  const port = await listen(server);
  assert.equal((await fetch(`http://127.0.0.1:${port}/nope.js`)).status, 404);
  server.close();
});
