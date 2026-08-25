const { test } = require('node:test');
const assert = require('node:assert');
const { envModel, envTargets, tagMatcher, WHERE_UNKNOWN } = require('../where.js');

test('main-api queda declarado sin modelo, con motivo', () => {
  const m = envModel('humand-main-api');
  assert.strictEqual(m.kind, 'unknown');
  assert.match(m.reason, /REACT_\*/);
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
