// tests/bin-mission.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveMcBin, makeMissionReader, DEFAULT_STALE_AFTER_MS, DEFAULT_TTL_MS } = require('../bin/mission.js');

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

test('staleAfterMs por defecto deja margen antes de que venza la caché de 5min de mc', () => {
  // Si staleAfterMs igualara los 300000 de la caché de mc, la MISMA lectura
  // que nota "viejo" (a los 240000..300000, en el peor caso justo al cruzar
  // la línea) sería la que se come el rebuild de 133s de mc y muere en el
  // cap de 20s del endpoint. El margen tiene que ser de al menos un ciclo de
  // sampleo (DEFAULT_TTL_MS) para que un read arranque el refresco de fondo
  // ANTES de que la caché de mc expire debajo.
  assert.equal(DEFAULT_STALE_AFTER_MS, 240000);
  assert.ok(DEFAULT_STALE_AFTER_MS + DEFAULT_TTL_MS <= 300000,
    'staleAfterMs + ttlMs debe caber dentro de los 5min de la caché de mc');
});

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

test('un snapshot vencido se sirve igual y dispara UN refresco de fondo', async () => {
  const exec = fakeExec(okHandler);          // SNAP con generatedAt viejo
  let clock = Date.parse('2026-08-12T18:00:00.000Z');
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' },
    homeDir: '/h', now: () => clock, staleAfterMs: 300000 });
  const p = await read({});
  assert.equal(p.status, 'ok');              // sirve lo viejo, no espera
  assert.equal(p.refreshing, true);
  await new Promise(r => setImmediate(r));   // dejar correr el detached
  assert.equal(exec.calls.filter(a => a.indexOf('--fresh') !== -1).length, 1);
});

test('un snapshot reciente no dispara nada de fondo', async () => {
  const exec = fakeExec(okHandler);
  // SNAP.generatedAt es 17:00:00; a las 17:03:00 el ageMs (180000) queda bajo
  // el staleAfterMs por defecto (300000) — nada que refrescar.
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' },
    homeDir: '/h', now: () => Date.parse('2026-08-12T17:03:00.000Z') });
  const p = await read({});
  assert.equal(p.status, 'ok');
  assert.equal(p.refreshing, false);
  assert.equal(exec.calls.filter(a => a.indexOf('--fresh') !== -1).length, 0);
});

test('dos lecturas vencidas seguidas no apilan dos refrescos', async () => {
  const calls = [];
  // El status/lease normales resuelven siempre; el --fresh de fondo se queda
  // colgado a propósito, así el flag `refreshing` no se libera durante el
  // test y la segunda lectura llega mientras el primer refresco sigue en
  // vuelo — sin esto, dos resoluciones rápidas por fakeExec podrían liberar
  // el flag antes de la segunda lectura y esconder un stacking real.
  const exec = async (argv) => {
    calls.push(argv);
    if (argv.indexOf('--fresh') !== -1) return new Promise(() => {});
    return okHandler(argv);
  };
  let clock = Date.parse('2026-08-12T18:00:00.000Z');
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' },
    homeDir: '/h', now: () => clock, staleAfterMs: 300000, ttlMs: 0 });
  await read({});
  await read({});
  assert.equal(calls.filter(a => a.indexOf('--fresh') !== -1).length, 1);
});

test('lo que trae el refresco de fondo es lo que sirve la lectura siguiente', async () => {
  const OLD_SNAP = JSON.stringify({ at: 1, generatedAt: '2026-08-12T10:00:00.000Z', sources: [{ name: 'work', status: 'ok', items: [] }], ask: [], deferred: [], take: {} });
  const NEW_SNAP = JSON.stringify({ at: 2, generatedAt: '2026-08-12T18:00:00.000Z', sources: [{ name: 'work', status: 'ok', items: [] }], ask: [], deferred: [], take: {} });
  const exec = async (argv) => {
    if (argv.indexOf('lease') !== -1) return { code: 0, stdout: LEASES, stderr: '', timedOut: false };
    if (argv.indexOf('--fresh') !== -1) return { code: 0, stdout: NEW_SNAP, stderr: '', timedOut: false };
    return { code: 10, stdout: OLD_SNAP, stderr: '', timedOut: false };
  };
  const clock = Date.parse('2026-08-12T18:00:00.000Z');
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' },
    homeDir: '/h', now: () => clock, staleAfterMs: 300000 });
  const first = await read({});
  assert.equal(first.generatedAt, '2026-08-12T10:00:00.000Z');
  await new Promise(r => setImmediate(r));   // dejar aterrizar el refresco de fondo
  const second = await read({});             // dentro del TTL: sirve la caché ya actualizada
  assert.equal(second.generatedAt, '2026-08-12T18:00:00.000Z');
});

test('un status que timeoutea es broken con ageMs null y arma igual el refresco de fondo', async () => {
  // El caso real del finding: `mc status` pega el cap de 20s del endpoint y
  // vuelve killeado. classifyMissionRead no tiene snapshot que parsear ⇒
  // ageMs sale null, no un número vencido — maybeKickRefresh no puede mirar
  // "> staleAfterMs" sobre eso, tiene que tratar "no sé la edad" como vencido.
  const exec = fakeExec((argv) => argv.indexOf('lease') !== -1
    ? { code: 0, stdout: LEASES, stderr: '', timedOut: false }
    : { code: null, stdout: '', stderr: '', timedOut: true });
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' }, homeDir: '/h', now: () => 0 });
  const p = await read({});
  assert.equal(p.status, 'broken');
  assert.equal(p.ageMs, null);
  assert.equal(p.refreshing, true);
  await new Promise(r => setImmediate(r));   // dejar correr el detached
  assert.equal(exec.calls.filter(a => a.indexOf('--fresh') !== -1).length, 1);
});

test('el refresco de fondo armado por un timeout sana la próxima lectura', async () => {
  // Cierra el loop: no alcanza con que se arme el refresco (test anterior),
  // tiene que aterrizar y la lectura siguiente tiene que servir lo sano.
  const NEW_SNAP = JSON.stringify({ at: 2, generatedAt: '2026-08-12T18:00:00.000Z', sources: [{ name: 'work', status: 'ok', items: [] }], ask: [], deferred: [], take: {} });
  const exec = async (argv) => {
    if (argv.indexOf('lease') !== -1) return { code: 0, stdout: LEASES, stderr: '', timedOut: false };
    if (argv.indexOf('--fresh') !== -1) return { code: 0, stdout: NEW_SNAP, stderr: '', timedOut: false };
    return { code: null, stdout: '', stderr: '', timedOut: true };   // la lectura normal siempre timeoutea
  };
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' }, homeDir: '/h', now: () => 0 });
  const first = await read({});
  assert.equal(first.status, 'broken');
  await new Promise(r => setImmediate(r));   // dejar aterrizar el refresco de fondo
  const second = await read({});             // dentro del TTL: sirve la caché ya sanada
  assert.equal(second.status, 'ok');
  assert.equal(second.generatedAt, '2026-08-12T18:00:00.000Z');
});

test('un build roto no pisa un cached bueno anterior; el que lo pide ve la verdad, la caché retiene lo bueno', async () => {
  // Decisión explícita del finding: ¿un payload broken debe pisar un cached
  // bueno anterior? No — serviría "nada" donde antes servía algo real, sólo
  // envejeciendo. El caller que dispara el build roto sí ve la verdad (no se
  // le miente), pero `cached` retiene el último snapshot bueno para que la
  // próxima lectura rápida (TTL) siga sirviendo datos.
  let statusCalls = 0;
  const exec = async (argv) => {
    if (argv.indexOf('lease') !== -1) return { code: 0, stdout: LEASES, stderr: '', timedOut: false };
    statusCalls += 1;
    if (statusCalls === 1) return okHandler(argv);                 // el primer status: bueno
    return { code: null, stdout: '', stderr: '', timedOut: true };  // todos los siguientes: timeout
  };
  let clock = Date.parse('2026-08-12T17:00:00.000Z');   // = generatedAt de SNAP: ageMs 0 al leer
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' },
    homeDir: '/h', now: () => clock, ttlMs: 60000 });
  const first = await read({});
  assert.equal(first.status, 'ok');

  clock += 60001;                        // vence el TTL: la próxima lectura fuerza un build nuevo
  const second = await read({});         // ese build nuevo timeoutea
  assert.equal(second.status, 'broken');  // quien pidió ESTA lectura ve la verdad, no la caché vieja

  const third = await read({});          // mismo clock, dentro del TTL reseteado por la lectura anterior
  assert.equal(third.status, 'ok');       // pero la caché para lecturas futuras retuvo el último snapshot bueno
  assert.equal(third.sources.length, 1);
  assert.equal(third.generatedAt, '2026-08-12T17:00:00.000Z');
  // Es el MISMO snapshot cacheado (misma identidad, mismo generatedAt) el que
  // se sigue sirviendo — eso es lo que "retener el último bueno" quiere
  // decir. Pero ageMs se deriva al servir, no se congela: como el reloj
  // avanzó 60001ms entre `first` y acá (el TTL vencido de la lectura del
  // medio), la edad reportada tiene que reflejarlo — lo contrario es la
  // mentira exacta que este finding existe para prevenir.
  assert.equal(third.generatedAt, first.generatedAt);
  assert.equal(third.ageMs, first.ageMs + 60001);
});

test('un cached bueno servido más tarde reporta una edad mayor (ageMs se deriva al servir, no se congela)', async () => {
  const exec = fakeExec(okHandler);
  let clock = Date.parse('2026-08-12T17:03:00.000Z');
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' },
    homeDir: '/h', now: () => clock, ttlMs: 300000 });
  const first = await read({});
  assert.equal(first.ageMs, 180000);
  clock += 30000;                              // dentro del TTL: la próxima lectura pega el fast path
  const second = await read({});
  assert.equal(exec.calls.length, 2);           // ningún build nuevo — mismo snapshot cacheado
  assert.equal(second.generatedAt, first.generatedAt);
  assert.equal(second.ageMs, 210000);           // pero la edad reportada avanzó con el reloj
});

test('tras un build roto, el fast-path subsecuente reporta la edad real (no la congelada) y sigue pidiendo refresco', async () => {
  const calls = [];
  let statusCalls = 0;
  const exec = async (argv) => {
    calls.push(argv);
    if (argv.indexOf('lease') !== -1) return { code: 0, stdout: LEASES, stderr: '', timedOut: false };
    // El refresco de fondo se cuelga a propósito: lo que importa acá es lo
    // que se sirve desde `cached` mientras tanto, no si el detached aterriza.
    if (argv.indexOf('--fresh') !== -1) return new Promise(() => {});
    statusCalls += 1;
    if (statusCalls === 1) return okHandler(argv);                   // primer build (propio): bueno
    return { code: null, stdout: '', stderr: '', timedOut: true };   // el segundo build (propio): timeout
  };
  let clock = Date.parse('2026-08-12T17:00:00.000Z');   // = generatedAt del SNAP: ageMs 0 al construirlo
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' },
    homeDir: '/h', now: () => clock, ttlMs: 60000, staleAfterMs: 240000 });

  const first = await read({});
  assert.equal(first.status, 'ok');
  assert.equal(first.refreshing, false);

  clock += 300001;                        // TTL largamente vencido: build propio nuevo, que timeoutea
  const second = await read({});
  assert.equal(second.status, 'broken');  // a quien lo pidió, la verdad — no se le miente

  clock += 10000;                         // dentro del TTL reseteado por el build roto: fast path
  const third = await read({});
  assert.equal(third.status, 'ok');                    // sirve el cached bueno retenido
  assert.equal(third.generatedAt, first.generatedAt);  // el mismo snapshot de siempre — identidad retenida
  assert.equal(third.ageMs, 310001);                   // la edad REAL, no la congelada en 0 del build original
  assert.equal(third.refreshing, true);                // sigue pidiendo refresco: no se queda calladita

  clock += 20000;                         // sigue dentro del TTL: otro fast-path
  const fourth = await read({});
  assert.equal(fourth.ageMs, 330001);      // la edad servida sigue creciendo con cada lectura
  assert.equal(fourth.refreshing, true);   // y el refresco sigue armado, no se apaga solo

  assert.equal(calls.filter(a => a.indexOf('--fresh') !== -1).length, 1); // tampoco apila refrescos de fondo
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
