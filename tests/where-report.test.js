const { test } = require('node:test');
const assert = require('node:assert');
const { buildWhereReport } = require('../where.js');

const PULL = { repo: 'humand-web', number: 9884, url: 'https://x/9884', title: 'SQSH-1 x',
               merged: true, mergeCommitSha: 'abc123', baseRef: 'develop',
               headRef: 'feat/SQSH-1-x', matchedKey: 'SQSH-1' };

function input(over) {
  return Object.assign({
    key: 'SQSH-1', org: 'HumandDev', pulls: [PULL],
    perRepo: {
      'humand-web': {
        refs: { dev: { ref: 'develop' }, stg: { ref: 'release-2026.08.19' }, prd: { ref: 'release-2026.08.11' } },
        compares: { dev: 'ahead', stg: 'ahead', prd: 'behind' },
        prodVar: 'release-2026.08.11',
        releaseRun: { tag: '2026.08.11.03', targetCommitish: 'release-2026.08.11', createdAt: '2026-08-20T15:41:21Z' },
      },
    },
  }, over);
}

test('un ticket resuelto en un repo sale PROBADO con las tres filas', () => {
  const r = buildWhereReport(input());
  assert.strictEqual(r.confidence, 'PROBADO');
  const rows = r.repos[0].rows;
  assert.deepStrictEqual(rows.map(x => x.id), ['dev', 'stg', 'prd']);
  assert.deepStrictEqual(rows.map(x => x.value), ['SÍ', 'SÍ', 'NO']);
});

test('cada fila trae el comando que la reproduce', () => {
  const r = buildWhereReport(input());
  assert.strictEqual(r.repos[0].rows[0].command,
    'gh api "repos/HumandDev/humand-web/compare/abc123...develop" --jq .status');
});

test('sin PR propio el reporte es NO_RESUELTO aunque haya candidatos del padre', () => {
  const r = buildWhereReport(input({
    pulls: [Object.assign({}, PULL, { matchedKey: 'SQSH-0' })],
  }));
  assert.strictEqual(r.confidence, 'NO_RESUELTO');
  assert.strictEqual(r.parentOnly, true);
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.repos.length, 0);
});

test('si las dos fuentes de prd discrepan, todo el reporte baja a PARCIAL', () => {
  const i = input();
  i.perRepo['humand-web'].releaseRun.targetCommitish = 'release-2026.08.19';
  const r = buildWhereReport(i);
  assert.strictEqual(r.confidence, 'PARCIAL');
  assert.strictEqual(r.repos[0].prodCross.agree, false);
});

test('un repo sin modelo sale DESCONOCIDO con motivo y no rompe el resto', () => {
  const i = input();
  i.pulls = [PULL, Object.assign({}, PULL, { repo: 'humand-main-api', number: 7 })];
  i.perRepo['humand-main-api'] = { refs: { dev: { ref: 'develop' } }, compares: { dev: 'ahead' } };
  const r = buildWhereReport(i);
  const api = r.repos.find(x => x.repo === 'humand-main-api');
  assert.strictEqual(api.model, 'unknown');
  assert.match(api.reason, /AWS/);
  assert.strictEqual(r.confidence, 'PARCIAL');
  assert.strictEqual(r.repos.find(x => x.repo === 'humand-web').rows[0].value, 'SÍ');
});

test('un repo ausente de ENV_MODELS con PR mergeado a develop aporta y sale unknown, no NO_RESUELTO', () => {
  const r = buildWhereReport(input({
    pulls: [Object.assign({}, PULL, { repo: 'humand-infra' })],
    perRepo: {},
  }));
  assert.strictEqual(r.confidence, 'PARCIAL');
  assert.strictEqual(r.repos.length, 1);
  assert.strictEqual(r.repos[0].model, 'unknown');
  assert.strictEqual(r.repos[0].reason, 'repo sin modelo declarado');
});

test('un compare caido deja PARCIAL, no NO', () => {
  const i = input();
  i.perRepo['humand-web'].compares.prd = null;
  const r = buildWhereReport(i);
  assert.strictEqual(r.repos[0].rows[2].value, 'DESCONOCIDO');
  assert.strictEqual(r.confidence, 'PARCIAL');
});

test('mobile devuelve cinco filas, sin dev-eu', () => {
  const r = buildWhereReport(input({
    pulls: [Object.assign({}, PULL, { repo: 'humand-mobile', baseRef: 'develop' })],
    perRepo: { 'humand-mobile': {
      refs: { dev: { ref: 'v4.3.5-dev-1' },
              stg: { ref: 'v4.3.5-stg-1' }, 'stg-eu': { ref: 'v4.3.4-stg-eu-4' },
              prd: { ref: 'v4.3.4-prod-1' }, 'prd-eu': { ref: 'v4.3.3-prod-eu-1' } },
      compares: { dev: 'ahead', stg: 'ahead', 'stg-eu': 'behind',
                  prd: 'behind', 'prd-eu': 'behind' },
    } },
  }));
  assert.deepStrictEqual(r.repos[0].rows.map(x => x.id),
    ['dev', 'stg', 'stg-eu', 'prd', 'prd-eu']);
});

test('ref error + prod disagreement nunca cae a PARCIAL: DESCONOCIDO se mantiene', () => {
  const i = input();
  i.perRepo['humand-web'].refs.prd = { error: '404 variable no existe' };
  i.perRepo['humand-web'].compares.prd = null;
  i.perRepo['humand-web'].releaseRun.targetCommitish = 'release-2026.08.19';
  const r = buildWhereReport(i);
  const prdRow = r.repos[0].rows[2];
  assert.strictEqual(prdRow.value, 'DESCONOCIDO');
  assert.strictEqual(prdRow.confidence, 'DESCONOCIDO');
});

test('prd PROBADO + prod disagreement degrada a PARCIAL', () => {
  const i = input();
  i.perRepo['humand-web'].releaseRun.targetCommitish = 'release-2026.08.19';
  const r = buildWhereReport(i);
  const prdRow = r.repos[0].rows[2];
  assert.strictEqual(prdRow.confidence, 'PARCIAL');
  assert.strictEqual(prdRow.value, 'NO');
});

test('un PR ilegible degrada a PARCIAL aunque el resto salga PROBADO', () => {
  const r = buildWhereReport(input({ failedPulls: 1 }));
  assert.strictEqual(r.confidence, 'PARCIAL');
  assert.strictEqual(r.failedPulls, 1);
});

test('sin failedPulls el reporte no se degrada por eso', () => {
  const r = buildWhereReport(input());
  assert.strictEqual(r.failedPulls, 0);
});

test('todos los PRs ilegibles: PARCIAL, no NO_RESUELTO con una afirmacion falsa', () => {
  const r = buildWhereReport(input({ pulls: [], failedPulls: 3 }));
  assert.strictEqual(r.confidence, 'PARCIAL');
  assert.strictEqual(r.failedPulls, 3);
});
