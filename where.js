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
var BACKPORT_RE = /^backport\//;
var CONTAINED = ['ahead', 'identical'];

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
      return p.merged && p.baseRef === 'develop' && !BACKPORT_RE.test(p.headRef || '');
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
      if (cross && cross.agree === false && t.env === 'prd' && v.confidence === 'PROBADO') v.confidence = 'PARCIAL';
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WHERE_UNKNOWN: WHERE_UNKNOWN, ENV_MODELS: ENV_MODELS,
                     envModel: envModel, envTargets: envTargets,
                     tagMatcher: tagMatcher, searchQuery: searchQuery, resolvePRs: resolvePRs,
                     targetVerdict: targetVerdict, prodCross: prodCross, reproCommand: reproCommand,
                     buildWhereReport: buildWhereReport };
}
