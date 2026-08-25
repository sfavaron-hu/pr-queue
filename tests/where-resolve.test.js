const { test } = require('node:test');
const assert = require('node:assert');
const { searchQuery, resolvePRs } = require('../where.js');

function pull(over) {
  return Object.assign({
    repo: 'humand-web', number: 1, url: 'https://x/1', title: 'SQSH-1 algo',
    merged: true, mergeCommitSha: 'abc123', baseRef: 'develop',
    headRef: 'feat/SQSH-1-algo', matchedKey: 'SQSH-1',
  }, over);
}

test('la query busca la clave en PRs de la org', () => {
  assert.strictEqual(searchQuery('SQSH-1', 'HumandDev'), 'SQSH-1 org:HumandDev is:pr');
});

test('un PR mergeado a develop aporta', () => {
  const r = resolvePRs([pull()], 'SQSH-1');
  assert.strictEqual(r.contributing.length, 1);
  assert.strictEqual(r.parentOnly, false);
});

test('un PR abierto no aporta', () => {
  const r = resolvePRs([pull({ merged: false })], 'SQSH-1');
  assert.strictEqual(r.contributing.length, 0);
});

test('un PR mergeado a una rama de release no aporta: es consecuencia, no origen', () => {
  const r = resolvePRs([pull({ baseRef: 'release-2026.08.19' })], 'SQSH-1');
  assert.strictEqual(r.contributing.length, 0);
});

test('los backports se listan como evidencia aparte', () => {
  const r = resolvePRs([
    pull(),
    pull({ number: 2, baseRef: 'release-2026.08.19', headRef: 'backport/stg-fix-pr-1-to-release-2026.08.19' }),
  ], 'SQSH-1');
  assert.strictEqual(r.contributing.length, 1);
  assert.strictEqual(r.backports.length, 1);
  assert.strictEqual(r.backports[0].number, 2);
});

test('un hit que solo vino por la clave del padre no aporta y marca parentOnly', () => {
  const r = resolvePRs([pull({ matchedKey: 'SQSH-0' })], 'SQSH-1');
  assert.strictEqual(r.contributing.length, 0);
  assert.strictEqual(r.parentOnly, true);
  assert.strictEqual(r.candidates.length, 1);
});

test('sin ningun hit no es parentOnly: no hay nada que mostrar', () => {
  const r = resolvePRs([], 'SQSH-1');
  assert.strictEqual(r.parentOnly, false);
  assert.strictEqual(r.candidates.length, 0);
});

test('un backport mergeado a develop de clave propia va a backports, no a contributing', () => {
  const r = resolvePRs([pull({ headRef: 'backport/hot-fix-pr-1-to-release-2026.08.19' })], 'SQSH-1');
  assert.strictEqual(r.contributing.length, 0, 'contributing debe estar vacío');
  assert.strictEqual(r.backports.length, 1, 'backports debe tener 1');
  assert.strictEqual(r.backports[0].headRef, 'backport/hot-fix-pr-1-to-release-2026.08.19');
});

test('un backport sin mergear de clave ajena no aparece en backports', () => {
  const r = resolvePRs([
    pull({ merged: false, matchedKey: 'SQSH-0', headRef: 'backport/parent-fix-to-release-2026.08.19' })
  ], 'SQSH-1');
  assert.strictEqual(r.backports.length, 0, 'backports debe estar vacío para unmerged');
});
