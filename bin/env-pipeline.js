#!/usr/bin/env node
// Invierte /where: en vez de preguntar "¿donde esta este ticket?" una vez por
// ticket, pregunta "¿que hay en cada entorno?" una vez por repo. El delta
// entre dos entornos es UNA llamada (`compare/<ref_abajo>...<ref_arriba>`),
// asi que la grilla entera sale en ~3 llamadas por repo mas los PRs nuevos.
//
// Reusa where.js/github.js tal cual: `whereRepoData` ya sabe resolver el ref
// de cada entorno para los cuatro modelos (tags, react, fixed, backend) y esa
// rareza por repo no se puede duplicar aca sin que las dos copias se separen.
// El unico agregado es el delta, que /where no necesitaba.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ORG = 'HumandDev';

global.API = 'https://api.github.com';
global.state = {
  token: execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(),
  config: { org: ORG },
};
for (const f of ['where.js', 'github.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
}

// ── claves de Jira ────────────────────────────────────────────────────────
// El allowlist no es cosmetico: `[A-Z]{2,6}-\d+` a secas pesca `ITMS-90426`
// (codigo de error de Apple) e `IOS-1234` y los publica como si fueran
// tickets. Los 33 keys salen de la API de Jira (project/search), no de la
// intuicion; refrescar ese archivo cuando nazca un squad.
// clave -> nombre legible del squad ("SQSH" -> "Shark"): quien lee el tablero
// no tiene por que saber que SQZB es Zebra.
const PROJECT_NAMES = require(path.join(ROOT, 'data/jira-projects.json'));
const PROJECTS = new Set(Object.keys(PROJECT_NAMES));
const KEY_RE = /\b([A-Za-z]{2,6})-(\d{1,6})\b/g;

function keysIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(KEY_RE)) {
    const k = m[1].toUpperCase();
    if (PROJECTS.has(k)) out.add(k + '-' + m[2]);
  }
  return out;
}

// La clave vive en la rama el 62% de las veces y en el body el 29% (medido
// sobre el delta stg-prd de humand-mobile, 52 PRs). Leer solo la rama pierde
// uno de cada tres tickets, asi que se miran los tres campos en ese orden.
function keyOf(pr) {
  for (const field of ['head', 'title', 'body']) {
    const hit = [...keysIn(pr[field])][0];
    if (hit) return { key: hit, from: field };
  }
  return null;
}

// ── GitHub ────────────────────────────────────────────────────────────────
const enc = encodeURIComponent;

// `compare` pagina de a 250 commits y `total_commits` es el unico contador
// confiable: `commits` viene truncado sin avisar. Un delta de una release
// grande pasa las 250 facil.
async function compareCommits(repo, base, head) {
  const out = [];
  let total = 0;
  for (let page = 1; ; page++) {
    const d = await apiFetch(
      `${API}/repos/${ORG}/${repo}/compare/${enc(base)}...${enc(head)}?per_page=250&page=${page}`);
    total = d.total_commits || 0;
    const batch = d.commits || [];
    out.push(...batch);
    if (!batch.length || out.length >= total) return { total, commits: out, status: d.status };
  }
}

const CACHE = path.join(ROOT, '.cache');
function cacheFile(repo) { return path.join(CACHE, `prs-${repo}.json`); }
function loadCache(repo) {
  try { return JSON.parse(fs.readFileSync(cacheFile(repo), 'utf8')); } catch { return {}; }
}
function saveCache(repo, c) {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cacheFile(repo), JSON.stringify(c, null, 1));
}

// La relacion PR -> clave es inmutable una vez mergeado, asi que se cachea
// para siempre: en regimen solo se pagan los commits nuevos de cada corrida.
async function getPR(repo, n, cache) {
  if (cache[n]) return cache[n];
  const d = await apiFetch(`${API}/repos/${ORG}/${repo}/pulls/${n}`);
  cache[n] = { n: d.number, title: d.title, head: d.head && d.head.ref,
               body: String(d.body || '').slice(0, 4000), url: d.html_url,
               mergedAt: d.merged_at };
  return cache[n];
}

// El subject de un merge commit termina en `(#N)`. Los que no lo tienen son
// bumps de version ("Tech | App version v4.3.5") — no son tickets y no deben
// contarse como PRs perdidos.
const PR_NUM_RE = /\(#(\d+)\)\s*$/;
function prNumbers(commits) {
  const seen = new Set();
  for (const c of commits) {
    const m = PR_NUM_RE.exec(String(c.commit.message).split('\n')[0]);
    if (m) seen.add(Number(m[1]));
  }
  return [...seen];
}

// Un backport no tiene clave propia: el ticket esta en el PR original. Donde
// lo nombra depende del repo, y asumir uno solo pierde el otro entero:
//   · humand-mobile — en el body: "This is an automatic backport of #9052"
//   · humand-web    — en el TITULO: "[Staging Fix] Backport PR #10617 to ..."
// Medido el 28/08: mirando solo el body de ramas `backport/*`, 19 de los 83
// PRs sin clave de humand-web eran backports resolubles.
const BACKPORT_ORIG_RE = /backport\s+(?:pr\s+)?(?:of\s+)?#(\d+)/i;
function backportOrigin(pr) {
  const m = BACKPORT_ORIG_RE.exec(pr.title || '') || BACKPORT_ORIG_RE.exec(pr.body || '');
  return m ? Number(m[1]) : null;
}
// La rama `backport/*` tampoco es senal suficiente: los de humand-web salen de
// ramas con nombre normal y solo el titulo los delata.
function looksBackport(pr) {
  return /^backport\//.test(pr.head || '') || /backport/i.test(pr.title || '');
}
async function resolveTicket(repo, pr, cache) {
  if (looksBackport(pr)) {
    const n = backportOrigin(pr);
    if (!n) return { pr, key: null, reason: 'backport sin PR original identificable' };
    const orig = await getPR(repo, n, cache);
    const k = keyOf(orig);
    return { pr: orig, via: pr.n, key: k && k.key, from: k && k.from,
             reason: k ? null : 'PR original sin clave' };
  }
  const k = keyOf(pr);
  return { pr, key: k && k.key, from: k && k.from, reason: k ? null : 'sin clave en rama/titulo/body' };
}

// ── refs de entorno ───────────────────────────────────────────────────────
function tagTupleOf(name) {
  const m = /^v(\d+)\.(\d+)\.(\d+)-.*-(\d+)$/.exec(name);
  return m ? m.slice(1).map(Number) : null;
}
function cmpTuple(a, b) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// La base comun de la ventana: el ref de prod de `back` releases atras.
//
// `back = 1` (la release anterior) NO sirve, al menos en mobile: medido el
// 28/08, `compare(v4.3.4-prod-1...v4.3.5-prod-1)` da `ahead` con 5 commits y
// los cinco son backports `[v4.3.x]` mas el bump de version. El trabajo del
// ciclo no viaja entre dos tags de prod consecutivos, asi que una ventana de
// 1 deja el bucket Production mostrando hotfixes y nada del release.
//
// Y la ventana NO es solo cosmetica: Staging se calcula restando el conjunto
// de prd, asi que una base angosta deja ese conjunto incompleto y publica como
// "Staging" tickets que hace rato estan en produccion. Medido en mobile el
// 28/08, mismo dia y mismos refs, moviendo solo la base:
//
//   ventana  base             Production  Staging  Development
//   1        v4.3.4-prod-1             3       39           16
//   3        v4.3.3-prod-1            49       26           16
//   6        v4.3.1-prod-1           133       25           16
//
// Staging converge al ensanchar (39 → 26 → 25): las 14 filas que se caen no
// eran de staging, eran de prod mal atribuidas. Development no se mueve porque
// su divergencia con stg no depende de la base. Por eso el default es ancho:
// el costo de mas es una lista de Production mas larga — que en Notion se
// filtra por fecha — y el costo de menos es una columna que miente.
async function prevPrdRef(repo, model, back) {
  if (model.kind === 'tags') {
    const tags = await apiFetch(`${API}/repos/${ORG}/${repo}/tags?per_page=100`);
    const re = tagMatcher('prd', '');
    const hits = tags.map(t => t.name).filter(n => re.test(n))
      .map(n => ({ n, t: tagTupleOf(n) })).filter(x => x.t)
      .sort((a, b) => cmpTuple(b.t, a.t));
    return hits[back] ? hits[back].n : (hits[hits.length - 1] || {}).n || null;
  }
  // Los tags de release del frontend son `YYYY.MM.DD.NN`: la release es el
  // prefijo de fecha y `.NN` es el numero de build. Contar runs hacia atras
  // camina hotfixes de la MISMA release, no releases — medido el 28/08, los
  // 10 runs mas recientes de humand-web eran `2026.08.19.01`..`.10`, o sea
  // una sola. Hay que agrupar por fecha y retroceder por release.
  if (model.kind === 'react') {
    const d = await apiFetch(
      `${API}/repos/${ORG}/${repo}/actions/runs?event=release&status=success&per_page=100`);
    const byDate = new Map();
    for (const r of d.workflow_runs || []) {
      const m = /^(\d{4}\.\d{2}\.\d{2})\.(\d+)$/.exec(r.head_branch || '');
      if (!m) continue;
      const cur = byDate.get(m[1]);
      if (!cur || Number(m[2]) > cur.build) byDate.set(m[1], { ref: r.head_branch, build: Number(m[2]) });
    }
    const dates = [...byDate.keys()].sort().reverse();
    const pick = dates[back] || dates[dates.length - 1];
    return pick ? byDate.get(pick).ref : null;
  }
  return null;   // fixed/backend: no medido en este PoC, no inventado
}

// ── pipeline ──────────────────────────────────────────────────────────────
// Los deltas por pares (prd→stg, stg→dev) NO sirven: dan por supuesto que
// prd ⊆ stg ⊆ dev, y en mobile eso es falso — al 28/08 dev estaba en la linea
// v4.3.5 y stg en la v4.3.6, ramas divergentes. Medido: SQSH-4350 salia a la
// vez en Development y en Production.
//
// Lo que si vale es medir los tres entornos contra UNA base comun (el ref de
// prod anterior) y restar conjuntos. Mismo costo en llamadas, y cada ticket
// cae una sola vez, en el entorno mas lejos que llego:
//   Production  = esta en prd
//   Staging     = esta en stg y no en prd
//   Development = esta en dev y no en stg ni en prd
// Los PRs se piden de a `CONC`: en serie, una ventana de 6 releases de
// humand-web son cientos de GETs uno atras del otro y la corrida no termina.
// El cache los absorbe a partir de la segunda vez, pero la primera tiene que
// poder correr.
const CONC = 8;
async function pool(items, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function ticketsBetween(repo, base, head, cache) {
  const cmp = await compareCommits(repo, base, head);
  const tickets = new Map();
  const orphans = new Map();
  const nums = prNumbers(cmp.commits);
  await pool(nums, n => getPR(repo, n, cache));          // llena el cache en paralelo
  for (const n of nums) {
    const pr = await getPR(repo, n, cache);
    const t = await resolveTicket(repo, pr, cache);
    if (!t.key) { orphans.set(pr.n, { pr: pr.n, title: pr.title, url: pr.url, reason: t.reason }); continue; }
    if (!tickets.has(t.key)) {
      tickets.set(t.key, { key: t.key, title: t.pr.title, pr: t.pr.n, url: t.pr.url,
                           mergedAt: t.pr.mergedAt || null,
                           keyFrom: t.from, backportOf: t.via || null });
    }
  }
  return { commits: cmp.total, status: cmp.status, tickets, orphans };
}

const LADDER = [
  { env: 'Production',  id: 'prd', above: [] },
  { env: 'Staging',     id: 'stg', above: ['prd'] },
  { env: 'Development', id: 'dev', above: ['stg', 'prd'] },
];

async function runRepo(repo, back) {
  const model = envModel(repo);
  const data = await whereRepoData(repo);
  const refOf = id => (data.refs[id] && data.refs[id].ref) || null;
  const cache = loadCache(repo);
  const out = { repo, model: model.kind, refs: {}, buckets: {}, skipped: [] };
  for (const id of ['dev', 'stg', 'prd']) out.refs[id] = refOf(id) || (data.refs[id] || {}).error || null;

  // Sin base comun no hay ventana: "todo lo que esta en prod" seria el repo
  // entero desde siempre. El ref de prod anterior acota a la ultima release.
  const base = await prevPrdRef(repo, model, back);
  if (!base) {
    out.skipped.push(`sin ref de prod anterior para el modelo ${model.kind}: no hay base comun`);
    return out;
  }
  out.refs.base = base;
  out.window = back;

  const sets = {};
  for (const step of LADDER) {
    const head = refOf(step.id);
    if (!head) { out.skipped.push(`${step.env}: sin ref para ${step.id}`); continue; }
    try { sets[step.id] = await ticketsBetween(repo, base, head, cache); }
    catch (e) { out.skipped.push(`${step.env}: compare fallo — ${e.message}`); }
  }
  saveCache(repo, cache);

  for (const step of LADDER) {
    const s = sets[step.id];
    if (!s) continue;
    const seen = new Set();
    for (const id of step.above) if (sets[id]) for (const k of sets[id].tickets.keys()) seen.add(k);
    out.buckets[step.env] = {
      base, head: refOf(step.id), commits: s.commits, compare: s.status,
      tickets: [...s.tickets.values()].filter(t => !seen.has(t.key)),
      orphans: [...s.orphans.values()].filter(o => {
        for (const id of step.above) if (sets[id] && sets[id].orphans.has(o.pr)) return false;
        return true;
      }),
    };
  }
  return out;
}

(async () => {
  const repos = (process.argv[2] || 'humand-web,humand-mobile').split(',');
  const back = Number(process.argv[3] || 6);   // releases de prod hacia atras
  const report = { generatedAt: new Date().toISOString(), org: ORG, window: back, repos: [] };
  for (const r of repos) {
    process.stderr.write(`· ${r}\n`);
    try { report.repos.push(await runRepo(r, back)); }
    catch (e) { report.repos.push({ repo: r, error: String(e.message || e) }); }
  }
  const out = path.join(ROOT, 'pipeline.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  process.stderr.write(`→ ${out}\n`);
})();
