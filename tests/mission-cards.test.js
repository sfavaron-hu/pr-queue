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
