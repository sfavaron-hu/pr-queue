const { test } = require('node:test');
const assert = require('node:assert');
const { missionCards, missionCardHTML, safeUrlM } = require('../mission.js');
const { safeHttpUrl } = require('../classify.js');

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

test('mission ámbar cuando el read entero está degraded, sin asegurar ceguera', () => {
  const cards = missionCards(base({ status: 'degraded', error: null }));
  assert.deepEqual(kinds(cards), ['mission']);
  assert.equal(cards[0].tone, 'amber');
  assert.match(cards[0].lines.join(' '), /mc miró/);
  assert.doesNotMatch(cards[0].lines.join(' '), /no pude leer mc/);
});

test('degraded también dice cuántas fuentes miraron, no sólo que vino corta', () => {
  const cards = missionCards(base({ status: 'degraded', error: null,
    sources: [src('work', 'ok'), src('prs', 'broken')] }));
  assert.match(cards[0].lines.join(' '), /1\/2 fuentes/);
});

test('broken también dice cuántas fuentes miraron (0\\/0 si no hay snapshot que contar)', () => {
  const cards = missionCards(base({ status: 'broken', error: { code: 1, stderr: 'boom', timedOut: false } }));
  assert.match(cards[0].lines.join(' '), /0\/0 fuentes/);
});

test('deferred > 0 se dice en la card mission; deferred 0 no agrega nada', () => {
  const withDeferred = missionCards(base({ deferred: 3 }));
  assert.match(withDeferred[0].lines.join(' '), /3 esperan al próximo pase/);
  const withoutDeferred = missionCards(base({ deferred: 0 }));
  assert.doesNotMatch(withoutDeferred[0].lines.join(' '), /esperan al próximo pase/);
});

test('matchedAskIds filtra preguntas ya stitched en process cards', () => {
  const ask1 = { id: 'prs:matched', source: 'prs', priority: 10, item: { type: 'question', question: 'Matched?', header: 'PR', options: [], processKey: null } };
  const ask2 = { id: 'prs:unmatched', source: 'prs', priority: 20, item: { type: 'question', question: 'Unmatched?', header: 'PR', options: [], processKey: null } };
  const cards = missionCards(base({ ask: [ask1, ask2], matchedAskIds: ['prs:matched'] }));
  const questions = byKind(cards, 'question');
  assert.equal(questions.length, 1);
  assert.equal(questions[0].id, 'q:prs:unmatched');
});

test('refrescando se dice en la card, no se esconde', () => {
  const cards = missionCards(base({ refreshing: true, ageMs: 900000 }));
  assert.match(cards[0].lines.join(' '), /refrescando/);
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

test('un ticket cuya cola no está en la config no se pierde: cae en "otras colas"', () => {
  const rows = [
    { key: 'SQSH-1', summary: 's1', status: 'To Do', url: 'https://x/SQSH-1', queue: 'shark-frontend' },
    { key: 'SQSH-2', summary: 's2', status: 'To Do', url: 'https://x/SQSH-2', queue: 'cola-no-configurada' },
  ];
  const cards = byKind(missionCards(base({ sources: [src('tickets', 'ok', {
    queues: [{ name: 'shark-frontend', label: 'Shark frontend sin dueño' }], rows: rows })] })), 'ticket');
  assert.equal(cards.length, 2);
  const configured = cards.find(c => c.title === 'Shark frontend sin dueño');
  const leftover = cards.find(c => c.title === 'otras colas');
  assert.equal(configured.badge, '1');
  assert.ok(leftover, 'ningún card para la cola no configurada');
  assert.equal(leftover.badge, '1');
  assert.match(leftover.lines.join(' '), /SQSH-2/);
});

test('el inbox es una card agregada, no una por nota', () => {
  const cards = byKind(missionCards(base({ sources: [src('heartbeat', 'ok', {
    inbox: [{ source: 'work' }, { source: 'work' }, { source: 'prs' }], attention: [] })] })), 'inbox');
  assert.equal(cards.length, 1);
  assert.match(cards[0].badge, /3/);
});

test('fricción abierta produce una card con las observaciones', () => {
  const cards = byKind(missionCards(base({ sources: [src('friction', 'ok', {
    open: [{ note: 'el worktree quedó sin node_modules' }, { evidence: 'tsc tira 10k errores fantasma' }] })] })), 'friction');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].badge, '2');
  assert.equal(cards[0].slot, 'bottom');
  assert.match(cards[0].lines.join(' | '), /node_modules/);
  assert.match(cards[0].lines.join(' | '), /10k errores fantasma/);
});

test('tickets tomados produce una card "take" con el estado y el vencimiento', () => {
  const cards = byKind(missionCards(base({ take: { rows: [
    { key: 'SQSH-100', state: 'in-progress', until: '2026-08-13T00:00:00.000Z' },
    { key: 'SQSH-101', state: 'snoozed' },
  ] } })), 'take');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].badge, '2');
  assert.equal(cards[0].slot, 'bottom');
  assert.match(cards[0].lines.join(' | '), /SQSH-100 · in-progress hasta 2026-08-13/);
  assert.match(cards[0].lines.join(' | '), /SQSH-101 · snoozed/);
});

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

// Under `node --test` there is no global `safeHttpUrl` (it's a browser
// global set by classify.js's <script> tag), so the earlier escaping test
// only ever exercised safeUrlM's bare-regex fallback — never the checker
// branch the real browser actually runs. A STUB that disagrees with the
// regex in both directions proves the checker branch is actually taken, not
// merely present and dead: if the fallback ran instead, both assertions
// below would flip.
test('safeUrlM usa el checker global cuando existe, no el fallback de regex', () => {
  const prev = global.safeHttpUrl;
  try {
    global.safeHttpUrl = () => false;                    // checker dice que no
    assert.equal(safeUrlM('https://real.com'), null);     // el regex fallback diría que sí
    global.safeHttpUrl = () => true;                      // checker dice que sí
    assert.equal(safeUrlM('javascript:alert(1)'), 'javascript:alert(1)'); // el fallback rechazaría esto
  } finally {
    if (prev === undefined) delete global.safeHttpUrl; else global.safeHttpUrl = prev;
  }
});

// Con el checker REAL de classify.js (el que carga index.html), confirma que
// el camino de producción rechaza lo mismo que el fallback rechazaba antes.
test('safeUrlM con el safeHttpUrl real de classify.js rechaza javascript: y acepta https', () => {
  const prev = global.safeHttpUrl;
  try {
    global.safeHttpUrl = safeHttpUrl;
    assert.equal(safeUrlM('javascript:alert(1)'), null);
    assert.equal(safeUrlM('https://x/y'), 'https://x/y');
  } finally {
    if (prev === undefined) delete global.safeHttpUrl; else global.safeHttpUrl = prev;
  }
});

test('un link http sí se pinta como anchor', () => {
  const html = missionCardHTML({ kind: 'ticket', id: 't', tone: 'plain', title: 'q', badge: '1',
    lines: [], links: [{ label: 'SQSH-1', url: 'https://x/SQSH-1' }], slot: 'bottom' });
  assert.match(html, /<a[^>]+href="https:\/\/x\/SQSH-1"/);
});
