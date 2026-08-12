# Panel: las cards de mission-control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** el panel local de pr-queue pinta las cinco fuentes de mission-control, sus leases y sus cuatro estados como cards, sin ganar ninguna superficie de escritura.

**Architecture:** un módulo puro `mission.js` (clasifica la salida de `mc` y construye modelos de card, cargado igual por el browser y por `node --test`), un lector con IO real `bin/mission.js` (exec de `mc`, TTL, single-flight), un endpoint `GET /api/mission` en `serve.js`, y `local.js` cosiendo cards nuevas dentro de la lista que ya renderiza. `collect.js` no se toca.

**Tech Stack:** Node 22, cero dependencias, `node --test`. Browser: JS plano sin build, `<script src>` con globals.

**Spec:** `docs/superpowers/specs/2026-08-12-panel-mission-cards-design.md`

## Global Constraints

- **Cero dependencias.** Ni de runtime ni de test. `node --test` desde la raíz.
- **`mission.js` se carga en los dos runtimes:** `var` en el top level y footer de export dual guardado, exactamente como `classify.js:.. footer` (`if (typeof module !== 'undefined' && module.exports) { module.exports = { ... }; }`). Sin `require` en el top level de `mission.js`.
- **El exit code de `mc` NO es señal de fallo.** `10` = hay preguntas, `4` = degradado, `3` = alguna fuente ciega, `0` = limpio (`mission-control/src/cli.js:86-93`). El criterio de éxito es *¿parseó el JSON?*.
- **`no-check` se normaliza a `broken`** (`mission-control/src/status.js:22`). mc cachea el snapshot 5 min en disco y una caché vieja puede traer ese valor.
- **Ningún home hardcodeado.** `tests/shareability.test.js` falla si aparece `/Users/`. `PRQ_MC_BIN` se deriva de `CLAUDE_CONFIG_DIR` o de `os.homedir()`.
- **Read-only.** Ningún path nuevo escribe fuera de `localStorage`. El panel no pushea, no contesta y no ejecuta.
- **Una fuente que no miró siempre produce card.** Nunca `ok` con 0 items para representar "no pude mirar".
- Worktree `pr-queue--mission-cards`, rama `feat/panel-mission-cards`, dev en `PRQ_PORT=7778` (el sidecar vivo en `:7777` no se toca).

---

### Task 1: `mission.js` — clasificar el read en cuatro estados

**Files:**
- Create: `mission.js`
- Test: `tests/mission-status.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `classifyMissionRead({ missing, configured, code, stdout, stderr, timedOut })` → `{ status: 'ok'|'degraded'|'absent'|'broken'|'off', snapshot: object|null, error: {code, stderr, timedOut}|null }`. `normalizeSourceStatus(s)` → string. `MISSION_STATES` (array congelado).
- `'off'` es el caso del compañero que nunca instaló mc: no configurado y ausente ⇒ el panel no pinta **nada**, ni card de mission (spec §5, fila 1).

- [ ] **Step 1: Write the failing test**

```js
// tests/mission-status.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyMissionRead, normalizeSourceStatus } = require('../mission.js');

const snap = (over) => JSON.stringify(Object.assign({
  at: 1, generatedAt: '2026-08-12T17:00:00.000Z', sources: [], ask: [], deferred: [], take: {},
}, over));

test('exit 10 con JSON válido es ok, no un fallo', () => {
  const r = classifyMissionRead({ configured: true, code: 10, stdout: snap(), stderr: '' });
  assert.equal(r.status, 'ok');
  assert.equal(r.snapshot.generatedAt, '2026-08-12T17:00:00.000Z');
  assert.equal(r.error, null);
});

test('exit 4 con JSON válido es degraded', () => {
  assert.equal(classifyMissionRead({ configured: true, code: 4, stdout: snap() }).status, 'degraded');
});

test('exit 3 con JSON válido sigue siendo ok: el estado ciego vive en las fuentes', () => {
  assert.equal(classifyMissionRead({ configured: true, code: 3, stdout: snap() }).status, 'ok');
});

test('JSON roto es broken y nunca ok con 0 items', () => {
  const r = classifyMissionRead({ configured: true, code: 0, stdout: 'no soy json', stderr: 'boom' });
  assert.equal(r.status, 'broken');
  assert.equal(r.snapshot, null);
  assert.equal(r.error.stderr, 'boom');
});

test('timeout es broken y lo dice', () => {
  const r = classifyMissionRead({ configured: true, code: 1, stdout: '', timedOut: true });
  assert.equal(r.status, 'broken');
  assert.equal(r.error.timedOut, true);
});

test('binario ausente pero configurado a mano es broken', () => {
  assert.equal(classifyMissionRead({ configured: true, missing: true }).status, 'broken');
});

test('binario ausente y sin configurar es off: el panel no pinta nada', () => {
  assert.equal(classifyMissionRead({ configured: false, missing: true }).status, 'off');
});

test('el legacy no-check de una caché vieja se normaliza a broken', () => {
  assert.equal(normalizeSourceStatus('no-check'), 'broken');
  assert.equal(normalizeSourceStatus('ok'), 'ok');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mission-status.test.js`
Expected: FAIL — `Cannot find module '../mission.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// mission.js
// Shared pure logic for the mission-control cards. Loaded both as a browser
// <script src> (globals) and via require() in Node — see the dual-export
// footer, same discipline as classify.js. No dependencies, no IO.

// mc's exit code is a CONTRACT, not a failure signal: 10 = there are
// questions, 4 = degraded, 3 = some source is blind, 0 = clean
// (mission-control/src/cli.js:86-93). Reading "exit != 0" as broken renders a
// pass that merely has questions as a crash, which is the worst possible
// failure mode for a tool whose whole job is telling you what needs a
// decision. Success is "did the JSON parse", full stop.
var MISSION_STATES = Object.freeze(['ok', 'degraded', 'absent', 'broken', 'off']);

// A snapshot cached by an older mc can carry the legacy `no-check`, which mc
// itself folds into `broken` (mission-control/src/status.js:22). Without this
// the value falls through every known branch and no card paints it at all.
function normalizeSourceStatus(status) {
  return status === 'no-check' ? 'broken' : status;
}

function classifyMissionRead(read) {
  var r = read || {};
  if (r.missing) {
    // Not configured and not there = a pr-queue user who never installed
    // mission-control. Explicitly configured and not there = a broken setup.
    return { status: r.configured ? 'broken' : 'off', snapshot: null,
             error: r.configured ? { code: null, stderr: 'no existe el binario de mc', timedOut: false } : null };
  }
  var snapshot = null;
  try { snapshot = JSON.parse(r.stdout || ''); } catch (e) { snapshot = null; }
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.sources)) {
    return { status: 'broken', snapshot: null,
             error: { code: typeof r.code === 'number' ? r.code : null,
                      stderr: (r.stderr || '').split('\n')[0] || '', timedOut: !!r.timedOut } };
  }
  return { status: r.code === 4 ? 'degraded' : 'ok', snapshot: snapshot, error: null };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MISSION_STATES: MISSION_STATES,
                     normalizeSourceStatus: normalizeSourceStatus,
                     classifyMissionRead: classifyMissionRead };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/mission-status.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add mission.js tests/mission-status.test.js
git commit -m "feat(mission): clasificar el read de mc en cuatro estados

El exit code de mc es un contrato (10=preguntas, 4=degradado, 3=ciego), no
una señal de fallo: el criterio de éxito es si el JSON parseó."
```

---

### Task 2: `mission.js` — los modelos de card

**Files:**
- Modify: `mission.js`
- Test: `tests/mission-cards.test.js`

**Interfaces:**
- Consumes: `normalizeSourceStatus` (Task 1).
- Produces: `missionCards(payload)` → array de `card`, donde
  `card = { kind, id, tone: 'red'|'amber'|'gray'|'plain', title, badge: string|null, lines: [string], links: [{label, url}], slot: 'top'|'bottom' }`.
  `kind ∈ {'mission','source','question','ticket','inbox','friction','take'}`. `payload` es la respuesta de `/api/mission` (Task 4).
- `slot` decide el orden final en `local.js` (Task 6): `top` = mission/source en problema, `bottom` = el bloque informativo.

- [ ] **Step 1: Write the failing test**

```js
// tests/mission-cards.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { missionCards } = require('../mission.js');

const base = (over) => Object.assign({
  status: 'ok', mcBin: '/x/mc', generatedAt: '2026-08-12T17:00:00.000Z', ageMs: 180000,
  sources: [], ask: [], deferred: 0, take: {}, leases: { active: [], expired: [], error: null }, error: null,
}, over);

const src = (name, status, over) => Object.assign({ name: name, status: status, headline: name + ' ' + status, detail: [], items: [] }, over);

const kinds = (cards) => cards.map(c => c.kind);
const byKind = (cards, k) => cards.filter(c => c.kind === k);

test('off no pinta ninguna card, ni la de mission', () => {
  assert.deepEqual(missionCards(base({ status: 'off' })), []);
});

test('todo ok pinta sólo la card mission con la edad y el conteo', () => {
  const cards = missionCards(base({ sources: [src('work', 'ok'), src('prs', 'ok')] }));
  assert.deepEqual(kinds(cards), ['mission']);
  assert.equal(cards[0].tone, 'plain');
  assert.match(cards[0].lines.join(' '), /2\/2 fuentes/);
  assert.match(cards[0].badge, /3m/);
});

test('una fuente ok no produce card propia', () => {
  assert.equal(byKind(missionCards(base({ sources: [src('work', 'ok')] })), 'source').length, 0);
});

test('una fuente absent produce card con los tres campos de install', () => {
  const cards = missionCards(base({ sources: [src('tickets', 'absent', {
    install: { what: 'credenciales de Jira', where: '<heartbeat>/local.env', how: 'agregar JIRA_API_TOKEN' } })] }));
  const card = byKind(cards, 'source')[0];
  assert.equal(card.tone, 'gray');
  assert.equal(card.slot, 'top');
  const text = card.lines.join(' | ');
  assert.match(text, /credenciales de Jira/);
  assert.match(text, /local\.env/);
  assert.match(text, /JIRA_API_TOKEN/);
});

test('una fuente broken es roja y trae la primera línea de detalle', () => {
  const card = byKind(missionCards(base({ sources: [src('work', 'broken', { detail: ['ask exit 1 (timeout)', 'otra'] })] })), 'source')[0];
  assert.equal(card.tone, 'red');
  assert.match(card.lines.join(' '), /ask exit 1/);
});

test('el legacy no-check se pinta como broken', () => {
  assert.equal(byKind(missionCards(base({ sources: [src('work', 'no-check')] })), 'source')[0].tone, 'red');
});

test('una fuente degraded produce card ámbar y NO esconde sus items', () => {
  const item = { id: 'prs:x', source: 'prs', priority: 10, item: { type: 'question', question: '¿Qué hago?', header: 'PR', options: [], processKey: null } };
  const cards = missionCards(base({ sources: [src('prs', 'degraded', { items: [item] })], ask: [item] }));
  assert.equal(byKind(cards, 'source')[0].tone, 'amber');
  assert.equal(byKind(cards, 'question').length, 1);
});

test('mission roja cuando el read entero está broken, con el error', () => {
  const cards = missionCards(base({ status: 'broken', error: { code: 1, stderr: 'boom', timedOut: false } }));
  assert.deepEqual(kinds(cards), ['mission']);
  assert.equal(cards[0].tone, 'red');
  assert.match(cards[0].lines.join(' '), /boom/);
});

test('leases ilegibles ponen la card mission en ámbar y lo nombran', () => {
  const cards = missionCards(base({ leases: { active: [], expired: [], error: 'exit 3' } }));
  assert.equal(cards[0].tone, 'amber');
  assert.match(cards[0].lines.join(' '), /leases/);
});

test('58 tickets producen una card por cola, no 58', () => {
  const rows = [];
  for (let i = 0; i < 58; i++) rows.push({ key: 'SQSH-' + (4000 + i), summary: 's' + i, status: 'To Do', url: 'https://x/SQSH-' + (4000 + i), queue: 'shark-frontend' });
  const cards = byKind(missionCards(base({ sources: [src('tickets', 'ok', {
    queues: [{ name: 'shark-frontend', label: 'Shark frontend sin dueño' }], rows: rows })] })), 'ticket');
  assert.equal(cards.length, 1);
  assert.match(cards[0].title, /Shark frontend sin dueño/);
  assert.match(cards[0].badge, /58/);
  assert.equal(cards[0].lines.length, 58);
  assert.equal(cards[0].slot, 'bottom');
});

test('el inbox es una card agregada, no una por nota', () => {
  const cards = byKind(missionCards(base({ sources: [src('heartbeat', 'ok', {
    inbox: [{ source: 'work' }, { source: 'work' }, { source: 'prs' }], attention: [] })] })), 'inbox');
  assert.equal(cards.length, 1);
  assert.match(cards[0].badge, /3/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mission-cards.test.js`
Expected: FAIL — `missionCards is not a function`

- [ ] **Step 3: Write minimal implementation**

Agregar a `mission.js`, antes del footer de export, y sumar `missionCards` al `module.exports`:

```js
function ageLabel(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return 'edad desconocida';
  var m = Math.round(ms / 60000);
  return m < 1 ? 'hace <1m' : (m < 90 ? 'hace ' + m + 'm' : 'hace ' + Math.round(m / 60) + 'h');
}

var SOURCE_TONE = { absent: 'gray', broken: 'red', degraded: 'amber' };

function missionCard(payload, sources) {
  var looked = sources.filter(function (s) { return ['absent', 'broken'].indexOf(normalizeSourceStatus(s.status)) === -1; });
  var lines = [];
  var tone = 'plain';
  if (payload.status === 'broken' || payload.status === 'degraded') {
    tone = payload.status === 'broken' ? 'red' : 'amber';
    var e = payload.error || {};
    lines.push(e.timedOut ? 'mc no respondió en el tiempo del panel'
                          : ('no pude leer mc' + (e.stderr ? ': ' + e.stderr : '')));
    lines.push('lo que ves abajo es de la última lectura buena, si hubo alguna');
  } else {
    lines.push(looked.length + '/' + sources.length + ' fuentes miraron');
  }
  // A lease that cannot be read is the exact condition under which the drain
  // walks over a working agent, so it can never be a silent omission.
  if (payload.leases && payload.leases.error) {
    if (tone === 'plain') tone = 'amber';
    lines.push('no pude leer los leases (' + payload.leases.error + '): una card puede ofrecer algo que un agente está usando');
  }
  return { kind: 'mission', id: 'mission', tone: tone, title: 'mission-control',
           badge: ageLabel(payload.ageMs), lines: lines, links: [], slot: 'top' };
}

function questionCard(entry) {
  var q = entry.item || {};
  return { kind: 'question', id: 'q:' + entry.id, tone: 'amber',
           title: q.header || 'Pregunta', badge: entry.source || null,
           lines: [q.question || ''].concat((q.options || []).map(function (o) {
             return '· ' + o.label + ' — ' + (o.description || '');
           })).concat(['contestar: /mission-control']),
           links: [], slot: 'bottom' };
}

function missionCards(payload) {
  if (!payload || payload.status === 'off') return [];
  var sources = payload.sources || [];
  var cards = [missionCard(payload, sources)];

  sources.forEach(function (s) {
    var st = normalizeSourceStatus(s.status);
    if (st === 'ok') return;
    var lines = [s.headline || ''].concat((s.detail || []).slice(0, 3));
    if (s.install) {
      lines.push('qué es: ' + s.install.what);
      if (s.install.where) lines.push('dónde: ' + s.install.where);
      lines.push('cómo: ' + s.install.how);
    }
    cards.push({ kind: 'source', id: 'source:' + s.name, tone: SOURCE_TONE[st] || 'red',
                 title: s.name, badge: st, lines: lines, links: [], slot: 'top' });
  });

  // Questions with no process of their own. The ones that DO match a process
  // are stitched into its card by Task 3 and must not be duplicated here —
  // local.js passes the already-matched ids in `payload.matchedAskIds`.
  var matched = payload.matchedAskIds || [];
  (payload.ask || []).forEach(function (entry) {
    if (matched.indexOf(entry.id) !== -1) return;
    cards.push(questionCard(entry));
  });

  sources.forEach(function (s) {
    var st = normalizeSourceStatus(s.status);
    if (s.name === 'tickets' && Array.isArray(s.rows)) {
      var queues = s.queues && s.queues.length ? s.queues : [{ name: null, label: 'tickets' }];
      queues.forEach(function (q) {
        var rows = s.rows.filter(function (r) { return q.name === null || r.queue === q.name; });
        if (!rows.length) return;
        cards.push({ kind: 'ticket', id: 'tickets:' + (q.name || 'all'), tone: 'plain',
                     title: q.label, badge: String(rows.length), slot: 'bottom',
                     lines: rows.map(function (r) { return r.key + ' · ' + (r.status || '') + ' · ' + (r.summary || ''); }),
                     links: rows.filter(function (r) { return r.url; }).map(function (r) { return { label: r.key, url: r.url }; }) });
      });
    }
    if (s.name === 'heartbeat') {
      var notes = (s.inbox || []).concat(s.attention || []);
      if (notes.length) {
        var per = {};
        notes.forEach(function (n) { var k = n.source || n.check || 'otros'; per[k] = (per[k] || 0) + 1; });
        cards.push({ kind: 'inbox', id: 'inbox', tone: 'plain', title: 'inbox', badge: String(notes.length),
                     lines: Object.keys(per).map(function (k) { return k + ' ×' + per[k]; })
                              .concat(['leer y marcar: mc inbox / mc ack']),
                     links: [], slot: 'bottom' });
      }
    }
    if (s.name === 'friction' && (s.open || []).length) {
      cards.push({ kind: 'friction', id: 'friction', tone: 'plain', title: 'fricción abierta',
                   badge: String(s.open.length), slot: 'bottom', links: [],
                   lines: s.open.map(function (o) { return (o.note || o.evidence || '').slice(0, 140); }) });
    }
  });

  var take = payload.take || {};
  var taken = (take.rows || take.taken || []);
  if (taken.length) {
    cards.push({ kind: 'take', id: 'take', tone: 'plain', title: 'tickets tomados',
                 badge: String(taken.length), slot: 'bottom', links: [],
                 lines: taken.map(function (t) { return (t.key || '?') + ' · ' + (t.state || '') + (t.until ? ' hasta ' + t.until : ''); }) });
  }
  return cards;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/mission-cards.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add mission.js tests/mission-cards.test.js
git commit -m "feat(mission): modelos de card para las cinco fuentes

Una card por cola de tickets (no una por ticket) y una card agregada de
inbox: 60 cards enterrarían los 27 procesos que son el cuerpo del panel."
```

---

### Task 3: `mission.js` — el cosido a los procesos

**Files:**
- Modify: `mission.js`
- Test: `tests/mission-stitch.test.js`

**Interfaces:**
- Consumes: nada de Tasks 1–2.
- Produces: `stitchMission(payload, rows)` → `{ perKey: { [processKey]: { questions: [entry], lease: leaseRec|null } }, matchedAskIds: [string] }`.
  `rows` son las filas del panel: `{ proc: { key, worktrees: [{ path, branch }] } }`.
  `leaseRec` = `{ path, branch, forWhat, minutesLeft }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/mission-stitch.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { stitchMission } = require('../mission.js');

const row = (key, worktrees) => ({ proc: { key: key, worktrees: worktrees || [] } });
const ask = (id, processKey) => ({ id: id, source: 'work', priority: 20,
  item: { type: 'question', key: 'dirty:' + processKey, processKey: processKey, question: '¿Qué hago?', header: 'Sin commit', options: [] } });

test('una pregunta se cose al proceso cuyo key matchea', () => {
  const out = stitchMission({ ask: [ask('a1', 'SQSH-4167')], leases: { active: [] } }, [row('SQSH-4167')]);
  assert.equal(out.perKey['SQSH-4167'].questions.length, 1);
  assert.deepEqual(out.matchedAskIds, ['a1']);
});

test('una pregunta con processKey desconocido no se cose y no se pierde', () => {
  const out = stitchMission({ ask: [ask('a1', 'SQSH-9999')], leases: { active: [] } }, [row('SQSH-4167')]);
  assert.equal(Object.keys(out.perKey).length, 0);
  assert.deepEqual(out.matchedAskIds, []);   // Task 2 le da card propia
});

test('un lease matchea por path', () => {
  const out = stitchMission({ ask: [], leases: { active: [{ path: '/w/a', branch: null, forWhat: 'e2e', minutesLeft: 32 }] } },
                            [row('SQSH-4167', [{ path: '/w/a', branch: 'feat/x' }])]);
  assert.equal(out.perKey['SQSH-4167'].lease.minutesLeft, 32);
});

test('un lease matchea por branch cuando el path no coincide', () => {
  const out = stitchMission({ ask: [], leases: { active: [{ path: '/otro', branch: 'feat/x', forWhat: 'e2e', minutesLeft: 5 }] } },
                            [row('SQSH-4167', [{ path: '/w/a', branch: 'feat/x' }])]);
  assert.equal(out.perKey['SQSH-4167'].lease.forWhat, 'e2e');
});

test('un lease vencido no cose nada', () => {
  const out = stitchMission({ ask: [], leases: { active: [], expired: [{ path: '/w/a', branch: 'feat/x' }] } },
                            [row('SQSH-4167', [{ path: '/w/a', branch: 'feat/x' }])]);
  assert.equal(out.perKey['SQSH-4167'], undefined);
});

test('sin payload no explota', () => {
  assert.deepEqual(stitchMission(null, [row('X')]), { perKey: {}, matchedAskIds: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mission-stitch.test.js`
Expected: FAIL — `stitchMission is not a function`

- [ ] **Step 3: Write minimal implementation**

Agregar a `mission.js` y al `module.exports`:

```js
// Matches by path AND by branch, the same way mc does (src/lease.js:88):
// the drain's own questions carry no path field, so a branch-only match is
// the only thing that connects a lease to half of them.
function leaseForRow(active, row) {
  var wts = (row.proc && row.proc.worktrees) || [];
  for (var i = 0; i < active.length; i++) {
    var l = active[i];
    for (var j = 0; j < wts.length; j++) {
      if (l.path && wts[j].path && l.path === wts[j].path) return l;
      if (l.branch && wts[j].branch && l.branch === wts[j].branch) return l;
    }
  }
  return null;
}

function stitchMission(payload, rows) {
  var out = { perKey: {}, matchedAskIds: [] };
  if (!payload) return out;
  var active = (payload.leases && payload.leases.active) || [];
  var keys = {};
  (rows || []).forEach(function (r) { if (r.proc && r.proc.key) keys[r.proc.key] = r; });

  (payload.ask || []).forEach(function (entry) {
    var pk = entry.item && entry.item.processKey;
    if (!pk || !keys[pk]) return;
    out.perKey[pk] = out.perKey[pk] || { questions: [], lease: null };
    out.perKey[pk].questions.push(entry);
    out.matchedAskIds.push(entry.id);
  });

  Object.keys(keys).forEach(function (k) {
    var lease = leaseForRow(active, keys[k]);
    if (!lease) return;
    out.perKey[k] = out.perKey[k] || { questions: [], lease: null };
    out.perKey[k].lease = lease;
  });
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/mission-stitch.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add mission.js tests/mission-stitch.test.js
git commit -m "feat(mission): cosido de preguntas y leases a los procesos

El lease matchea por path y por branch porque las preguntas del drenaje no
traen path; una pregunta sin proceso no se cose y se va a card propia."
```

---

### Task 4: `bin/mission.js` — exec real, TTL y single-flight

**Files:**
- Create: `bin/mission.js`
- Test: `tests/bin-mission.test.js`

**Interfaces:**
- Consumes: `classifyMissionRead` (Task 1).
- Produces: `resolveMcBin(env, homeDir)` → `{ bin, configured }`. `makeMissionReader({ exec, exists, env, homeDir, now, ttlMs })` → `async read({ fresh })` → el payload de `/api/mission` (forma en el spec §2). `exec(argv, {timeoutMs})` → `Promise<{code, stdout, stderr, timedOut}>` que **nunca** rechaza. `realExec` es la implementación con `execFile`.

- [ ] **Step 1: Write the failing test**

```js
// tests/bin-mission.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveMcBin, makeMissionReader } = require('../bin/mission.js');

const SNAP = JSON.stringify({ at: 1, generatedAt: '2026-08-12T17:00:00.000Z', sources: [{ name: 'work', status: 'ok', items: [] }], ask: [], deferred: [], take: {} });
const LEASES = JSON.stringify({ active: [{ path: '/w/a', branch: null, forWhat: 'e2e', minutesLeft: 30 }], expired: [] });

function fakeExec(handler) {
  const calls = [];
  const exec = async (argv, opts) => { calls.push(argv); return handler(argv, opts); };
  exec.calls = calls;
  return exec;
}
const okHandler = (argv) => argv.indexOf('lease') !== -1
  ? { code: 0, stdout: LEASES, stderr: '', timedOut: false }
  : { code: 10, stdout: SNAP, stderr: '', timedOut: false };

test('el default de PRQ_MC_BIN se deriva de CLAUDE_CONFIG_DIR', () => {
  const r = resolveMcBin({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/x');
  assert.equal(r.bin, '/cfg/mission-control/bin/mc');
  assert.equal(r.configured, false);
});

test('sin CLAUDE_CONFIG_DIR cae al homedir, nunca a un path hardcodeado', () => {
  assert.equal(resolveMcBin({}, '/home/x').bin, '/home/x/.claude/mission-control/bin/mc');
});

test('PRQ_MC_BIN explícito marca configured', () => {
  const r = resolveMcBin({ PRQ_MC_BIN: '/opt/mc' }, '/home/x');
  assert.equal(r.bin, '/opt/mc');
  assert.equal(r.configured, true);
});

test('lee status y leases y devuelve el payload con la edad', async () => {
  const exec = fakeExec(okHandler);
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' },
    homeDir: '/home/x', now: () => Date.parse('2026-08-12T17:03:00.000Z') });
  const p = await read({});
  assert.equal(p.status, 'ok');
  assert.equal(p.ageMs, 180000);
  assert.equal(p.leases.active[0].forWhat, 'e2e');
  assert.equal(p.sources.length, 1);
  assert.equal(exec.calls.length, 2);
});

test('single-flight: dos lecturas concurrentes disparan un solo par de execs', async () => {
  const exec = fakeExec(okHandler);
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' }, homeDir: '/h', now: () => 0 });
  await Promise.all([read({}), read({}), read({})]);
  assert.equal(exec.calls.length, 2);
});

test('el TTL evita el segundo exec y vencido lo permite', async () => {
  const exec = fakeExec(okHandler);
  let clock = 0;
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' }, homeDir: '/h', now: () => clock, ttlMs: 60000 });
  await read({});
  clock = 30000; await read({});
  assert.equal(exec.calls.length, 2);
  clock = 90000; await read({});
  assert.equal(exec.calls.length, 4);
});

test('fresh pasa --fresh a mc y saltea el TTL', async () => {
  const exec = fakeExec(okHandler);
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' }, homeDir: '/h', now: () => 0 });
  await read({});
  await read({ fresh: true });
  assert.ok(exec.calls.some(a => a.indexOf('--fresh') !== -1));
});

test('mc ausente y sin configurar es off', async () => {
  const read = makeMissionReader({ exec: fakeExec(okHandler), exists: () => false, env: {}, homeDir: '/h', now: () => 0 });
  assert.equal((await read({})).status, 'off');
});

test('status roto es broken y leases no lo tapa', async () => {
  const exec = fakeExec((argv) => argv.indexOf('lease') !== -1
    ? { code: 0, stdout: LEASES, stderr: '', timedOut: false }
    : { code: 1, stdout: 'basura', stderr: 'boom', timedOut: false });
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' }, homeDir: '/h', now: () => 0 });
  const p = await read({});
  assert.equal(p.status, 'broken');
  assert.deepEqual(p.sources, []);
  assert.equal(p.error.stderr, 'boom');
});

test('status ok con leases roto conserva el status y reporta el error de leases', async () => {
  const exec = fakeExec((argv) => argv.indexOf('lease') !== -1
    ? { code: 3, stdout: '{{', stderr: 'lease boom', timedOut: false }
    : { code: 0, stdout: SNAP, stderr: '', timedOut: false });
  const read = makeMissionReader({ exec, exists: () => true, env: { PRQ_MC_BIN: '/opt/mc' }, homeDir: '/h', now: () => 0 });
  const p = await read({});
  assert.equal(p.status, 'ok');
  assert.deepEqual(p.leases.active, []);
  assert.match(p.leases.error, /lease boom|exit 3/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bin-mission.test.js`
Expected: FAIL — `Cannot find module '../bin/mission.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// bin/mission.js
// Real IO for /api/mission: exec of the `mc` CLI, TTL and single-flight.
// Mirrors the collect.js / bin/collect.js split — the pure half lives in
// ../mission.js and is the only part the browser loads.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { classifyMissionRead } = require('../mission.js');

const DEFAULT_TTL_MS = 60000;
const EXEC_TIMEOUT_MS = 20000;

// bin/collect.js's `run` rejects on a non-zero exit, which is exactly wrong
// here: mc exits 10 when there are questions and 3 when a source is blind,
// and both are successful reads. This resolves always and hands the code to
// the classifier as data.
function realExec(argv, opts) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1),
      { maxBuffer: 8 * 1024 * 1024, timeout: (opts && opts.timeoutMs) || EXEC_TIMEOUT_MS },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
                  stdout: stdout || '', stderr: stderr || '',
                  timedOut: !!(err && err.killed) });
      });
  });
}

// No hardcoded home anywhere: shareability.test.js fails the build over it,
// and this file has to work on a machine that is not the author's.
function resolveMcBin(env, homeDir) {
  if (env && env.PRQ_MC_BIN) return { bin: env.PRQ_MC_BIN, configured: true };
  const root = (env && env.CLAUDE_CONFIG_DIR) || path.join(homeDir || os.homedir(), '.claude');
  return { bin: path.join(root, 'mission-control', 'bin', 'mc'), configured: false };
}

function makeMissionReader(opts) {
  const exec = opts.exec || realExec;
  const exists = opts.exists || ((p) => fs.existsSync(p));
  const now = opts.now || Date.now;
  const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : DEFAULT_TTL_MS;
  const env = opts.env || process.env;
  const homeDir = opts.homeDir || os.homedir();

  let cached = null;
  let cachedAt = -Infinity;
  let inFlight = null;

  async function build(fresh) {
    const { bin, configured } = resolveMcBin(env, homeDir);
    if (!exists(bin)) {
      const read = classifyMissionRead({ missing: true, configured });
      return payloadFrom(read, bin, null);
    }
    const statusArgv = fresh ? [bin, 'status', '--fresh'] : [bin, 'status'];
    const [st, ls] = await Promise.all([
      exec(statusArgv, { timeoutMs: EXEC_TIMEOUT_MS }),
      exec([bin, 'lease'], { timeoutMs: EXEC_TIMEOUT_MS }),
    ]);
    const read = classifyMissionRead(Object.assign({ configured: true }, st));
    return payloadFrom(read, bin, ls);
  }

  function payloadFrom(read, bin, leaseRes) {
    const snap = read.snapshot;
    let leases = { active: [], expired: [], error: null };
    if (leaseRes) {
      try {
        const parsed = JSON.parse(leaseRes.stdout || '');
        leases.active = parsed.active || [];
        leases.expired = parsed.expired || [];
      } catch (e) {
        leases.error = (leaseRes.stderr || '').split('\n')[0] || ('exit ' + leaseRes.code);
      }
    }
    const generatedAt = snap ? snap.generatedAt : null;
    return {
      status: read.status,
      mcBin: bin,
      generatedAt: generatedAt,
      ageMs: generatedAt ? Math.max(0, now() - Date.parse(generatedAt)) : null,
      sources: snap ? snap.sources : [],
      ask: snap ? (snap.ask || []) : [],
      deferred: snap ? (snap.deferred || []).length || 0 : 0,
      take: snap ? (snap.take || {}) : {},
      leases: leases,
      error: read.error,
    };
  }

  return async function read(args) {
    const fresh = !!(args && args.fresh);
    if (!fresh && cached && (now() - cachedAt) < ttlMs) return cached;
    // Single-flight: the panel polls, and two overlapping polls must never
    // become two `mc status` passes — each one costs gh round-trips.
    if (inFlight) return inFlight;
    inFlight = build(fresh)
      .then((p) => { cached = p; cachedAt = now(); return p; })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}

module.exports = { resolveMcBin, makeMissionReader, realExec, DEFAULT_TTL_MS, EXEC_TIMEOUT_MS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/bin-mission.test.js`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add bin/mission.js tests/bin-mission.test.js
git commit -m "feat(mission): lector con exec real, TTL y single-flight

El exec resuelve siempre: bin/collect.js rechaza en exit != 0 y mc sale 10
cuando hay preguntas, así que reusarlo convertía un pase sano en un fallo."
```

---

### Task 5: `serve.js` — el endpoint `/api/mission`

**Files:**
- Modify: `serve.js:36-63` (agregar la rama del endpoint en `handle`) y `serve.js:86-88` (`createServer` acepta `missionFn`)
- Test: `tests/serve-mission.test.js`

**Interfaces:**
- Consumes: `makeMissionReader` (Task 4).
- Produces: `GET /api/mission` → 200 con el payload; `?fresh=1` fuerza. `createServer({ missionFn })` para inyectar en tests. Un fallo del lector devuelve **200** con `status:'broken'`, nunca 500: el estado es parte del contrato, no un error de transporte.

- [ ] **Step 1: Write the failing test**

```js
// tests/serve-mission.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../serve.js');

function listen(server) {
  return new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}
function closeServer(server) { return new Promise(res => server.close(res)); }

test('/api/mission devuelve el payload del lector', async () => {
  const server = createServer({ missionFn: async () => ({ status: 'ok', sources: [], ask: [] }) });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/mission`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await res.json()).status, 'ok');
  } finally { await closeServer(server); }
});

test('?fresh=1 llega al lector como {fresh:true}', async () => {
  const seen = [];
  const server = createServer({ missionFn: async (args) => { seen.push(args); return { status: 'ok' }; } });
  const port = await listen(server);
  try {
    await fetch(`http://127.0.0.1:${port}/api/mission?fresh=1`);
    await fetch(`http://127.0.0.1:${port}/api/mission`);
    assert.deepEqual(seen.map(s => s.fresh), [true, false]);
  } finally { await closeServer(server); }
});

test('un lector que explota devuelve 200 broken, no 500', async () => {
  const server = createServer({ missionFn: async () => { throw new Error('boom'); } });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/mission`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'broken');
    assert.match(body.error.stderr, /boom/);
  } finally { await closeServer(server); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/serve-mission.test.js`
Expected: FAIL — 404 en vez de 200

- [ ] **Step 3: Write minimal implementation**

En `serve.js`, arriba: `const { makeMissionReader } = require('./bin/mission.js');` y un lector por proceso:

```js
let defaultMissionRead = null;
function realMission(args) {
  if (!defaultMissionRead) defaultMissionRead = makeMissionReader({ env: process.env, homeDir: os.homedir() });
  return defaultMissionRead(args);
}
```

En `handle(req, res, collectFn, missionFn)`, después de la rama de `/api/local`:

```js
  if (url.pathname === '/api/mission') {
    // Never 500 on a failed read: `broken` IS the answer, and a transport
    // error would make the panel show nothing instead of showing why.
    let payload;
    try {
      payload = await missionFn({ fresh: url.searchParams.get('fresh') === '1' });
    } catch (err) {
      payload = { status: 'broken', mcBin: null, generatedAt: null, ageMs: null,
                  sources: [], ask: [], deferred: 0, take: {},
                  leases: { active: [], expired: [], error: null },
                  error: { code: null, stderr: String(err && err.message || err), timedOut: false } };
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(payload));
  }
```

Y en `createServer`: `const missionFn = (opts && opts.missionFn) || realMission;` pasándolo a `handle(req, res, collectFn, missionFn)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/serve-mission.test.js && node --test`
Expected: PASS — los 3 nuevos y toda la suite (356+ tests) verdes

- [ ] **Step 5: Commit**

```bash
git add serve.js tests/serve-mission.test.js
git commit -m "feat(serve): GET /api/mission

Un lector que falla devuelve 200 con status broken: el estado es parte del
contrato y un 500 dejaría al panel sin poder mostrar por qué no vio nada."
```

---

### Task 6: `local.js` + `index.html` — pintar las cards

**Files:**
- Modify: `index.html:897-903` (agregar `<script src="mission.js">` antes de `local.js`)
- Modify: `local.js` (nuevo fetch, `missionCardHTML`, el cosido dentro de `procCardHTML`, el chip `mc`)
- Test: `tests/mission-cards.test.js` (extender con el HTML), verificación en vivo en Task 9

**Interfaces:**
- Consumes: `missionCards`, `stitchMission` (Tasks 2–3), `GET /api/mission` (Task 5).
- Produces: `window.MISSION_STATE`, `missionCardHTML(card)`, y el chip `data-mc-filter` que oculta las cards nuevas.

- [ ] **Step 1: Write the failing test**

```js
// añadir a tests/mission-cards.test.js
const { missionCardHTML } = require('../mission.js');

test('el HTML de una card escapa todo lo que viene del payload', () => {
  const html = missionCardHTML({ kind: 'source', id: 'source:x', tone: 'red',
    title: '<img src=x onerror=alert(1)>', badge: 'broken',
    lines: ['<script>bad</script>'], links: [{ label: 'a', url: 'javascript:alert(1)' }], slot: 'top' });
  assert.equal(html.indexOf('<img'), -1);
  assert.equal(html.indexOf('<script>bad'), -1);
  assert.equal(html.indexOf('javascript:'), -1);
  assert.match(html, /proc-card/);
  assert.match(html, /badge-red/);
});

test('un link http sí se pinta como anchor', () => {
  const html = missionCardHTML({ kind: 'ticket', id: 't', tone: 'plain', title: 'q', badge: '1',
    lines: [], links: [{ label: 'SQSH-1', url: 'https://x/SQSH-1' }], slot: 'bottom' });
  assert.match(html, /<a[^>]+href="https:\/\/x\/SQSH-1"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mission-cards.test.js`
Expected: FAIL — `missionCardHTML is not a function`

- [ ] **Step 3: Implementar `missionCardHTML` en `mission.js`**

Va en `mission.js` (no en `local.js`) para que el test lo alcance sin DOM. `safeHttpUrl` es un global que define `classify.js` en el browser; en Node se pasa por parámetro opcional para no acoplar los módulos.

```js
var TONE_CLASS = { red: 'badge-red', amber: 'badge-amber', gray: 'badge-gray', plain: 'badge-gray badge-dim' };

function escM(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Only http(s). Everything in a card comes from mc's output, which includes
// Jira summaries and branch names — none of it is trusted markup.
function safeUrlM(url) {
  var checker = (typeof safeHttpUrl === 'function') ? safeHttpUrl : null;
  if (checker) return checker(url) ? url : null;
  return /^https?:\/\//i.test(String(url || '')) ? url : null;
}

function missionCardHTML(card) {
  var badge = card.badge
    ? '<span class="badge ' + (TONE_CLASS[card.tone] || 'badge-gray') + '">' + escM(card.badge) + '</span>'
    : '';
  var lines = (card.lines || []).map(function (l) {
    return '<div class="proc-detail">' + escM(l) + '</div>';
  }).join('');
  var links = (card.links || []).map(function (l) {
    var u = safeUrlM(l.url);
    return u ? '<a class="btn btn-ghost btn-sm" href="' + escM(u) + '" target="_blank" rel="noopener noreferrer">' + escM(l.label) + '</a>'
             : '<span class="btn btn-ghost btn-sm">' + escM(l.label) + '</span>';
  }).join('');
  return '<div class="proc-card pr-card mission-card" data-mc-kind="' + escM(card.kind) + '">'
       + '<div class="pr-number">' + escM(card.title) + badge + '</div>'
       + lines
       + (links ? '<div class="pr-actions">' + links + '</div>' : '')
       + '</div>';
}
```

Sumar `missionCardHTML`, `escM` y `safeUrlM` al `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/mission-cards.test.js`
Expected: PASS, 13 tests

- [ ] **Step 5: Cargar `mission.js` en el browser**

En `index.html`, antes de `local.js` (necesita `safeHttpUrl` de `classify.js`, así que va después de él):

```html
<script src="classify.js"></script>
<script src="mission.js"></script>
```

- [ ] **Step 6: Fetch independiente en `local.js`**

Al final de `local.js`, y **sin** tocar `initLocalPanel`: un fetch propio que repinta cuando llega.

```js
// Fetched separately from /api/local on purpose: mc's `work` source carries
// 180s internal timeouts, so coupling both into one payload would leave the
// whole panel blank whenever one source is slow.
async function initMissionPanel() {
  try {
    const res = await fetch('/api/mission', { cache: 'no-store' });
    if (!res.ok) return;
    const payload = await res.json();
    if (!payload || payload.status === 'off') return;
    window.MISSION_STATE = payload;
    if (window.LOCAL_STATE) mountPanelSafely();
  } catch { /* sin sidecar no hay panel; el hint lo pone initLocalPanel */ }
}

initMissionPanel();
```

- [ ] **Step 7: Coser y pintar dentro de `renderLocalPanel`**

En `renderLocalPanel`, antes de construir `listHTML`:

```js
  const mission = window.MISSION_STATE || null;
  const stitch = stitchMission(mission, sorted);
  const mcCards = mission ? missionCards(Object.assign({}, mission, { matchedAskIds: stitch.matchedAskIds })) : [];
  const mcHidden = mcFilter === 'off';
  const topCards = mcHidden ? '' : mcCards.filter(c => c.slot === 'top').map(missionCardHTML).join('');
  const bottomCards = mcHidden ? '' : mcCards.filter(c => c.slot === 'bottom').map(missionCardHTML).join('');
```

`listHTML` pasa a ser `topCards + (lo que ya construía) + bottomCards`.

La firma de `procCardHTML` (`local.js:423`) pasa de `(row, now, workspaceRoot, prPending)` a `(row, now, workspaceRoot, prPending, stitched)`, y el call site del `.map` pasa `stitch.perKey[r.proc.key] || null`. Nada más la llama (verificar con `grep -n procCardHTML local.js`). Dentro, después de `rightBadges`:

```js
  // Stitched from mission-control: the question and the lease belong on the
  // card of the work they describe, not in a separate list.
  const stitchedHTML = !stitched ? '' :
    (stitched.lease ? `<div class="proc-detail">🔒 lease: ${escS(stitched.lease.forWhat || 'tomado')} · vence en ${escS(stitched.lease.minutesLeft)}m</div>` : '')
    + stitched.questions.map(q => `<div class="proc-detail">❓ ${escS(q.item.question)}</div>`
        + (q.item.options || []).map(o => `<div class="proc-detail">· ${escS(o.label)} — ${escS(o.description || '')}</div>`).join('')).join('');
```

Insertar `stitchedHTML` en el template de la card, justo antes de `.pr-actions`.

- [ ] **Step 8: El chip `mc`**

Módulo-level en `local.js`, junto a `prFilter`: `let mcFilter = null;` (`'off'` oculta). En `index.html`, dentro de `#proc-filter`, un chip más:

```html
<button class="proc-chip" data-mc-filter="off" type="button">mc</button>
```

En `installFilterDelegation`, antes de las otras ramas:

```js
    if (chip.dataset.mcFilter) {
      mcFilter = mcFilter === 'off' ? null : 'off';
      chip.classList.toggle('selected', mcFilter === 'off');
      renderLocalPanel();
      return;
    }
```

Y en `unmountPanel`, `mcFilter = null;` junto a los otros resets.

- [ ] **Step 9: Correr toda la suite**

Run: `node --test`
Expected: PASS, todo verde (los tests de panel existentes no deben moverse)

- [ ] **Step 10: Commit**

```bash
git add index.html local.js mission.js tests/mission-cards.test.js
git commit -m "feat(panel): las cards de mission-control cosidas al panel

La pregunta y el lease van en la card del trabajo que describen; lo que no
tiene proceso va a card propia. Chip mc para ocultarlas todas."
```

---

### Task 7: el compare que apunta a la nada (preexistente)

**Files:**
- Modify: `local.js:210-224` (`diffLinksFor`), `local.js:834-841` (`initLocalPanel`)
- Test: `tests/classify-join.test.js` no cubre esto; nuevo `tests/mission-compare.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `compareLinkAllowed(worktree, fromCache)` → boolean, en `mission.js` (la decisión pura, testeable sin DOM). `diffLinksFor` se queda en `local.js` y la llama; con `fromCache === true` sólo emite link para worktrees con `onOrigin === true` confirmado.

- [ ] **Step 1: Write the failing test**

```js
// tests/mission-compare.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { compareLinkAllowed } = require('../mission.js');

test('payload fresco: onOrigin desconocido sigue permitiendo el link (contrato viejo)', () => {
  assert.equal(compareLinkAllowed({ onOrigin: null }, false), true);
  assert.equal(compareLinkAllowed({}, false), true);
});

test('payload fresco: onOrigin false lo bloquea, como hoy', () => {
  assert.equal(compareLinkAllowed({ onOrigin: false }, false), false);
});

test('payload cacheado: sólo un onOrigin true confirmado permite el link', () => {
  assert.equal(compareLinkAllowed({ onOrigin: true }, true), true);
  assert.equal(compareLinkAllowed({ onOrigin: null }, true), false);
  assert.equal(compareLinkAllowed({}, true), false);
  assert.equal(compareLinkAllowed({ onOrigin: false }, true), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mission-compare.test.js`
Expected: FAIL — `compareLinkAllowed is not a function`

- [ ] **Step 3: Write minimal implementation**

En `mission.js` (y al `module.exports`):

```js
// A cached payload can predate the drain pushing the branch, and then the
// card offers a `compare/<base>...<branch>` that GitHub cannot resolve. The
// old rule (unknown behaves as it did before onOrigin existed) is right for a
// fresh payload and wrong for a cached one — measured with bp-prod-10230,
// which by the time it was clicked was on origin with 34 commits.
function compareLinkAllowed(worktree, fromCache) {
  var w = worktree || {};
  if (w.onOrigin === false) return false;
  if (fromCache) return w.onOrigin === true;
  return true;
}
```

En `local.js`: `let payloadFromCache = false;` a nivel módulo; en `initLocalPanel` ponerlo en `true` antes del `mountPanelSafely()` del cache y en `false` cuando llega el payload fresco. `diffLinksFor` reemplaza `if (w.onOrigin === false) return;` por `if (!compareLinkAllowed(w, payloadFromCache)) return;`, y en ese caso, si el worktree tiene `path` y `branch`, se emite `pushChip(w, multi)` en su lugar (la lista de chips de la card ya lo soporta).

- [ ] **Step 4: Run tests**

Run: `node --test tests/mission-compare.test.js && node --test`
Expected: PASS todo

- [ ] **Step 5: Commit**

```bash
git add local.js mission.js tests/mission-compare.test.js
git commit -m "fix(panel): el compare no puede apuntar a la nada

Un payload cacheado de antes del push producía un compare irresoluble. Con
caché sólo un onOrigin true confirmado pinta link; si no, va el chip de push."
```

---

### Task 8: el hint para quien no corre el sidecar

**Files:**
- Modify: `index.html` (el markup del hint), `local.js:832-855` (`initLocalPanel`)
- Test: `tests/mission-hint.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `shouldShowSidecarHint({ fetchFailed, dismissed })` → boolean, en `mission.js`. El DOM lo maneja `local.js`.

- [ ] **Step 1: Write the failing test**

```js
// tests/mission-hint.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { shouldShowSidecarHint } = require('../mission.js');

test('se pinta sólo cuando el fetch ya falló', () => {
  assert.equal(shouldShowSidecarHint({ fetchFailed: true, dismissed: false }), true);
  assert.equal(shouldShowSidecarHint({ fetchFailed: false, dismissed: false }), false);
});

test('el dismiss manda', () => {
  assert.equal(shouldShowSidecarHint({ fetchFailed: true, dismissed: true }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mission-hint.test.js`
Expected: FAIL — no existe la función

- [ ] **Step 3: Write minimal implementation**

En `mission.js`:

```js
// Painted only after /api/local has actually failed — never while the fetch
// is in flight, or it flashes on localhost where the sidecar does answer.
function shouldShowSidecarHint(state) {
  var s = state || {};
  return !!s.fetchFailed && !s.dismissed;
}
```

En `index.html`, arriba de `#own-column`:

```html
<div id="sidecar-hint" class="hidden">
  <span>Además de esta cola: corriendo el sidecar local ves tus worktrees, sesiones de Claude y PRs propios agrupados por ticket. Nada sale de tu máquina.</span>
  <a href="https://github.com/sfavaron-hu/pr-queue#the-active-processes-panel-local-only" target="_blank" rel="noopener noreferrer">ver cómo</a>
  <button id="sidecar-hint-dismiss" type="button">ok, ✕</button>
</div>
```

En `local.js`, dentro del `catch` de `initLocalPanel` (donde hoy hace `if (painted) unmountPanel(); return;`), antes del `return`:

```js
    showSidecarHint();
```

y la función:

```js
const HINT_DISMISS_KEY = 'prq_sidecar_hint_dismissed';

function showSidecarHint() {
  let dismissed = false;
  try { dismissed = localStorage.getItem(HINT_DISMISS_KEY) === '1'; } catch { /* modo privado */ }
  if (!shouldShowSidecarHint({ fetchFailed: true, dismissed })) return;
  const el = document.getElementById('sidecar-hint');
  if (!el) return;
  el.classList.remove('hidden');
  const btn = document.getElementById('sidecar-hint-dismiss');
  if (btn) btn.addEventListener('click', () => {
    el.classList.add('hidden');
    try { localStorage.setItem(HINT_DISMISS_KEY, '1'); } catch { /* quota */ }
  });
}
```

- [ ] **Step 4: Run tests**

Run: `node --test`
Expected: PASS, todo verde

- [ ] **Step 5: Commit**

```bash
git add index.html local.js mission.js tests/mission-hint.test.js
git commit -m "feat(panel): decirle a quien no corre el sidecar que existe

Se pinta después de que /api/local falla, nunca en vuelo, y menciona sólo el
sidecar: mission-control es personal y prometerlo sería mentir."
```

---

### Task 9: verificación en vivo y PR

**Files:**
- Modify: `README.md` (la tabla de env vars: `PRQ_MC_BIN`)
- Create: nada

- [ ] **Step 1: Levantar el sidecar del worktree en el puerto de dev**

```bash
cd /Users/sebas/Code/humand/pr-queue--mission-cards
PRQ_PORT=7778 node serve.js
```

Expected: `pr-queue local → http://localhost:7778`. El `:7777` del checkout principal sigue vivo y sin tocar.

- [ ] **Step 2: Probar los tres estados contra mc de verdad**

```bash
curl -s localhost:7778/api/mission | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);console.log(p.status, p.ageMs, p.sources.map(x=>x.name+':'+x.status).join(' '), 'leases:'+p.leases.active.length)})"
PRQ_MC_BIN=/no/existe PRQ_PORT=7779 node serve.js &   # debe dar status broken
PRQ_MC_BIN= CLAUDE_CONFIG_DIR=/tmp/vacio PRQ_PORT=7780 node serve.js &   # debe dar status off
```

Expected: `ok` con las 5 fuentes y su estado real; `broken` con el binario inexistente; `off` con un `CLAUDE_CONFIG_DIR` vacío y sin `PRQ_MC_BIN`.

- [ ] **Step 3: Verificar en el browser con captura**

Abrir `http://localhost:7778` por CDP (skill `chrome-browser-control-macos`, **no** el MCP de Playwright) y capturar: (a) una card de proceso con pregunta y lease cosidos, (b) la card de una fuente no-`ok` con su `install`, (c) una card por cola de tickets, (d) el chip `mc` apagando todo.

**Sin PAT y sin pedírselo a nadie.** `:7778` es otro origin que `:7777`, así que no hereda el token — y no hace falta: las cards de mission no dependen de GitHub. La mitad de PRs va a quedar en `cargando PRs…` y eso es el estado correcto, no un fallo (ver `prDataState()`, `local.js:407`). Si hace falta ver un proceso con badges de PR, se inyecta un `LOCAL_STATE` sintético por CDP, nunca el token real del dueño.

- [ ] **Step 4: Verificar el hint sin sidecar**

Servir `index.html` sin `/api/local` (`python3 -m http.server 7781` desde el worktree), abrir y confirmar que el hint aparece una vez, que el dismiss persiste al recargar, y que en `:7778` **no** aparece.

- [ ] **Step 5: README y commit**

Agregar `PRQ_MC_BIN` a la tabla de env vars con su default derivado y una línea de qué pasa si falta (el panel es el de siempre).

```bash
git add README.md
git commit -m "docs: PRQ_MC_BIN en la tabla de env vars"
```

- [ ] **Step 6: Abrir el PR draft**

```bash
git push -u origin feat/panel-mission-cards
gh pr create --draft --base main \
  --title "El panel muestra lo que mission-control ve" \
  --body "$(cat <<'EOF'
Dos cosas acá: el panel se había quedado en la versión que sólo veía
worktrees y PRs mientras mission-control sumaba cinco fuentes, y de paso un
compare que apuntaba a la nada.

## Qué estaba roto antes

El panel no leía nada de mission-control: ni las preguntas abiertas, ni los
leases, ni si una fuente pudo mirar. Su única señal de degradación era
`· N warnings`, que no distingue una fuente ausente de una vacía.

Y `diffLinksFor` podía pintar un `compare/<base>...<branch>` desde un payload
cacheado de antes de que el drenaje pushee la rama — link irresoluble.

## Qué cambia

- `mission.js` (puro, browser + Node) + `bin/mission.js` (exec de `mc`, TTL
  60s, single-flight) + `GET /api/mission`.
- Las preguntas y los leases se cosen a la card del proceso que describen; lo
  que no tiene proceso va a card propia. Chip `mc` para ocultarlas.
- Con payload cacheado, sólo un `onOrigin` true confirmado pinta compare; si
  no, va el chip de push.
- Quien no corre el sidecar ahora se entera de que existe.

**El exit code de `mc` no es señal de fallo** (10 = hay preguntas): el
criterio es si el JSON parseó, y hay un test que lo blinda.

## Verificación

[capturas de los pasos 3 y 4 de la Task 9]

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Soltar el lease**

```bash
~/.claude/mission-control/bin/mc lease release /Users/sebas/Code/humand/pr-queue--mission-cards
```

---

## Self-Review

**Cobertura del spec:**

| Sección del spec | Task |
|---|---|
| §1 arquitectura (3 archivos, 2 fetches, 2 execs) | 1–6 |
| §2 contrato de `/api/mission` (TTL 60s, single-flight, timeout 20s, `PRQ_MC_BIN`) | 4, 5 |
| §2 `normalize()` del legacy `no-check` | 1 (test), 2 (pintado) |
| §3 los 8 kinds de card | 2 (7 kinds) + 6 (el cosido dentro de `process`) |
| §3 `degraded` produce card y no esconde items | 2 |
| §4 orden y chip `mc` | 6 (`slot` + `mcFilter`) |
| §5 degradación, los 5 casos | 1, 4, 5 |
| §5 el gotcha del exit code | 1 |
| §6 hint de GH Pages | 8 |
| §7 el compare cacheado | 7 |
| Testing (9 filas) | cada fila tiene test en 1–8; shareability lo cubre el test de `resolveMcBin` |
| Entrega (worktree, 7778, PR, lease) | 9 |

**Consistencia de tipos:** `card` se define en Task 2 y se consume en 6 con los mismos campos (`kind, id, tone, title, badge, lines, links, slot`). `stitchMission` devuelve `{perKey, matchedAskIds}` en 3 y se usa con esos dos nombres en 6. `classifyMissionRead` devuelve `{status, snapshot, error}` en 1 y `bin/mission.js` lee esos tres en 4. `compareLinkAllowed(worktree, fromCache)` en 7 con el mismo orden de argumentos en `local.js`.

**Hueco conocido, dejado a propósito:** el `slot` de las cards `question` es `bottom`, así que una pregunta sin proceso aparece con el bloque informativo y no arriba. Si en la primera corrida real molesta, es un cambio de una línea en Task 2.
