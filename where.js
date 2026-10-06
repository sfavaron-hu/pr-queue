// where.js — veredicto de entorno por ticket. Puro: no hace I/O y no sabe
// de donde vinieron los datos, igual que classify.js.

var WHERE_UNKNOWN = 'DESCONOCIDO';

// Medido el 2026-08-25/26 contra la API con un PAT `repo` sin admin.
// 'react'   = la rama de cada entorno vive en una variable de Actions.
// 'fixed'   = tres ramas fijas conocidas, sin variables ni tags de por medio.
// 'tags'    = no hay ramas de entorno; el entorno esta en el nombre del tag.
// 'backend' = un workflow por entorno, forma propia (ver mas abajo).
// `trunk` es la rama a la que se mergean los PRs que cuentan como origen del
// cambio (resolvePRs la usa) — no siempre coincide con el ref `dev` que se
// mide como destino de despliegue, aunque en la mayoria de estos repos son
// la misma rama.
// material-hu no tiene rama `develop` (verificado: `git/ref/heads/develop`
// 404): sus ramas son main/staging/prod, la misma forma que hu-translations
// — no la familia 'react'. Si carga variables REACT_* (medido: las tiene),
// pero no despliega desde ellas: no hay ningun run de CD con event=release,
// asi que leerlas como si fueran las de humand-web solo produce un prd
// DESCONOCIDO permanente por falta de esa fuente.
var ENV_MODELS = {
  'humand-web':        { kind: 'react', dev: 'develop', trunk: 'develop' },
  'humand-backoffice': { kind: 'react', dev: 'develop', trunk: 'develop' },
  'material-hu':       { kind: 'fixed', dev: 'main', stg: 'staging', prd: 'prod', trunk: 'main' },
  'hu-translations':   { kind: 'fixed', dev: 'main', stg: 'staging', prd: 'prod', trunk: 'main' },
  // dev-eu no se genera: mobile no publico un tag dev-eu desde v4.2.7, fuera
  // de la ventana de 100 tags. stg y prd si tienen variante -eu.
  'humand-mobile':     { kind: 'tags', trunk: 'develop',
                         regions: { dev: [''], stg: ['', 'eu'], prd: ['', 'eu'] } },
  // Un workflow por entorno (`.github/workflows/{dev,stg,prd}.yml`), forma
  // propia de este repo — no copiar el modelo 'react':
  //  · dev: `push` a develop, igual que el frontend.
  //  · stg: SOLO `workflow_dispatch` — no hay rama de destino. El
  //    `head_branch` del run dice desde donde se DISPARO (casi siempre
  //    develop), no que ref tipeo la persona; ese ref sobrevive solo en el
  //    `display_title` del run ("STG deploy - <ref>"), parseado por
  //    parseStgRunName. Como stg es siempre un despliegue manual, PUEDE
  //    MOVERSE PARA ATRAS: es una foto de lo ultimo que alguien tipeo, no un
  //    estado monotono como dev o prd.
  //  · prd: `release: [released]`. Aca si alcanza con `head_branch` del run
  //    — a diferencia de stg, para un evento `release` GitHub lo resuelve al
  //    tag mismo (medido: head_branch == "release-2026.08.20.01").
  'humand-main-api':  { kind: 'backend', dev: 'develop', trunk: 'develop' },
};

var ENVS = ['dev', 'stg', 'prd'];
var TAG_SEGMENT = { dev: 'dev', stg: 'stg', prd: 'prod' };
var BACKPORT_RE = /^backport\//;
var CONTAINED = ['ahead', 'identical'];

function envModel(repo) {
  return ENV_MODELS[repo] || { kind: 'unknown', reason: 'repo sin modelo declarado', trunk: 'develop' };
}

function envTargets(repo) {
  var m = envModel(repo);
  if (m.kind !== 'tags') {
    return ENVS.map(function (e) { return { env: e, region: '', id: e }; });
  }
  var out = [];
  ENVS.forEach(function (e) {
    (m.regions[e] || ['']).forEach(function (r) {
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

// (major, minor, patch, build) — todos numericos, para que "10" no ordene
// antes que "9". Solo se llama sobre nombres que ya matchearon tagMatcher.
var TAG_TUPLE_RE = /^v(\d+)\.(\d+)\.(\d+)-.+-(\d+)$/;
function tagTuple(name) {
  var m = TAG_TUPLE_RE.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : [0, 0, 0, 0];
}

function compareTuples(a, b) {
  for (var i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// GitHub /tags ordena lexicografico descendente, no por version: con un
// contador de build multi-digito eso pone v4.3.4-dev-9 antes que
// v4.3.4-dev-11. "Cual es el tag actual" es un juicio — vive aca, no en
// github.js — y se decide comparando tuplas numericas sobre TODOS los
// matches, nunca tomando el primero de la lista.
function latestTag(tags, env, region) {
  var re = tagMatcher(env, region);
  var best = null;
  var bestTuple = null;
  (tags || []).forEach(function (name) {
    if (!re.test(name)) return;
    var tuple = tagTuple(name);
    if (!best || compareTuples(tuple, bestTuple) > 0) {
      best = name;
      bestTuple = tuple;
    }
  });
  return best;
}

// El ref que alguien tipeo al disparar un stg de main-api solo sobrevive en
// el nombre del run ("STG deploy - release-2026.08.24") — cual medicion es
// la vigente es un juicio, no un fetch, por eso vive aca y no en github.js.
// Runs viejos, de antes de que el workflow tuviera `run-name:`, leen
// "Stg deployment" liso: sin ref que parsear, DESCONOCIDO y nunca una
// adivinanza. Medido: un run real trae doble espacio entre el guion y el
// ref ("STG deploy -  release-2026.08.20") — se tolera, nunca se descarta
// por eso.
var STG_RUN_NAME_RE = /^stg deploy -\s*(\S.*)$/i;
function parseStgRunName(title) {
  var m = STG_RUN_NAME_RE.exec(String(title || '').trim());
  return m ? m[1].trim() : null;
}

function searchQuery(key, org) {
  return key + ' org:' + org + ' is:pr';
}

// Solo los PRs mergeados al tronco del repo mueven el commit por los
// entornos (cada repo declara el suyo en ENV_MODELS: 'develop' para la
// mayoria, 'main' para material-hu y hu-translations). Los backport/*
// existen por el tren y se muestran como evidencia, no como origen. Un hit
// cuyo matchedKey no es la clave consultada vino por la clave del padre,
// que comparten todos los sub-tickets: sirve para mirar, no prueba nada.
function resolvePRs(pulls, key) {
  var own = pulls.filter(function (p) { return p.matchedKey === key; });
  function isTrunk(p) { return p.baseRef === envModel(p.repo).trunk; }
  return {
    contributing: own.filter(function (p) {
      return p.merged && isTrunk(p) && !BACKPORT_RE.test(p.headRef || '');
    }),
    backports: own.filter(function (p) {
      return p.merged && BACKPORT_RE.test(p.headRef || '');
    }).concat(pulls.filter(function (p) {
      return p.merged && p.matchedKey !== key && BACKPORT_RE.test(p.headRef || '');
    })),
    candidates: pulls,
    parentOnly: own.length === 0 && pulls.length > 0,
  };
}

// El representante de cada repo es el primer PR (contributing, ordenado por
// numero antes de llamar) mergeado a su tronco: fila mostrada y estado de
// compare tienen que venir siempre del mismo PR. Compartida por where.js
// (buildWhereReport) y github.js (whereFetchAll) para que no puedan divergir.
function representativeByRepo(pulls, key) {
  var byRepo = {};
  resolvePRs(pulls, key).contributing.forEach(function (p) {
    if (!byRepo[p.repo]) byRepo[p.repo] = p;
  });
  return byRepo;
}

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

// release-YYYY.MM.DD despliega 7 dias despues del corte (medido: el tren
// corre semanal). Esto es una prediccion, no una medicion — el Release
// Manager decide el corte el mismo dia — asi que quien la muestra la rotula
// como estimado, nunca como un hecho.
var RELEASE_BRANCH_RE = /^release-(\d{4})\.(\d{2})\.(\d{2})$/;
function trainDate(branch) {
  var m = RELEASE_BRANCH_RE.exec(branch || '');
  if (!m) return null;
  var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + 7);
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

// prd mide contra el tag desplegado (el head_branch del ultimo run de CD
// event=release exitoso — whereReleaseRun), nunca contra
// REACT_PRODUCTION_BRANCH: esa variable nombra la rama DESIGNADA prod el dia
// que se CORTA, dias antes de que nada despliegue desde ahi (medido
// 2026-08-25: SQSH-4325 comparaba `ahead` contra la rama recien cortada y
// `diverged` contra el tag realmente desplegado — la fila afirmaba prd ✓
// para un commit que no estaba en produccion).
//
// Cuando el tag dice NO, la rama designada se chequea aparte: contenido ahi
// es "mergeado, esperando al tren" — un NO tan medido como cualquier otro,
// no un DESCONOCIDO — y viaja como evidencia (`train`) en la fila. Sin poder
// leer esa rama o su compare no se puede afirmar ninguna de las dos lecturas
// (¿no esta en ningun lado, o esta en el tren?): degrada.
function prdVerdict(tagRef, tagCompareStatus, branch) {
  var v = targetVerdict(tagRef, tagCompareStatus);
  if (v.value !== 'NO' || v.confidence !== 'PROBADO') return v;

  var b = branch || {};
  if (!b.ref) {
    return { value: WHERE_UNKNOWN, confidence: WHERE_UNKNOWN, ref: v.ref, status: v.status,
             reason: 'no esta en el tag desplegado y no se pudo leer REACT_PRODUCTION_BRANCH '
                     + 'para saber si esta en el tren' + (b.error ? ': ' + b.error : '') };
  }
  if (b.compareStatus == null) {
    return { value: WHERE_UNKNOWN, confidence: 'PARCIAL', ref: v.ref, status: v.status,
             reason: 'no esta en el tag desplegado y el compare contra ' + b.ref + ' fallo' };
  }
  if (CONTAINED.indexOf(b.compareStatus) === -1) return v;

  return { value: v.value, confidence: v.confidence, ref: v.ref, status: v.status,
           train: { branch: b.ref, estimate: trainDate(b.ref) } };
}

// REACT_PRODUCTION_BRANCH dice que rama esta DESIGNADA prod; el ultimo run de CD
// con event=release dice que DESPLEGO. El 2026-08-11 discreparon: se publico un
// tag sobre la rama recien cortada. Con prd medido contra el tag directamente
// (prdVerdict) esto ya no afecta la correctitud del veredicto — el tag manda,
// sea cual sea su origen — asi que es nota informativa, nunca degrada.
function prodCross(varBranch, releaseRun) {
  if (!varBranch) {
    return { agree: null, varBranch: varBranch,
             note: 'no se pudo leer REACT_PRODUCTION_BRANCH' };
  }
  if (!releaseRun) {
    return { agree: null, varBranch: varBranch,
             note: 'sin run de CD con event=release y conclusion=success' };
  }
  // El run existe (event=release, conclusion=success): eso ya se establecio.
  // Lo que fallo fue leer el release del tag que ese run produjo — un fallo
  // distinto, que no puede salir con la misma nota o mentiria sobre cual de
  // las dos llamadas fallo.
  if (releaseRun.error) {
    return { agree: null, varBranch: varBranch, tag: releaseRun.tag,
             note: 'hay run de CD (' + releaseRun.tag + ') pero no se pudo leer su release: ' + releaseRun.error };
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

function buildWhereReport(input) {
  var resolved = resolvePRs(input.pulls || [], input.key);
  var byRepo = representativeByRepo(input.pulls || [], input.key);
  var failedPulls = input.failedPulls || 0;

  var degraded = failedPulls > 0;
  var repos = Object.keys(byRepo).sort().map(function (repo) {
    var pr = byRepo[repo];
    var data = (input.perRepo || {})[repo] || { refs: {}, compares: {} };
    var model = envModel(repo);

    if (model.kind === 'unknown') {
      degraded = true;
      return { repo: repo, model: 'unknown', reason: model.reason, pr: pr, rows: [], prodCross: null };
    }

    // Cross es informativo solamente (ver prodCross arriba): no toca `degraded`.
    var cross = model.kind === 'react'
      ? prodCross(data.prodVar && data.prodVar.ref, data.releaseRun)
      : null;

    var rows = envTargets(repo).map(function (t) {
      var v = (model.kind === 'react' && t.id === 'prd')
        ? prdVerdict(data.refs.prd, data.compares.prd, {
            ref: data.prodVar && data.prodVar.ref,
            error: data.prodVar && data.prodVar.error,
            compareStatus: data.branchCompare,
          })
        : targetVerdict(data.refs[t.id], data.compares[t.id]);
      if (v.confidence !== 'PROBADO') degraded = true;
      return {
        id: t.id, env: t.env, region: t.region,
        value: v.value, confidence: v.confidence, ref: v.ref,
        status: v.status, reason: v.reason, train: v.train,
        command: v.ref ? reproCommand(input.org, repo, pr.mergeCommitSha, v.ref) : null,
      };
    });

    return { repo: repo, model: model.kind, pr: pr, rows: rows, prodCross: cross };
  });

  // Un PR ilegible nunca puede terminar en NO_RESUELTO: esa etiqueta dice
  // "sin PR mergeado", una afirmacion que un fetch fallido jamas establecio.
  var confidence = resolved.contributing.length === 0
    ? (failedPulls > 0 ? 'PARCIAL' : 'NO_RESUELTO')
    : (degraded ? 'PARCIAL' : 'PROBADO');

  return {
    key: input.key, confidence: confidence, repos: repos,
    contributing: resolved.contributing, backports: resolved.backports,
    candidates: resolved.candidates, parentOnly: resolved.parentOnly,
    failedPulls: failedPulls,
  };
}

// ── Resumen ELI5 ──────────────────────────────────────────────────────────
// Una linea en castellano llano arriba del reporte: alguien que no sabe que
// es un tag ni que significa `diverged` tiene que poder leer el estado del
// ticket sin bajar a las filas.
//
// No decide nada nuevo: resume las filas que ya dictamino buildWhereReport, y
// por eso no puede afirmar mas que ellas. Dos reglas la mantienen honesta:
//   · un entorno cuenta como alcanzado solo si TODOS sus destinos dicen SI —
//     las dos regiones, en todos los repos. prd ✓ / prd-eu ✗ no es "esta en
//     produccion", es "salio a medias".
//   · un DESCONOCIDO nunca se cuenta como falta ni como llegada: se nombra
//     aparte. "No lo pude medir" y "no esta" son la distincion que sostiene
//     todo el reporte y colapsarlas aca la perderia igual.
var LADDER = ['prd', 'stg', 'dev'];

var REACHED = {
  prd: 'Ya está en producción.',
  stg: 'Está en staging, el entorno donde se prueba antes de salir.',
  dev: 'Está en el entorno de desarrollo.',
};
var PARTIAL_MSG = {
  prd: 'Ya salió a producción, pero no en todos lados.',
  stg: 'Llegó a staging (el entorno de prueba), pero no en todos lados.',
  dev: 'Llegó al entorno de desarrollo, pero no en todos lados.',
};
// Lo que todavia NO alcanzo. Se dice solo cuando esos entornos de arriba se
// midieron: con uno ciego, "todavia no esta en produccion" seria un invento
// del resumen, no una lectura de las filas.
var NOT_YET = {
  stg: ' Todavía no está en producción.',
  dev: ' Todavía no pasó a staging ni a producción.',
};

// Con un solo repo el id del destino ya lo identifica ("prd-eu"); con varios
// hay que decir de cual, o "falta prd" no dice de que repo falta.
function whereTally(report) {
  var by = { dev: [], stg: [], prd: [] }, unknownRepos = [], train = null;
  var multi = report.repos.length > 1;
  report.repos.forEach(function (r) {
    if (r.model === 'unknown') { unknownRepos.push(r.repo); return; }
    r.rows.forEach(function (row) {
      if (!by[row.env]) return;
      if (row.train && !train) train = row.train;
      by[row.env].push({ value: row.value, label: (multi ? r.repo + ' ' : '') + row.id });
    });
  });
  return { by: by, unknownRepos: unknownRepos, train: train };
}

function labels(rows) {
  return rows.map(function (r) { return r.label; }).join(', ');
}
function isNo(r) { return r.value === 'NO'; }
function isBlind(r) { return r.value === WHERE_UNKNOWN; }
function blindNote(rows) {
  return rows.length ? ' No se pudo medir ' + labels(rows) + '.' : '';
}

function whereSummary(report) {
  if (report.repos.length === 0) {
    return report.failedPulls
      ? 'No se sabe dónde está: no se pudieron leer ' + report.failedPulls
        + (report.failedPulls === 1 ? ' PR' : ' PRs') + ' de GitHub.'
      : 'Todavía no hay ningún PR mergeado con esta clave, así que el ticket no está en ningún entorno.';
  }

  var t = whereTally(report);
  var tail = t.unknownRepos.length
    ? ' No se pudo medir ' + t.unknownRepos.join(', ') + '.' : '';

  var all = t.by.dev.concat(t.by.stg, t.by.prd);
  // Sin una sola medicion que haya salido, la unica frase honesta es esa: las
  // ramas de abajo afirmarian donde no esta, y eso no se midio.
  if (!all.length || all.every(isBlind)) {
    return 'El PR está mergeado, pero no se pudo medir ningún entorno.' + tail;
  }

  // De arriba hacia abajo: gana el escalon mas alto que tenga al menos un SÍ.
  // Los destinos ciegos de los escalones ya descartados se arrastran, porque
  // son justamente los que impiden afirmar "todavia no llego mas arriba".
  var blindAbove = [];
  for (var i = 0; i < LADDER.length; i++) {
    var env = LADDER[i], rows = t.by[env];
    if (!rows.length) continue;
    var missing = rows.filter(isNo), blind = rows.filter(isBlind);
    if (missing.length + blind.length === rows.length) {   // ningun SÍ en este escalon
      blindAbove = blindAbove.concat(blind);
      continue;
    }
    var whole = !missing.length && !blind.length;
    return (whole ? REACHED[env] : PARTIAL_MSG[env])
         + (blindAbove.length ? '' : (NOT_YET[env] || ''))
         + (missing.length ? ' Falta ' + labels(missing) + '.' : '')
         + blindNote(blind.concat(blindAbove))
         + tail;
  }

  // Mergeado y en ningun entorno. El tren es la unica prediccion que el
  // reporte ya se permite (rotulada estimado por quien la muestra), asi que
  // es lo unico que se puede agregar sin inventar cuando sale.
  if (t.train) {
    return 'El PR está mergeado y ya subió a ' + t.train.branch + ', la rama que sale a producción'
         + (t.train.estimate ? ': se estima que despliega el ' + t.train.estimate : '') + '.'
         + blindNote(blindAbove) + tail;
  }
  return (blindAbove.length
    ? 'El PR está mergeado, pero no entró en ninguno de los entornos que se pudieron medir.'
    : 'El PR está mergeado, pero todavía no entró en ningún build: no está en desarrollo, ni en staging, ni en producción.')
    + blindNote(blindAbove) + tail;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WHERE_UNKNOWN: WHERE_UNKNOWN, ENV_MODELS: ENV_MODELS,
                     envModel: envModel, envTargets: envTargets,
                     tagMatcher: tagMatcher, latestTag: latestTag,
                     parseStgRunName: parseStgRunName,
                     searchQuery: searchQuery, resolvePRs: resolvePRs,
                     representativeByRepo: representativeByRepo,
                     targetVerdict: targetVerdict, prodCross: prodCross, reproCommand: reproCommand,
                     trainDate: trainDate, prdVerdict: prdVerdict, CONTAINED: CONTAINED,
                     buildWhereReport: buildWhereReport, whereSummary: whereSummary };
}
