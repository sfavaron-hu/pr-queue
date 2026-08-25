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
    { kind: 'fixed', dev: 'main', stg: 'staging', prd: 'prod' });
});

test('mobile son seis destinos, no tres', () => {
  const ids = envTargets('humand-mobile').map(t => t.id);
  assert.deepStrictEqual(ids, ['dev', 'dev-eu', 'stg', 'stg-eu', 'prd', 'prd-eu']);
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
