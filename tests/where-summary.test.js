const { test } = require('node:test');
const assert = require('node:assert');
const { buildWhereReport, whereSummary } = require('../where.js');

const PULL = { repo: 'humand-web', number: 9884, url: 'https://x/9884', title: 'SQSH-1 x',
               merged: true, mergeCommitSha: 'abc123', baseRef: 'develop',
               headRef: 'feat/SQSH-1-x', matchedKey: 'SQSH-1' };

// Mismo fixture que where-report.test.js: dev/stg contienen el commit, prd no,
// y el tren tampoco (branchCompare diverged). Cada test mueve solo lo suyo.
function input(over) {
  return Object.assign({
    key: 'SQSH-1', org: 'HumandDev', pulls: [PULL],
    perRepo: {
      'humand-web': {
        refs: { dev: { ref: 'develop' }, stg: { ref: 'release-2026.08.19' }, prd: { ref: '2026.08.19.03' } },
        compares: { dev: 'ahead', stg: 'ahead', prd: 'diverged' },
        prodVar: { ref: 'release-2026.08.11' },
        branchCompare: 'diverged',
        releaseRun: { tag: '2026.08.19.03', targetCommitish: 'release-2026.08.19', createdAt: '2026-08-20T15:41:21Z' },
      },
    },
  }, over);
}

function summary(over) { return whereSummary(buildWhereReport(input(over))); }

function web(over) {
  return { perRepo: { 'humand-web': Object.assign({}, input().perRepo['humand-web'], over) } };
}

test('sin PR mergeado dice que no esta en ningun lado, sin jerga', () => {
  assert.strictEqual(whereSummary(buildWhereReport({ key: 'SQSH-1', org: 'HumandDev', pulls: [] })),
    'Todavía no hay ningún PR mergeado con esta clave, así que el ticket no está en ningún entorno.');
});

// "no se pudo leer" jamas puede salir como "no esta": es la distincion que
// sostiene todo el reporte.
test('PRs ilegibles no se convierten en "no esta"', () => {
  const s = whereSummary(buildWhereReport({ key: 'SQSH-1', org: 'HumandDev', pulls: [], failedPulls: 2 }));
  assert.match(s, /No se sabe dónde está/);
  assert.match(s, /2 PRs/);
});

test('en dev y stg pero no en prd nombra staging y aclara que no salio', () => {
  assert.strictEqual(summary(),
    'Está en staging, el entorno donde se prueba antes de salir. Todavía no está en producción.');
});

// El escalon de abajo no puede afirmar por el de arriba: con prd sin medir,
// "todavia no esta en produccion" seria un invento del resumen. Se cae la
// frase negativa y el destino ciego se nombra.
test('con prd sin medir no se afirma que no esta en produccion', () => {
  const s = summary(web({ compares: { dev: 'ahead', stg: 'ahead', prd: null } }));
  assert.strictEqual(s, 'Está en staging, el entorno donde se prueba antes de salir. '
    + 'No se pudo medir prd.');
});

test('contenido en prd es la frase de produccion, sin condiciones', () => {
  assert.strictEqual(summary(web({ compares: { dev: 'ahead', stg: 'ahead', prd: 'ahead' } })),
    'Ya está en producción.');
});

test('mergeado y en ningun entorno lo dice sin prometer cuando sale', () => {
  assert.strictEqual(summary(web({ compares: { dev: 'diverged', stg: 'diverged', prd: 'diverged' } })),
    'El PR está mergeado, pero todavía no entró en ningún build: '
    + 'no está en desarrollo, ni en staging, ni en producción.');
});

test('en el tren agrega la rama y la fecha estimada', () => {
  const s = summary(web({ compares: { dev: 'diverged', stg: 'diverged', prd: 'diverged' },
                          branchCompare: 'ahead' }));
  assert.match(s, /ya subió a release-2026\.08\.11/);
  assert.match(s, /se estima que despliega el 2026-08-18/);
});

// Un solo destino en NO tira abajo el "esta en produccion": el ticket no esta
// para todos hasta que esta en todos. Con region hay que decir cual falta.
const MOBILE_PULL = { repo: 'humand-mobile', number: 9142, url: 'https://x/9142', title: 'SQSH-1 y',
                     merged: true, mergeCommitSha: '7b7e776', baseRef: 'develop',
                     headRef: 'f/SQSH-1', matchedKey: 'SQSH-1' };
const MOBILE_REFS = { dev: { ref: 'v4.3.5-dev-9' }, stg: { ref: 'v4.3.6-stg-2' },
                      'stg-eu': { ref: 'v4.3.5-stg-eu-2' }, prd: { ref: 'v4.3.5-prod-1' },
                      'prd-eu': { ref: 'v4.3.4-prod-eu-2' } };

function mobile(compares) {
  return whereSummary(buildWhereReport({
    key: 'SQSH-1', org: 'HumandDev', pulls: [MOBILE_PULL],
    perRepo: { 'humand-mobile': { refs: MOBILE_REFS, compares: compares } },
  }));
}

test('prd si y prd-eu no sale como salida parcial y nombra el que falta', () => {
  assert.strictEqual(
    mobile({ dev: 'ahead', stg: 'ahead', 'stg-eu': 'ahead', prd: 'ahead', 'prd-eu': 'diverged' }),
    'Ya salió a producción, pero no en todos lados. Falta prd-eu.');
});

// El caso real que abrio esto: SQSH-4303 mergeado hoy, todos los tags cortados
// antes. Cinco `diverged` que en la fila dicen "no incluido" y aca, una frase.
test('mergeado despues del ultimo tag de cada entorno: no esta en ninguno', () => {
  assert.strictEqual(
    mobile({ dev: 'diverged', stg: 'diverged', 'stg-eu': 'diverged',
             prd: 'diverged', 'prd-eu': 'diverged' }),
    'El PR está mergeado, pero todavía no entró en ningún build: '
    + 'no está en desarrollo, ni en staging, ni en producción.');
});

test('un destino no medido se nombra aparte, nunca como "falta"', () => {
  assert.strictEqual(
    mobile({ dev: 'ahead', stg: 'ahead', 'stg-eu': 'ahead', prd: 'diverged', 'prd-eu': null }),
    'Está en staging, el entorno donde se prueba antes de salir. '
    + 'No se pudo medir prd-eu.');
});

test('sin ninguna medicion que haya salido no afirma que no esta', () => {
  const s = summary(web({ refs: {}, compares: {} }));
  assert.strictEqual(s, 'El PR está mergeado, pero no se pudo medir ningún entorno.');
});

test('un repo sin modelo de entornos se nombra en vez de silenciarse', () => {
  const otro = { repo: 'humand-rarito', number: 3, url: 'https://x/3', title: 'SQSH-1 z',
                 merged: true, mergeCommitSha: 'ddd', baseRef: 'develop',
                 headRef: 'f/SQSH-1', matchedKey: 'SQSH-1' };
  const s = whereSummary(buildWhereReport(input({ pulls: [PULL, otro] })));
  assert.match(s, /No se pudo medir humand-rarito\.$/);
});
