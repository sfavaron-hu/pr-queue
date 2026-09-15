# `/where` — ¿en qué entorno está este ticket? · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contestar "¿SQSH-1234 está en dev/stg/prd?" desde la página de pr-queue, recomputando en vivo y mostrando siempre evidencia y nivel de confianza.

**Architecture:** Toda la lógica de veredicto vive en `where.js`, una función pura que recibe payloads crudos de la API y no sabe de dónde salieron — mismo contrato que `classify.js`. `github.js` suma fetchers finos sin lógica. `where-render.js` dibuja. Sin build step, sin cache, sin backend.

**Tech Stack:** JS plano en `<script>` tags (`index.html:963-970`), `node --test` sin deps, GitHub REST v3.

**Spec:** `docs/superpowers/specs/2026-08-25-where-is-ticket-design.md`

## Global Constraints

- **Cero cache.** Cada consulta recomputa. No persistir veredictos en `localStorage`.
- **Una sola credencial:** el PAT `repo` que ya vive en `state.token`. Jira no se llama (sin CORS).
- **Ningún fallo de red se convierte en `NO`.** Un entorno ilegible es `DESCONOCIDO`.
- **Un hit que sólo viene de la clave del padre nunca sube de `NO_RESUELTO`.**
- Alcance: los 6 repos con `branch_model`. `humand-main-api` es `DESCONOCIDO` declarado.
- `humand-mobile` son 6 destinos (`dev|stg|prd` × global|`eu`).
- Sin paths absolutos de home en el código: `tests/shareability.test.js` camina el árbol y falla si aparecen.
- Estilo del repo: `var`/`function`, sin ES modules; export vía bloque `module.exports` al final del archivo, como `classify.js:455`.

---

### Task 1: Modelo de entorno por repo

**Files:**
- Create: `where.js`
- Test: `tests/where-models.test.js`

**Interfaces:**
- Produces: `envModel(repo) -> {kind, dev?, stg?, prd?, regions?, reason?}` con `kind` en `'react'|'fixed'|'tags'|'unknown'`; `envTargets(repo) -> [{env, region, id}]`; `tagMatcher(env, region) -> RegExp`; constante `WHERE_UNKNOWN`.

- [ ] **Step 1: Crear la rama**

```bash
git checkout -b feat/where-is-ticket
```

- [ ] **Step 2: Escribir el test que falla**

```javascript
// tests/where-models.test.js
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
```

- [ ] **Step 3: Correr el test y verificar que falla**

Run: `node --test tests/where-models.test.js`
Expected: FAIL — `Cannot find module '../where.js'`

- [ ] **Step 4: Implementar**

```javascript
// where.js — veredicto de entorno por ticket. Puro: no hace I/O y no sabe
// de donde vinieron los datos, igual que classify.js.

var WHERE_UNKNOWN = 'DESCONOCIDO';

// Medido el 2026-08-25 contra la API con un PAT `repo` sin admin.
// 'react' = la rama de cada entorno vive en una variable de Actions.
// 'tags'  = no hay ramas de entorno; el entorno esta en el nombre del tag.
var ENV_MODELS = {
  'humand-web':        { kind: 'react', dev: 'develop' },
  'humand-backoffice': { kind: 'react', dev: 'develop' },
  'material-hu':       { kind: 'react', dev: 'develop' },
  'hu-translations':   { kind: 'fixed', dev: 'main', stg: 'staging', prd: 'prod' },
  'humand-mobile':     { kind: 'tags', regions: ['', 'eu'] },
  'humand-main-api':   { kind: 'unknown', dev: 'develop',
                         reason: 'sin variables REACT_*; despliega por AWS (AWS_DEV_ACCOUNT/AWS_PFM_ACCOUNT)' },
};

var ENVS = ['dev', 'stg', 'prd'];
var TAG_SEGMENT = { dev: 'dev', stg: 'stg', prd: 'prod' };

function envModel(repo) {
  return ENV_MODELS[repo] || { kind: 'unknown', reason: 'repo sin modelo declarado' };
}

function envTargets(repo) {
  var m = envModel(repo);
  if (m.kind !== 'tags') {
    return ENVS.map(function (e) { return { env: e, region: '', id: e }; });
  }
  var out = [];
  ENVS.forEach(function (e) {
    m.regions.forEach(function (r) {
      out.push({ env: e, region: r, id: r ? e + '-' + r : e });
    });
  });
  return out;
}

// v4.3.4-stg-1 (global) vs v4.3.4-stg-eu-1 (EU). El `\d+$` final es lo que
// impide que el patron global se coma los tags regionales.
function tagMatcher(env, region) {
  var seg = TAG_SEGMENT[env];
  var suffix = region ? seg + '-' + region : seg;
  return new RegExp('^v\\d+\\.\\d+\\.\\d+-' + suffix + '-\\d+$');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WHERE_UNKNOWN: WHERE_UNKNOWN, ENV_MODELS: ENV_MODELS,
                     envModel: envModel, envTargets: envTargets,
                     tagMatcher: tagMatcher };
}
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `node --test tests/where-models.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add where.js tests/where-models.test.js
git commit -m "feat(where): modelo de entorno por repo, medido contra la API"
```

---

### Task 2: Resolver ticket → PRs que aportan

**Files:**
- Modify: `where.js`
- Test: `tests/where-resolve.test.js`

**Interfaces:**
- Consumes: nada de Task 1.
- Produces: `searchQuery(key, org) -> string`; `resolvePRs(pulls, key) -> {contributing, backports, candidates, parentOnly}`. Cada `pull` de entrada tiene la forma `{repo, number, url, title, merged, mergeCommitSha, baseRef, headRef, matchedKey}`.

- [ ] **Step 1: Escribir el test que falla**

```javascript
// tests/where-resolve.test.js
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
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `node --test tests/where-resolve.test.js`
Expected: FAIL — `searchQuery is not a function`

- [ ] **Step 3: Implementar (agregar a `where.js`, antes del bloque `module.exports`)**

```javascript
function searchQuery(key, org) {
  return key + ' org:' + org + ' is:pr';
}

// Solo los PRs mergeados a develop mueven el commit por los entornos. Los
// backport/* existen por el tren y se muestran como evidencia, no como origen.
// Un hit cuyo matchedKey no es la clave consultada vino por la clave del padre,
// que comparten todos los sub-tickets: sirve para mirar, no prueba nada.
function resolvePRs(pulls, key) {
  var own = pulls.filter(function (p) { return p.matchedKey === key; });
  return {
    contributing: own.filter(function (p) {
      return p.merged && p.baseRef === 'develop';
    }),
    backports: own.filter(function (p) {
      return p.merged && /^backport\//.test(p.headRef || '');
    }).concat(pulls.filter(function (p) {
      return p.matchedKey !== key && /^backport\//.test(p.headRef || '');
    })),
    candidates: pulls,
    parentOnly: own.length === 0 && pulls.length > 0,
  };
}
```

Y sumar `searchQuery: searchQuery, resolvePRs: resolvePRs` al `module.exports`.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `node --test tests/where-resolve.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add where.js tests/where-resolve.test.js
git commit -m "feat(where): resolver ticket a PRs, con la regla del padre"
```

---

### Task 3: Veredicto por destino y cruce de prd

**Files:**
- Modify: `where.js`
- Test: `tests/where-verdict.test.js`

**Interfaces:**
- Consumes: `WHERE_UNKNOWN` de Task 1.
- Produces: `targetVerdict(refInfo, compareStatus) -> {value, confidence, ref?, status?, reason?}` con `value` en `'SÍ'|'NO'|'DESCONOCIDO'` y `confidence` en `'PROBADO'|'PARCIAL'|'DESCONOCIDO'`; `prodCross(varBranch, releaseRun) -> {agree, varBranch, tag, runAt, target, note?}`; `reproCommand(org, repo, sha, ref) -> string`.

- [ ] **Step 1: Escribir el test que falla**

```javascript
// tests/where-verdict.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { targetVerdict, prodCross, reproCommand } = require('../where.js');

test('ahead significa que el commit esta contenido', () => {
  const v = targetVerdict({ ref: 'develop' }, 'ahead');
  assert.strictEqual(v.value, 'SÍ');
  assert.strictEqual(v.confidence, 'PROBADO');
  assert.strictEqual(v.ref, 'develop');
});

test('identical tambien cuenta como contenido', () => {
  assert.strictEqual(targetVerdict({ ref: 'develop' }, 'identical').value, 'SÍ');
});

test('behind y diverged son un NO probado', () => {
  assert.strictEqual(targetVerdict({ ref: 'prod' }, 'behind').value, 'NO');
  assert.strictEqual(targetVerdict({ ref: 'prod' }, 'diverged').value, 'NO');
});

test('un ref que no se pudo leer es DESCONOCIDO, nunca NO', () => {
  const v = targetVerdict({ error: '404 variable no existe' }, null);
  assert.strictEqual(v.value, 'DESCONOCIDO');
  assert.strictEqual(v.confidence, 'DESCONOCIDO');
  assert.match(v.reason, /404/);
});

test('un compare que fallo es DESCONOCIDO parcial, nunca NO', () => {
  const v = targetVerdict({ ref: 'develop' }, null);
  assert.strictEqual(v.value, 'DESCONOCIDO');
  assert.strictEqual(v.confidence, 'PARCIAL');
});

test('cuando la variable y el run de release coinciden, prd cierra', () => {
  const c = prodCross('release-2026.08.11',
    { tag: '2026.08.11.03', targetCommitish: 'release-2026.08.11', createdAt: '2026-08-20T15:41:21Z' });
  assert.strictEqual(c.agree, true);
});

test('cuando discrepan no se elige una: se reportan las dos', () => {
  const c = prodCross('release-2026.08.04',
    { tag: '2026.08.11.01', targetCommitish: 'release-2026.08.11', createdAt: '2026-08-11T20:03:00Z' });
  assert.strictEqual(c.agree, false);
  assert.strictEqual(c.varBranch, 'release-2026.08.04');
  assert.strictEqual(c.target, 'release-2026.08.11');
});

test('sin run de release el cruce no afirma nada', () => {
  const c = prodCross('release-2026.08.11', null);
  assert.strictEqual(c.agree, null);
  assert.match(c.note, /event=release/);
});

test('el comando reproducible es pegable tal cual', () => {
  assert.strictEqual(reproCommand('HumandDev', 'humand-web', 'abc123', 'develop'),
    'gh api "repos/HumandDev/humand-web/compare/abc123...develop" --jq .status');
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `node --test tests/where-verdict.test.js`
Expected: FAIL — `targetVerdict is not a function`

- [ ] **Step 3: Implementar (agregar a `where.js`)**

```javascript
var CONTAINED = ['ahead', 'identical'];

// Un fallo de lectura jamas se convierte en "no esta": la diferencia entre
// "medi y no esta" y "no pude medir" es la razon de ser del nivel de confianza.
function targetVerdict(refInfo, compareStatus) {
  if (!refInfo || refInfo.error) {
    return { value: WHERE_UNKNOWN, confidence: WHERE_UNKNOWN,
             reason: (refInfo && refInfo.error) || 'ref no resuelto' };
  }
  if (compareStatus == null) {
    return { value: WHERE_UNKNOWN, confidence: 'PARCIAL', ref: refInfo.ref,
             reason: 'compare fallo' };
  }
  return {
    value: CONTAINED.indexOf(compareStatus) !== -1 ? 'SÍ' : 'NO',
    confidence: 'PROBADO', ref: refInfo.ref, status: compareStatus,
  };
}

// REACT_PRODUCTION_BRANCH dice que rama esta DESIGNADA prod; el ultimo run de CD
// con event=release dice que DESPLEGO. El 2026-08-11 discreparon. Se reportan las
// dos y el veredicto baja a PARCIAL; elegir una es inventar.
function prodCross(varBranch, releaseRun) {
  if (!releaseRun) {
    return { agree: null, varBranch: varBranch,
             note: 'sin run de CD con event=release y conclusion=success' };
  }
  return {
    agree: releaseRun.targetCommitish === varBranch,
    varBranch: varBranch, tag: releaseRun.tag,
    runAt: releaseRun.createdAt, target: releaseRun.targetCommitish,
  };
}

function reproCommand(org, repo, sha, ref) {
  return 'gh api "repos/' + org + '/' + repo + '/compare/' + sha + '...' + ref + '" --jq .status';
}
```

Sumar `targetVerdict`, `prodCross`, `reproCommand` al `module.exports`.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `node --test tests/where-verdict.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add where.js tests/where-verdict.test.js
git commit -m "feat(where): veredicto por destino y cruce de las dos fuentes de prd"
```

---

### Task 4: Componer el reporte y su confianza global

**Files:**
- Modify: `where.js`
- Test: `tests/where-report.test.js`

**Interfaces:**
- Consumes: `envTargets`, `resolvePRs`, `targetVerdict`, `prodCross`, `reproCommand`.
- Produces: `buildWhereReport(input) -> {key, confidence, repos: [{repo, model, rows, prodCross, reason?}], contributing, backports, candidates, parentOnly}`. `input` es `{key, org, pulls, perRepo}` donde `perRepo[repo] = {refs: {<targetId>: {ref}|{error}}, compares: {<targetId>: status|null}, prodVar, releaseRun}`.

- [ ] **Step 1: Escribir el test que falla**

```javascript
// tests/where-report.test.js
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

test('un compare caido deja PARCIAL, no NO', () => {
  const i = input();
  i.perRepo['humand-web'].compares.prd = null;
  const r = buildWhereReport(i);
  assert.strictEqual(r.repos[0].rows[2].value, 'DESCONOCIDO');
  assert.strictEqual(r.confidence, 'PARCIAL');
});

test('mobile devuelve las seis filas', () => {
  const r = buildWhereReport(input({
    pulls: [Object.assign({}, PULL, { repo: 'humand-mobile' })],
    perRepo: { 'humand-mobile': {
      refs: { dev: { ref: 'v4.3.5-dev-1' }, 'dev-eu': { ref: 'v4.3.4-dev-eu-1' },
              stg: { ref: 'v4.3.5-stg-1' }, 'stg-eu': { ref: 'v4.3.4-stg-eu-4' },
              prd: { ref: 'v4.3.4-prod-1' }, 'prd-eu': { ref: 'v4.3.3-prod-eu-1' } },
      compares: { dev: 'ahead', 'dev-eu': 'ahead', stg: 'ahead', 'stg-eu': 'behind',
                  prd: 'behind', 'prd-eu': 'behind' },
    } },
  }));
  assert.deepStrictEqual(r.repos[0].rows.map(x => x.id),
    ['dev', 'dev-eu', 'stg', 'stg-eu', 'prd', 'prd-eu']);
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `node --test tests/where-report.test.js`
Expected: FAIL — `buildWhereReport is not a function`

- [ ] **Step 3: Implementar (agregar a `where.js`)**

```javascript
function buildWhereReport(input) {
  var resolved = resolvePRs(input.pulls || [], input.key);
  var byRepo = {};
  resolved.contributing.forEach(function (p) {
    if (!byRepo[p.repo]) byRepo[p.repo] = p;
  });

  var degraded = false;
  var repos = Object.keys(byRepo).sort().map(function (repo) {
    var pr = byRepo[repo];
    var data = (input.perRepo || {})[repo] || { refs: {}, compares: {} };
    var model = envModel(repo);

    if (model.kind === 'unknown') {
      degraded = true;
      return { repo: repo, model: 'unknown', reason: model.reason, pr: pr, rows: [], prodCross: null };
    }

    var cross = model.kind === 'react'
      ? prodCross(data.prodVar, data.releaseRun)
      : null;
    if (cross && cross.agree === false) degraded = true;

    var rows = envTargets(repo).map(function (t) {
      var v = targetVerdict(data.refs[t.id], data.compares[t.id]);
      if (v.confidence !== 'PROBADO') degraded = true;
      if (cross && cross.agree === false && t.env === 'prd') v.confidence = 'PARCIAL';
      return {
        id: t.id, env: t.env, region: t.region,
        value: v.value, confidence: v.confidence, ref: v.ref,
        status: v.status, reason: v.reason,
        command: v.ref ? reproCommand(input.org, repo, pr.mergeCommitSha, v.ref) : null,
      };
    });

    return { repo: repo, model: model.kind, pr: pr, rows: rows, prodCross: cross };
  });

  var confidence = resolved.contributing.length === 0
    ? 'NO_RESUELTO'
    : (degraded ? 'PARCIAL' : 'PROBADO');

  return {
    key: input.key, confidence: confidence, repos: repos,
    contributing: resolved.contributing, backports: resolved.backports,
    candidates: resolved.candidates, parentOnly: resolved.parentOnly,
  };
}
```

Sumar `buildWhereReport: buildWhereReport` al `module.exports`.

- [ ] **Step 4: Correr toda la suite**

Run: `node --test`
Expected: PASS — los 4 archivos `where-*` nuevos verdes y los 32 preexistentes sin cambios.

- [ ] **Step 5: Commit**

```bash
git add where.js tests/where-report.test.js
git commit -m "feat(where): componer el reporte y su nivel de confianza"
```

---

### Task 5: Fetchers en `github.js`

**Files:**
- Modify: `github.js` (agregar al final, después de `enrichOwnPR`)
- Test: verificación manual contra la API (ver Step 3) — `github.js` no tiene arnés de tests: hace I/O y depende de los globals `API`, `state` y `apiFetch`.

**Interfaces:**
- Consumes: `apiFetch(url)` (`github.js:3`), `API` y `state.token` (`state.js:1`, `state.js:29`), `searchQuery` de Task 2, `tagMatcher` y `envModel` de Task 1.
- Produces: `whereFetchAll(key, parentKey) -> Promise<{key, org, pulls, perRepo}>` — exactamente la forma que consume `buildWhereReport`.

Los fetchers no llevan lógica: toda decisión vive en `where.js`. Lo único que hacen es traducir respuestas de la API a la forma del contrato, y convertir cualquier fallo en `{error}` o `null` en vez de tirar.

- [ ] **Step 1: Implementar**

```javascript
// ── /where: ¿en que entorno esta este ticket? ────────────────────

// Cada fetcher devuelve un error en banda en vez de tirar: un entorno que no
// se pudo leer tiene que llegar a where.js como DESCONOCIDO, no romper la consulta.
async function whereSearchPRs(key) {
  const q = encodeURIComponent(searchQuery(key, state.config.org));
  const data = await apiFetch(`${API}/search/issues?q=${q}&per_page=50`);
  return (data.items || []).map(it => ({
    repoUrl: it.repository_url, pullsUrl: it.pull_request && it.pull_request.url,
    number: it.number, title: it.title, url: it.html_url, matchedKey: key,
  }));
}

async function wherePullDetail(item) {
  const d = await apiFetch(item.pullsUrl);
  return {
    repo: d.base.repo.name, number: d.number, url: d.html_url, title: d.title,
    merged: !!d.merged_at, mergeCommitSha: d.merge_commit_sha,
    baseRef: d.base.ref, headRef: d.head.ref, matchedKey: item.matchedKey,
  };
}

async function whereRepoVariable(repo, name) {
  try {
    const d = await apiFetch(`${API}/repos/${state.config.org}/${repo}/actions/variables/${name}`);
    return { ref: d.value };
  } catch (e) { return { error: String(e.message || e) }; }
}

// Un rate limit no puede degradarse a PARCIAL en silencio: si la API dejo de
// contestar, el reporte entero es sospechoso y tiene que gritar. Cualquier otro
// fallo si es local a este destino.
function whereIsRateLimit(e) {
  return /^GitHub 403/.test(String(e && e.message || e));
}

async function whereCompare(repo, base, head) {
  try {
    const d = await apiFetch(
      `${API}/repos/${state.config.org}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    return d.status;
  } catch (e) {
    if (whereIsRateLimit(e)) throw e;
    return null;
  }
}

async function whereLatestTag(repo, env, region) {
  try {
    const re = tagMatcher(env, region);
    const tags = await apiFetch(`${API}/repos/${state.config.org}/${repo}/tags?per_page=100`);
    const hit = (tags || []).find(t => re.test(t.name));
    return hit ? { ref: hit.name } : { error: `sin tag ${env}${region ? '-' + region : ''}` };
  } catch (e) { return { error: String(e.message || e) }; }
}

async function whereReleaseRun(repo) {
  try {
    const d = await apiFetch(
      `${API}/repos/${state.config.org}/${repo}/actions/runs?event=release&status=success&per_page=1`);
    const run = (d.workflow_runs || [])[0];
    if (!run) return null;
    const rel = await apiFetch(
      `${API}/repos/${state.config.org}/${repo}/releases/tags/${encodeURIComponent(run.head_branch)}`);
    return { tag: run.head_branch, createdAt: run.created_at, targetCommitish: rel.target_commitish };
  } catch (e) {
    if (whereIsRateLimit(e)) throw e;
    return null;
  }
}

async function whereRepoData(repo) {
  const model = envModel(repo);
  if (model.kind === 'unknown') return { refs: {}, compares: {} };

  if (model.kind === 'fixed') {
    return { refs: { dev: { ref: model.dev }, stg: { ref: model.stg }, prd: { ref: model.prd } },
             compares: {} };
  }
  if (model.kind === 'tags') {
    const refs = {};
    for (const t of envTargets(repo)) refs[t.id] = await whereLatestTag(repo, t.env, t.region);
    return { refs, compares: {} };
  }
  const [stg, prd, releaseRun] = await Promise.all([
    whereRepoVariable(repo, 'REACT_STAGING_BRANCH'),
    whereRepoVariable(repo, 'REACT_PRODUCTION_BRANCH'),
    whereReleaseRun(repo),
  ]);
  return { refs: { dev: { ref: model.dev }, stg, prd }, compares: {},
           prodVar: prd.ref, releaseRun };
}

async function whereFetchAll(key, parentKey) {
  let items = await whereSearchPRs(key);
  if (items.length === 0 && parentKey) {
    items = (await whereSearchPRs(parentKey)).map(i => ({ ...i, matchedKey: parentKey }));
  }
  const pulls = [];
  for (const it of items.filter(i => i.pullsUrl)) {
    try { pulls.push(await wherePullDetail(it)); } catch { /* un PR ilegible no invalida el resto */ }
  }

  const repos = [...new Set(pulls.filter(p => p.merged && p.baseRef === 'develop').map(p => p.repo))];
  const perRepo = {};
  for (const repo of repos) {
    const data = await whereRepoData(repo);
    const pr = pulls.find(p => p.repo === repo && p.merged && p.baseRef === 'develop');
    for (const t of envTargets(repo)) {
      const info = data.refs[t.id];
      data.compares[t.id] = info && info.ref
        ? await whereCompare(repo, pr.mergeCommitSha, info.ref)
        : null;
    }
    perRepo[repo] = data;
  }
  return { key, org: state.config.org, pulls, perRepo };
}
```

- [ ] **Step 2: Agregar `where.js` a la página**

En `index.html:966`, después de `<script src="classify.js"></script>`:

```html
<script src="where.js"></script>
```

`where.js` tiene que cargar antes que `github.js` lo use en runtime; como todo se ejecuta detrás de un click, alcanza con que esté en la lista.

- [ ] **Step 3: Verificar contra la API real**

Abrir `index.html` servido (`python3 -m http.server 8123`), pegar el PAT, y en la consola:

```javascript
await whereFetchAll('SQSH-4232', null)
```

Contrastar contra la fuente, en la terminal:

```bash
gh api repos/HumandDev/humand-web/actions/variables/REACT_PRODUCTION_BRANCH --jq .value
gh api repos/HumandDev/humand-web/actions/variables/REACT_STAGING_BRANCH --jq .value
```

Expected: `perRepo['humand-web'].refs.stg.ref` y `.prd.ref` iguales a lo que imprime `gh`; `pulls` con al menos un PR mergeado a `develop`.

- [ ] **Step 4: Correr la suite (regresión)**

Run: `node --test`
Expected: PASS. `tests/shareability.test.js` camina el árbol y ahora incluye `where.js` — si falla ahí es por un path de home, no por el feature.

- [ ] **Step 5: Commit**

```bash
git add github.js index.html
git commit -m "feat(where): fetchers finos contra la API de GitHub"
```

---

### Task 6: UI — buscador, filas y evidencia

**Files:**
- Create: `where-render.js`
- Modify: `index.html` (markup en la `own-column`, `index.html:935-956`; script tag)
- Modify: `app.js` (listener del submit)

**Interfaces:**
- Consumes: `buildWhereReport` (Task 4), `whereFetchAll` (Task 5), `esc` (`render.js:10`), `showError` (`render.js:14`).
- Produces: `renderWhere(report)` que pinta en `#where-result`; `runWhere(key, parentKey)` que orquesta fetch → build → render.

- [ ] **Step 1: Markup — insertar en `index.html` justo después de `<div class="own-column-header">…</div>` (línea 938)**

```html
    <div class="where-box">
      <form id="where-form" autocomplete="off">
        <input type="text" id="where-key" class="input" placeholder="SQSH-1234" />
        <input type="text" id="where-parent" class="input hidden" placeholder="clave del padre" />
        <button type="submit" class="btn btn-primary" id="where-btn">¿Dónde está?</button>
      </form>
      <div id="where-result"></div>
    </div>
```

- [ ] **Step 2: Implementar `where-render.js`**

```javascript
// Dibuja el reporte de /where. Toda la decision ya la tomo where.js: aca no
// hay logica de veredicto, solo presentacion.

var WHERE_ICON = { 'SÍ': '✓', 'NO': '✗', 'DESCONOCIDO': '?' };

function whereRowHTML(row) {
  var detail = row.ref
    ? esc(row.ref) + (row.status ? ' · ' + esc(row.status) : '')
    : esc(row.reason || 'sin ref');
  var cmd = row.command
    ? '<code class="where-cmd" title="click para copiar">' + esc(row.command) + '</code>'
    : '';
  return '<div class="where-row" data-conf="' + esc(row.confidence) + '">'
       +   '<span class="where-env">' + esc(row.id) + '</span>'
       +   '<span class="where-val">' + WHERE_ICON[row.value] + '</span>'
       +   '<span class="where-detail">' + detail + '</span>'
       +   cmd
       + '</div>';
}

function whereRepoHTML(r) {
  if (r.model === 'unknown') {
    return '<div class="where-repo"><b>' + esc(r.repo) + '</b>'
         + '<div class="where-row" data-conf="DESCONOCIDO">'
         + '<span class="where-env">stg / prd</span><span class="where-val">?</span>'
         + '<span class="where-detail">' + esc(r.reason) + '</span></div></div>';
  }
  var cross = '';
  if (r.prodCross && r.prodCross.agree === false) {
    cross = '<div class="where-warn">prd discrepa: la variable dice <b>' + esc(r.prodCross.varBranch)
          + '</b> y el ultimo release (' + esc(r.prodCross.tag) + ', ' + esc(r.prodCross.runAt)
          + ') salio de <b>' + esc(r.prodCross.target) + '</b></div>';
  }
  return '<div class="where-repo"><b>' + esc(r.repo) + '</b> '
       + '<a href="' + esc(r.pr.url) + '" target="_blank" rel="noopener">#' + r.pr.number + '</a> '
       + '<code>' + esc(r.pr.mergeCommitSha.slice(0, 7)) + '</code>'
       + r.rows.map(whereRowHTML).join('') + cross + '</div>';
}

function renderWhere(report) {
  var box = document.getElementById('where-result');
  var head = '<div class="where-head">' + esc(report.key)
           + ' · <span class="where-conf">' + esc(report.confidence) + '</span></div>';

  if (report.confidence === 'NO_RESUELTO') {
    var cands = report.candidates.map(function (c) {
      return '<li><a href="' + esc(c.url) + '" target="_blank" rel="noopener">'
           + esc(c.repo) + ' #' + c.number + '</a> — ' + esc(c.title)
           + (report.parentOnly ? ' <i>(hit por la clave del padre: no prueba nada)</i>' : '') + '</li>';
    }).join('');
    document.getElementById('where-parent').classList.remove('hidden');
    box.innerHTML = head
      + '<div class="where-warn">Sin PR mergeado a develop con esta clave. '
      + 'Si el trabajo vive en un PR titulado con la clave del padre, tipeala arriba.</div>'
      + (cands ? '<ul class="where-cands">' + cands + '</ul>' : '');
    return;
  }

  var backports = report.backports.length
    ? '<div class="where-bp">backports: ' + report.backports.map(function (b) {
        return '<a href="' + esc(b.url) + '" target="_blank" rel="noopener">#' + b.number + '</a>';
      }).join(' ') + '</div>'
    : '';
  box.innerHTML = head + report.repos.map(whereRepoHTML).join('') + backports;
}

async function runWhere(key, parentKey) {
  var box = document.getElementById('where-result');
  box.innerHTML = '<div class="where-head">buscando ' + esc(key) + '…</div>';
  try {
    renderWhere(buildWhereReport(await whereFetchAll(key, parentKey)));
  } catch (e) {
    box.innerHTML = '';
    showError('/where: ' + (e.message || e));
  }
}
```

- [ ] **Step 3: Wiring en `app.js` (agregar al final)**

```javascript
var whereForm = document.getElementById('where-form');
if (whereForm) {
  whereForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var key = document.getElementById('where-key').value.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) {
      showError('/where: "' + key + '" no tiene forma de clave de ticket');
      return;
    }
    runWhere(key, document.getElementById('where-parent').value.trim().toUpperCase() || null);
  });
}
document.addEventListener('click', function (e) {
  if (e.target.classList && e.target.classList.contains('where-cmd')) {
    navigator.clipboard.writeText(e.target.textContent);
  }
});
```

- [ ] **Step 4: Script tag**

En `index.html`, después de `<script src="render.js"></script>` (línea 968):

```html
<script src="where-render.js"></script>
```

- [ ] **Step 5: Verificar en el browser**

`python3 -m http.server 8123`, abrir, pegar el PAT, buscar un ticket propio ya mergeado.

Expected:
- Tres filas para un repo `react`, seis para `humand-mobile`.
- El comando de cada fila, copiado y pegado en la terminal, imprime el mismo `status` que la fila muestra. **Ese es el criterio de aceptación del feature.**
- Una clave inventada (`SQSH-99999`) da `NO_RESUELTO` y revela el campo del padre.
- `humand-main-api`, si aparece, sale con `?` y el motivo — nunca con `NO`.
- Un 403 de rate limit corta la consulta con el mensaje de GitHub en el cartel de error, en vez de dibujar un reporte `PARCIAL` que parece medido. Se prueba pegando un PAT revocado.

- [ ] **Step 6: Correr la suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add where-render.js index.html app.js
git commit -m "feat(where): buscador, filas por entorno y evidencia copiable"
```

---

## Residuales conocidos

- `humand-main-api` stg/prd queda `DESCONOCIDO` por decisión: iterar después leyendo su `cd.yml`.
- Adopción en mobile no se estima: `prd` es "publicado", no "instalado".
- Los estilos (`.where-*`) se agregan al `<style>` de `index.html` siguiendo los tokens ya presentes; no hay CSS separado en este repo.
