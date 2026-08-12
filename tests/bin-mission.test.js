// tests/bin-mission.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveMcBin, makeMissionReader } = require('../bin/mission.js');

const SNAP = JSON.stringify({ at: 1, generatedAt: '2026-08-12T17:00:00.000Z', sources: [{ name: 'work', status: 'ok', items: [] }], ask: [], deferred: [], take: {} });
const LEASES = JSON.stringify({ active: [{ path: '/w/a', branch: null, forWhat: 'e2e', minutesLeft: 30 }], expired: [] });

function fakeExec(handler) {
  const calls = [];
  const exec = async (argv, opts) => { calls.push(argv); return handler(argv, opts); };
  exec.calls = calls;
  return exec;
}
const okHandler = (argv) => argv.indexOf('lease') !== -1
  ? { code: 0, stdout: LEASES, stderr: '', timedOut: false }
  : { code: 10, stdout: SNAP, stderr: '', timedOut: false };

test('el default de PRQ_MC_BIN se deriva de CLAUDE_CONFIG_DIR', () => {
  const r = resolveMcBin({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/x');
  assert.equal(r.bin, '/cfg/mission-control/bin/mc');
  assert.equal(r.configured, false);
});

test('sin CLAUDE_CONFIG_DIR cae al homedir, nunca a un path hardcodeado', () => {
  assert.equal(resolveMcBin({}, '/home/x').bin, '/home/x/.claude/mission-control/bin/mc');
});

test('PRQ_MC_BIN explícito marca configured', () => {
  const r = resolveMcBin({ PRQ_MC_BIN: '/opt/mc' }, '/home/x');
  assert.equal(r.bin, '/opt/mc');
  assert.equal(r.configured, true);
});

test('lee status y leases y devuelve el payload con la edad', async () => {
  const exec = fakeExec(okHandler);
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' },
    homeDir: '/home/x', now: () => Date.parse('2026-08-12T17:03:00.000Z') });
  const p = await read({});
  assert.equal(p.status, 'ok');
  assert.equal(p.ageMs, 180000);
  assert.equal(p.leases.active[0].forWhat, 'e2e');
  assert.equal(p.sources.length, 1);
  assert.equal(exec.calls.length, 2);
});

test('single-flight: dos lecturas concurrentes disparan un solo par de execs', async () => {
  const exec = fakeExec(okHandler);
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' }, homeDir: '/h', now: () => 0 });
  await Promise.all([read({}), read({}), read({})]);
  assert.equal(exec.calls.length, 2);
});

test('el TTL evita el segundo exec y vencido lo permite', async () => {
  const exec = fakeExec(okHandler);
  let clock = 0;
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' }, homeDir: '/h', now: () => clock, ttlMs: 60000 });
  await read({});
  clock = 30000; await read({});
  assert.equal(exec.calls.length, 2);
  clock = 90000; await read({});
  assert.equal(exec.calls.length, 4);
});

test('fresh pasa --fresh a mc y saltea el TTL', async () => {
  const exec = fakeExec(okHandler);
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' }, homeDir: '/h', now: () => 0 });
  await read({});
  await read({ fresh: true });
  assert.ok(exec.calls.some(a => a.indexOf('--fresh') !== -1));
});

test('mc ausente y sin configurar es off', async () => {
  const read = makeMissionReader({ exec: fakeExec(okHandler), exists: () => false, env: {}, homeDir: '/h', now: () => 0 });
  assert.equal((await read({})).status, 'off');
});

test('status roto es broken y leases no lo tapa', async () => {
  const exec = fakeExec((argv) => argv.indexOf('lease') !== -1
    ? { code: 0, stdout: LEASES, stderr: '', timedOut: false }
    : { code: 1, stdout: 'basura', stderr: 'boom', timedOut: false });
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' }, homeDir: '/h', now: () => 0 });
  const p = await read({});
  assert.equal(p.status, 'broken');
  assert.deepEqual(p.sources, []);
  assert.equal(p.error.stderr, 'boom');
});

test('status ok con leases roto conserva el status y reporta el error de leases', async () => {
  const exec = fakeExec((argv) => argv.indexOf('lease') !== -1
    ? { code: 3, stdout: '{{', stderr: 'lease boom', timedOut: false }
    : { code: 0, stdout: SNAP, stderr: '', timedOut: false });
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' }, homeDir: '/h', now: () => 0 });
  const p = await read({});
  assert.equal(p.status, 'ok');
  assert.deepEqual(p.leases.active, []);
  assert.match(p.leases.error, /lease boom|exit 3/);
});

test('un fresh disparado con un build no-fresh en vuelo no se cuelga de él', async () => {
  let release;
  const gate = new Promise(res => { release = res; });
  const calls = [];
  const exec = async (argv) => {
    calls.push(argv);
    if (argv.indexOf('lease') === -1) await gate;
    return argv.indexOf('lease') !== -1
      ? { code: 0, stdout: LEASES, stderr: '', timedOut: false }
      : { code: 0, stdout: SNAP, stderr: '', timedOut: false };
  };
  exec.calls = calls;
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' }, homeDir: '/h', now: () => 0 });
  const slow = read({});
  const forced = read({ fresh: true });
  release();
  await Promise.all([slow, forced]);
  assert.ok(calls.some(a => a.indexOf('--fresh') !== -1), 'el fresh nunca llegó a mc');
});
