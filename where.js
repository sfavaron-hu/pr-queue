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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WHERE_UNKNOWN: WHERE_UNKNOWN, ENV_MODELS: ENV_MODELS,
                     envModel: envModel, envTargets: envTargets,
                     tagMatcher: tagMatcher, searchQuery: searchQuery, resolvePRs: resolvePRs };
}
