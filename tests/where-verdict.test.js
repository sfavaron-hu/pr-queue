// tests/where-verdict.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { targetVerdict, prodCross, reproCommand } = require('../where.js');

test('ahead significa que el commit esta contenido', () => {
  const v = targetVerdict({ ref: 'develop' }, 'ahead');
  assert.strictEqual(v.value, 'SÍ');
  assert.strictEqual(v.confidence, 'PROBADO');
  assert.strictEqual(v.ref, 'develop');
});

test('identical tambien cuenta como contenido', () => {
  assert.strictEqual(targetVerdict({ ref: 'develop' }, 'identical').value, 'SÍ');
});

test('behind y diverged son un NO probado', () => {
  assert.strictEqual(targetVerdict({ ref: 'prod' }, 'behind').value, 'NO');
  assert.strictEqual(targetVerdict({ ref: 'prod' }, 'diverged').value, 'NO');
});

test('un ref que no se pudo leer es DESCONOCIDO, nunca NO', () => {
  const v = targetVerdict({ error: '404 variable no existe' }, null);
  assert.strictEqual(v.value, 'DESCONOCIDO');
  assert.strictEqual(v.confidence, 'DESCONOCIDO');
  assert.match(v.reason, /404/);
});

test('un compare que fallo es DESCONOCIDO parcial, nunca NO', () => {
  const v = targetVerdict({ ref: 'develop' }, null);
  assert.strictEqual(v.value, 'DESCONOCIDO');
  assert.strictEqual(v.confidence, 'PARCIAL');
});

test('cuando la variable y el run de release coinciden, prd cierra', () => {
  const c = prodCross('release-2026.08.11',
    { tag: '2026.08.11.03', targetCommitish: 'release-2026.08.11', createdAt: '2026-08-20T15:41:21Z' });
  assert.strictEqual(c.agree, true);
});

test('cuando discrepan no se elige una: se reportan las dos', () => {
  const c = prodCross('release-2026.08.04',
    { tag: '2026.08.11.01', targetCommitish: 'release-2026.08.11', createdAt: '2026-08-11T20:03:00Z' });
  assert.strictEqual(c.agree, false);
  assert.strictEqual(c.varBranch, 'release-2026.08.04');
  assert.strictEqual(c.target, 'release-2026.08.11');
});

test('sin variable de produccion el cruce no afirma nada, y no es un NO', () => {
  const c = prodCross(undefined,
    { tag: '2026.08.11.03', targetCommitish: 'release-2026.08.11', createdAt: '2026-08-20T15:41:21Z' });
  assert.strictEqual(c.agree, null);
  assert.match(c.note, /REACT_PRODUCTION_BRANCH|variable/);
});

test('sin run de release el cruce no afirma nada', () => {
  const c = prodCross('release-2026.08.11', null);
  assert.strictEqual(c.agree, null);
  assert.match(c.note, /event=release/);
});

test('un release lookup fallido no se confunde con "sin run": nota propia', () => {
  const c = prodCross('release-2026.08.11', { error: 'GitHub 404: Not Found', tag: '2026.08.11.03' });
  assert.strictEqual(c.agree, null);
  assert.ok(!/^sin run de CD/.test(c.note), 'no debe reusar la nota de "sin run"');
  assert.match(c.note, /2026.08.11.03|release/);
});

test('el comando reproducible es pegable tal cual', () => {
  assert.strictEqual(reproCommand('HumandDev', 'humand-web', 'abc123', 'develop'),
    'gh api "repos/HumandDev/humand-web/compare/abc123...develop" --jq .status');
});
