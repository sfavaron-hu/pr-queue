const { test } = require('node:test');
const assert = require('node:assert');
const { shouldShowSidecarHint } = require('../mission.js');

test('se pinta sólo cuando el fetch ya falló', () => {
  assert.equal(shouldShowSidecarHint({ fetchFailed: true, dismissed: false }), true);
  assert.equal(shouldShowSidecarHint({ fetchFailed: false, dismissed: false }), false);
});

test('el dismiss manda', () => {
  assert.equal(shouldShowSidecarHint({ fetchFailed: true, dismissed: true }), false);
});
