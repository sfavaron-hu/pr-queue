// tests/where-backend.test.js — humand-main-api tiene un workflow por
// entorno, con forma distinta a la del frontend: dev es push a develop
// (igual que siempre), prd dispara por `release: [released]` y su
// `head_branch` YA es el tag (no hace falta parsear nada ahi), pero stg es
// workflow_dispatch puro — no hay rama, el ref que alguien tipeo sobrevive
// solo en el nombre del run (`display_title`). Medido en vivo el 26/08/2026
// contra HumandDev/humand-main-api.
const { test } = require('node:test');
const assert = require('node:assert');
const { envModel, envTargets, parseStgRunName, buildWhereReport, WHERE_UNKNOWN } = require('../where.js');

test('main-api ahora tiene modelo backend, no unknown', () => {
  const m = envModel('humand-main-api');
  assert.strictEqual(m.kind, 'backend');
  assert.strictEqual(m.dev, 'develop');
  assert.strictEqual(m.trunk, 'develop');
});

test('main-api genera tres destinos, como los repos sin regiones', () => {
  assert.deepStrictEqual(envTargets('humand-main-api').map(t => t.id), ['dev', 'stg', 'prd']);
});

// El nombre real del run: "STG deploy - release-2026.08.24".
test('parsea el ref del nombre de run de stg', () => {
  assert.strictEqual(parseStgRunName('STG deploy - release-2026.08.24'), 'release-2026.08.24');
});

// Medido: un run real trae doble espacio ("STG deploy -  release-2026.08.20").
test('tolera doble espacio entre el guion y el ref', () => {
  assert.strictEqual(parseStgRunName('STG deploy -  release-2026.08.20'), 'release-2026.08.20');
});

// Formato viejo, antes de que el workflow tuviera `run-name:`.
test('el nombre viejo sin ref no parsea nada', () => {
  assert.strictEqual(parseStgRunName('Stg deployment'), null);
});

test('titulo vacio o ausente tampoco parsea', () => {
  assert.strictEqual(parseStgRunName(''), null);
  assert.strictEqual(parseStgRunName(undefined), null);
  assert.strictEqual(parseStgRunName(null), null);
});

// buildWhereReport con un modelo backend: tres filas reales, no la fila
// "unknown" de un solo renglon.
const PULL = { repo: 'humand-main-api', number: 100, url: 'https://x/100', title: 'SQJG-1 x',
               merged: true, mergeCommitSha: 'deadbeef', baseRef: 'develop',
               headRef: 'feat/SQJG-1-x', matchedKey: 'SQJG-1' };

function input(over) {
  return Object.assign({
    key: 'SQJG-1', org: 'HumandDev', pulls: [PULL],
    perRepo: {
      'humand-main-api': {
        refs: {
          dev: { ref: 'develop' },
          stg: { ref: 'release-2026.08.24' },
          prd: { ref: 'release-2026.08.20.01' },
        },
        compares: { dev: 'ahead', stg: 'ahead', prd: 'diverged' },
      },
    },
  }, over);
}

test('main-api produce tres filas reales, no la fila unknown', () => {
  const r = buildWhereReport(input());
  assert.strictEqual(r.repos.length, 1);
  const repo = r.repos[0];
  assert.strictEqual(repo.model, 'backend');
  assert.deepStrictEqual(repo.rows.map(x => x.id), ['dev', 'stg', 'prd']);
  assert.deepStrictEqual(repo.rows.map(x => x.value), ['SÍ', 'SÍ', 'NO']);
  assert.deepStrictEqual(repo.rows.map(x => x.confidence), ['PROBADO', 'PROBADO', 'PROBADO']);
});

// Un run de stg sin ref parseable (el formato viejo, o ninguno) no puede
// convertirse en un NO: el ref simplemente no se pudo leer. github.js lo
// entrega como { error: '...' } y where.js lo trata igual que cualquier
// otro ref no resuelto.
test('sin ref de stg parseable, esa fila es DESCONOCIDO, nunca NO', () => {
  const i = input();
  i.perRepo['humand-main-api'].refs.stg = { error: 'run de stg sin ref parseable en el nombre' };
  delete i.perRepo['humand-main-api'].compares.stg;
  const r = buildWhereReport(i);
  const stgRow = r.repos[0].rows.find(x => x.id === 'stg');
  assert.strictEqual(stgRow.value, WHERE_UNKNOWN);
  assert.strictEqual(stgRow.confidence, WHERE_UNKNOWN);
});

// El tag de prd conserva su prefijo `release-`, a diferencia del frontend
// (`2026.08.19.05`): no se normaliza ni se recorta, viaja tal cual al
// comando reproducible.
test('el comando de prd usa el tag con el prefijo release- intacto', () => {
  const r = buildWhereReport(input());
  const prdRow = r.repos[0].rows.find(x => x.id === 'prd');
  assert.strictEqual(prdRow.ref, 'release-2026.08.20.01');
  assert.strictEqual(prdRow.command,
    'gh api "repos/HumandDev/humand-main-api/compare/deadbeef...release-2026.08.20.01" --jq .status');
});
