const { test } = require('node:test');
const assert = require('node:assert');
const { compareLinkAllowed } = require('../mission.js');

test('payload fresco: onOrigin desconocido sigue permitiendo el link (contrato viejo)', () => {
  assert.equal(compareLinkAllowed({ onOrigin: null }, false), true);
  assert.equal(compareLinkAllowed({}, false), true);
});

test('payload fresco: onOrigin false lo bloquea, como hoy', () => {
  assert.equal(compareLinkAllowed({ onOrigin: false }, false), false);
});

test('payload cacheado: sólo un onOrigin true confirmado permite el link', () => {
  assert.equal(compareLinkAllowed({ onOrigin: true }, true), true);
  assert.equal(compareLinkAllowed({ onOrigin: null }, true), false);
  assert.equal(compareLinkAllowed({}, true), false);
  assert.equal(compareLinkAllowed({ onOrigin: false }, true), false);
});
