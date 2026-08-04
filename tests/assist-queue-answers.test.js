const { test } = require('node:test');
const assert = require('node:assert');
const { queuePaths, itemId, syncItems, writeAnswer, readAnswer } = require('../assist/queue.js');

function memIo(nowMs) {
  const files = new Map(); let clock = nowMs || 0;
  return { _files: files, _setNow: (t)=>{clock=t;}, now: ()=>clock,
    read: (p)=>{ if(!files.has(p)) throw new Error('ENOENT '+p); return files.get(p); },
    write: (p,s)=>{ files.set(p,s); }, rename: (a,b)=>{ if(!files.has(a)) throw new Error('ENOENT '+a); files.set(b,files.get(a)); files.delete(a); },
    remove: (p)=>{ files.delete(p); }, exists: (p)=>files.has(p),
    list: (dir)=>{ const pre=dir.endsWith('/')?dir:dir+'/'; const n=new Set(); for(const k of files.keys()) if(k.startsWith(pre)) n.add(k.slice(pre.length).split('/')[0]); return [...n]; },
    mkdirp: ()=>{} };
}

const item = { type: 'question', processKey: 'a', key: 'cold:a', question: '¿Qué hago?',
  options: [{ label: 'Retomar' }, { label: 'Dejar' }, { label: 'Archivar' }] };

function seed() { const io = memIo(1); const paths = queuePaths('/s'); syncItems(io, paths, [item]); return { io, paths, id: itemId(item) }; }

test('a value matching a declared option is accepted and stored', () => {
  const { io, paths, id } = seed();
  assert.deepEqual(writeAnswer(io, paths, id, { value: 'Dejar' }, {}), { ok: true });
  assert.deepEqual(readAnswer(io, paths, id), { value: 'Dejar' });
});

test('a value NOT among the options is rejected', () => {
  const { io, paths, id } = seed();
  const res = writeAnswer(io, paths, id, { value: 'Mergear' }, {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad-value');
  assert.equal(io.exists(`${paths.answers}/${id}.json`), false);
});

test('an {other} free-text answer is rejected unless allowOther', () => {
  const { io, paths, id } = seed();
  assert.equal(writeAnswer(io, paths, id, { other: 'hacé X en vez' }, {}).ok, false);
  assert.equal(writeAnswer(io, paths, id, { other: 'hacé X en vez' }, { allowOther: true }).ok, true);
  assert.deepEqual(readAnswer(io, paths, id), { other: 'hacé X en vez' });
});

test('an answer to an unknown item is rejected', () => {
  const io = memIo(1); const paths = queuePaths('/s');
  assert.deepEqual(writeAnswer(io, paths, 'deadbeef', { value: 'x' }, {}), { ok: false, reason: 'no-item' });
});

test('an empty or malformed answer is rejected', () => {
  const { io, paths, id } = seed();
  assert.equal(writeAnswer(io, paths, id, {}, { allowOther: true }).ok, false);
  assert.equal(writeAnswer(io, paths, id, { other: '' }, { allowOther: true }).ok, false);
  assert.equal(writeAnswer(io, paths, id, { value: 42 }, {}).ok, false);
});

test('readAnswer returns null when none exists', () => {
  const { io, paths, id } = seed();
  assert.equal(readAnswer(io, paths, id), null);
});
