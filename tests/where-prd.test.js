// tests/where-prd.test.js — prd mide contra el tag desplegado (el head_branch
// del ultimo run de CD event=release exitoso), no contra la rama DESIGNADA
// prod (REACT_PRODUCTION_BRANCH): esa variable nombra la rama el dia que se
// CORTA, dias antes de que nada despliegue desde ahi.
const { test } = require('node:test');
const assert = require('node:assert');
const { prdVerdict, trainDate } = require('../where.js');

test('prd es SÍ cuando el commit esta contenido en el tag desplegado', () => {
  const v = prdVerdict({ ref: '2026.08.19.03' }, 'ahead', null);
  assert.strictEqual(v.value, 'SÍ');
  assert.strictEqual(v.confidence, 'PROBADO');
  assert.strictEqual(v.ref, '2026.08.19.03');
});

test('identical tambien cuenta como contenido en el tag', () => {
  const v = prdVerdict({ ref: '2026.08.19.03' }, 'identical', null);
  assert.strictEqual(v.value, 'SÍ');
});

test('SÍ no necesita leer la rama designada: no se rompe si branch viene null', () => {
  const v = prdVerdict({ ref: '2026.08.19.03' }, 'ahead', null);
  assert.strictEqual(v.value, 'SÍ');
  assert.strictEqual(v.confidence, 'PROBADO');
});

test('en la rama pero no en el tag: NO probado, con la rama y la fecha estimada', () => {
  const v = prdVerdict({ ref: '2026.08.19.03' }, 'diverged',
    { ref: 'release-2026.08.19', compareStatus: 'ahead' });
  assert.strictEqual(v.value, 'NO');
  assert.strictEqual(v.confidence, 'PROBADO');
  assert.ok(v.train, 'debe traer info de tren');
  assert.strictEqual(v.train.branch, 'release-2026.08.19');
  assert.strictEqual(v.train.estimate, '2026-08-26');
});

test('ni en el tag ni en la rama: NO probado, sin nota de tren, nada sin medir', () => {
  const v = prdVerdict({ ref: '2026.08.19.03' }, 'diverged',
    { ref: 'release-2026.07.01', compareStatus: 'diverged' });
  assert.strictEqual(v.value, 'NO');
  assert.strictEqual(v.confidence, 'PROBADO');
  assert.strictEqual(v.train, undefined);
});

test('sin run de CD exitoso: DESCONOCIDO, no NO', () => {
  const v = prdVerdict({ error: 'sin run de CD con event=release y conclusion=success' }, null, null);
  assert.strictEqual(v.value, 'DESCONOCIDO');
  assert.strictEqual(v.confidence, 'DESCONOCIDO');
});

test('el compare contra el tag falla: DESCONOCIDO parcial, no NO', () => {
  const v = prdVerdict({ ref: '2026.08.19.03' }, null, null);
  assert.strictEqual(v.value, 'DESCONOCIDO');
  assert.strictEqual(v.confidence, 'PARCIAL');
});

test('el tag dice NO pero REACT_PRODUCTION_BRANCH no se pudo leer: DESCONOCIDO, no un NO a medias', () => {
  const v = prdVerdict({ ref: '2026.08.19.03' }, 'diverged',
    { error: 'GitHub 404: Not Found' });
  assert.strictEqual(v.value, 'DESCONOCIDO');
  assert.strictEqual(v.confidence, 'DESCONOCIDO');
});

test('el tag dice NO y la rama se leyo pero su compare fallo: DESCONOCIDO parcial', () => {
  const v = prdVerdict({ ref: '2026.08.19.03' }, 'diverged',
    { ref: 'release-2026.08.19', compareStatus: null });
  assert.strictEqual(v.value, 'DESCONOCIDO');
  assert.strictEqual(v.confidence, 'PARCIAL');
});

test('estimado: release-2026.08.19 despliega 7 dias despues del corte', () => {
  assert.strictEqual(trainDate('release-2026.08.19'), '2026-08-26');
});

test('estimado cruza el limite de mes: release-2026.08.25 -> 2026-09-01', () => {
  assert.strictEqual(trainDate('release-2026.08.25'), '2026-09-01');
});

test('una rama que no tiene forma release-YYYY.MM.DD no da estimado', () => {
  assert.strictEqual(trainDate('main'), null);
});
