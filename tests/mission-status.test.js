const { test } = require('node:test');
const assert = require('node:assert');
const { classifyMissionRead, normalizeSourceStatus } = require('../mission.js');

const snap = (over) => JSON.stringify(Object.assign({
  at: 1, generatedAt: '2026-08-12T17:00:00.000Z', sources: [], ask: [], deferred: [], take: {},
}, over));

test('exit 10 con JSON válido es ok, no un fallo', () => {
  const r = classifyMissionRead({ configured: true, code: 10, stdout: snap(), stderr: '' });
  assert.equal(r.status, 'ok');
  assert.equal(r.snapshot.generatedAt, '2026-08-12T17:00:00.000Z');
  assert.equal(r.error, null);
});

test('exit 4 con JSON válido es degraded', () => {
  assert.equal(classifyMissionRead({ configured: true, code: 4, stdout: snap() }).status, 'degraded');
});

test('exit 3 con JSON válido sigue siendo ok: el estado ciego vive en las fuentes', () => {
  assert.equal(classifyMissionRead({ configured: true, code: 3, stdout: snap() }).status, 'ok');
});

test('JSON roto es broken y nunca ok con 0 items', () => {
  const r = classifyMissionRead({ configured: true, code: 0, stdout: 'no soy json', stderr: 'boom' });
  assert.equal(r.status, 'broken');
  assert.equal(r.snapshot, null);
  assert.equal(r.error.stderr, 'boom');
});

test('timeout es broken y lo dice', () => {
  const r = classifyMissionRead({ configured: true, code: 1, stdout: '', timedOut: true });
  assert.equal(r.status, 'broken');
  assert.equal(r.error.timedOut, true);
});

test('binario ausente pero configurado a mano es broken', () => {
  assert.equal(classifyMissionRead({ configured: true, missing: true }).status, 'broken');
});

test('binario ausente y sin configurar es off: el panel no pinta nada', () => {
  assert.equal(classifyMissionRead({ configured: false, missing: true }).status, 'off');
});

test('el legacy no-check de una caché vieja se normaliza a broken', () => {
  assert.equal(normalizeSourceStatus('no-check'), 'broken');
  assert.equal(normalizeSourceStatus('ok'), 'ok');
});
