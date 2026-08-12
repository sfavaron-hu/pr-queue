const { test } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../serve.js');
const { DEFAULT_TTL_MS } = require('../bin/mission.js');

function listen(server) {
  return new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}
function closeServer(server) { return new Promise(res => server.close(res)); }

test('/api/mission devuelve el payload del lector', async () => {
  const server = createServer({ missionFn: async () => ({ status: 'ok', sources: [], ask: [] }) });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/mission`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await res.json()).status, 'ok');
  } finally { await closeServer(server); }
});

test('?fresh=1 llega al lector como {fresh:true}', async () => {
  const seen = [];
  const server = createServer({ missionFn: async (args) => { seen.push(args); return { status: 'ok' }; } });
  const port = await listen(server);
  try {
    await fetch(`http://127.0.0.1:${port}/api/mission?fresh=1`);
    await fetch(`http://127.0.0.1:${port}/api/mission`);
    assert.deepEqual(seen.map(s => s.fresh), [true, false]);
  } finally { await closeServer(server); }
});

test('/api/mission manda x-mission-ttl-ms para que local.js no hardcodee una segunda copia del TTL', async () => {
  const server = createServer({ missionFn: async () => ({ status: 'ok', sources: [], ask: [] }) });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/mission`);
    assert.equal(res.headers.get('x-mission-ttl-ms'), String(DEFAULT_TTL_MS));
  } finally { await closeServer(server); }
});

test('un lector que explota devuelve 200 broken, no 500', async () => {
  const server = createServer({ missionFn: async () => { throw new Error('boom'); } });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/mission`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'broken');
    assert.match(body.error.stderr, /boom/);
  } finally { await closeServer(server); }
});
