const { test } = require('node:test');
const assert = require('node:assert');
const { envModel, envTargets, tagMatcher, WHERE_UNKNOWN } = require('../where.js');

// main-api tiene su propio modelo (ver tests/where-backend.test.js): un
// workflow por entorno, con la ref de stg viviendo en el nombre del run en
// vez de en una rama o variable.
test('main-api tiene modelo backend, no unknown', () => {
  const m = envModel('humand-main-api');
  assert.strictEqual(m.kind, 'backend');
});

test('un repo que no conocemos tambien es unknown', () => {
  assert.strictEqual(envModel('humand-koda').kind, 'unknown');
});

test('web resuelve stg y prd por variable de Actions', () => {
  const m = envModel('humand-web');
  assert.strictEqual(m.kind, 'react');
  assert.strictEqual(m.dev, 'develop');
});

test('hu-translations usa ramas fijas', () => {
  assert.deepStrictEqual(envModel('hu-translations'),
    { kind: 'fixed', dev: 'main', stg: 'staging', prd: 'prod', trunk: 'main' });
});

// material-hu tiene las mismas tres ramas fijas que hu-translations
// (main/staging/prod, sin develop) — no la familia 'react' de variables de
// Actions. Carga REACT_* pero no despliega desde ahi (medido 25/08/2026: sin
// ningun run de CD con event=release, prd quedaba DESCONOCIDO por falta de
// esa fuente, no porque el repo no tenga entorno prd).
test('material-hu usa ramas fijas, igual que hu-translations', () => {
  assert.deepStrictEqual(envModel('material-hu'),
    { kind: 'fixed', dev: 'main', stg: 'staging', prd: 'prod', trunk: 'main' });
});

// Medido en vivo el 25/08/2026: mobile no publica dev-eu (el ultimo fue
// v4.2.7, fuera de la ventana de 100 tags), pero si stg-eu y prod-eu. Generar
// un destino dev-eu que la app jamas publica lo deja DESCONOCIDO para
// siempre, una senal de degradacion que no informa nada.
test('mobile no genera dev-eu: nunca lo publica', () => {
  const ids = envTargets('humand-mobile').map(t => t.id);
  assert.deepStrictEqual(ids, ['dev', 'stg', 'stg-eu', 'prd', 'prd-eu']);
});

test('los demas repos son tres destinos', () => {
  assert.deepStrictEqual(envTargets('humand-web').map(t => t.id), ['dev', 'stg', 'prd']);
});

test('el matcher de tags no confunde global con eu', () => {
  const global = tagMatcher('stg', '');
  assert.ok(global.test('v4.3.5-stg-1'));
  assert.ok(!global.test('v4.3.4-stg-eu-1'));
  assert.ok(tagMatcher('stg', 'eu').test('v4.3.4-stg-eu-1'));
});

test('prd se escribe prod en los tags', () => {
  assert.ok(tagMatcher('prd', '').test('v4.3.4-prod-1'));
});

test('WHERE_UNKNOWN es el literal que muestra la UI', () => {
  assert.strictEqual(WHERE_UNKNOWN, 'DESCONOCIDO');
});
