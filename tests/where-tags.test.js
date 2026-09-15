// tests/where-tags.test.js — seleccion del tag "actual" por entorno/region.
// GitHub /tags ordena lexicograficamente descendente, y el contador de build
// es multi-digito: v4.3.4-dev-9 ordena antes que v4.3.4-dev-11 en ese orden,
// aunque -11 sea el mas nuevo. latestTag no confia en el orden de la lista:
// compara por tupla numerica (major, minor, patch, build).
const { test } = require('node:test');
const assert = require('node:assert');
const { latestTag } = require('../where.js');

test('el build de dos digitos gana aunque el orden lexicografico lo ponga primero', () => {
  // Orden real devuelto por /tags (lexicografico descendente).
  const names = ['v4.3.4-dev-9', 'v4.3.4-dev-11', 'v4.3.4-dev-10'];
  assert.strictEqual(latestTag(names, 'dev', ''), 'v4.3.4-dev-11');
});

test('el patch de dos digitos tambien se compara numerico, no como texto', () => {
  const names = ['v4.3.9-dev-1', 'v4.3.10-dev-1'];
  assert.strictEqual(latestTag(names, 'dev', ''), 'v4.3.10-dev-1');
});

test('region eu y global no se mezclan', () => {
  const names = ['v4.3.4-stg-1', 'v4.3.4-stg-eu-9', 'v4.3.5-stg-eu-2'];
  assert.strictEqual(latestTag(names, 'stg', ''), 'v4.3.4-stg-1');
  assert.strictEqual(latestTag(names, 'stg', 'eu'), 'v4.3.5-stg-eu-2');
});

test('prd se escribe prod en los tags', () => {
  const names = ['v4.3.4-prod-1', 'v4.3.4-prod-2'];
  assert.strictEqual(latestTag(names, 'prd', ''), 'v4.3.4-prod-2');
});

test('sin ningun match devuelve null', () => {
  assert.strictEqual(latestTag(['v4.3.4-dev-1'], 'prd', ''), null);
  assert.strictEqual(latestTag([], 'dev', ''), null);
});
