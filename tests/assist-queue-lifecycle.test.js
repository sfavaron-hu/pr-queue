const { test } = require('node:test');
const assert = require('node:assert');
const { queuePaths, itemId, syncItems, writeAnswer, markDone, listOpenItems, pruneDone } = require('../assist/queue.js');

function memIo(nowMs) {
  const files = new Map(); let clock = nowMs || 0;
  return { _files: files, _setNow: (t)=>{clock=t;}, now: ()=>clock,
    read: (p)=>{ if(!files.has(p)) throw new Error('ENOENT '+p); return files.get(p); },
    write: (p,s)=>{ files.set(p,s); }, rename: (a,b)=>{ if(!files.has(a)) throw new Error('ENOENT '+a); files.set(b,files.get(a)); files.delete(a); },
    remove: (p)=>{ files.delete(p); }, exists: (p)=>files.has(p),
    list: (dir)=>{ const pre=dir.endsWith('/')?dir:dir+'/'; const n=new Set(); for(const k of files.keys()) if(k.startsWith(pre)) n.add(k.slice(pre.length).split('/')[0]); return [...n]; },
    mkdirp: ()=>{} };
}
const DAY = 86400000;
const item = (key) => ({ type: 'question', processKey: key.split(':')[1], key, options: [{ label: 'Dejar' }] });

test('markDone moves the item into done/ and clears items/ + answers/', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const it = item('cold:a'); const id = itemId(it);
  syncItems(io, paths, [it]);
  writeAnswer(io, paths, id, { value: 'Dejar' }, {});
  markDone(io, paths, id, { item: it, answer: { value: 'Dejar' }, action: 'archived' });
  assert.equal(io.exists(`${paths.items}/${id}.json`), false);
  assert.equal(io.exists(`${paths.answers}/${id}.json`), false);
  const rec = JSON.parse(io.read(`${paths.done}/${id}.json`));
  assert.equal(rec.action, 'archived');
  assert.equal(rec.doneAt, 1000);
});

test('listOpenItems pairs each open item with its answer (or null)', () => {
  const io = memIo(1); const paths = queuePaths('/s');
  const a = item('cold:a'), b = item('dirty:b');
  syncItems(io, paths, [a, b]);
  writeAnswer(io, paths, itemId(a), { value: 'Dejar' }, {});
  const open = listOpenItems(io, paths).sort((x, y) => x.item.key.localeCompare(y.item.key));
  assert.equal(open.length, 2);
  const byKey = Object.fromEntries(open.map(o => [o.item.key, o]));
  assert.deepEqual(byKey['cold:a'].answer, { value: 'Dejar' });
  assert.equal(byKey['dirty:b'].answer, null);
});

test('pruneDone removes records past retention and keeps recent ones', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const a = item('cold:a'), b = item('cold:b');
  syncItems(io, paths, [a, b]);
  markDone(io, paths, itemId(a), { item: a });    // doneAt 1000
  io._setNow(1000 + 20 * DAY);
  markDone(io, paths, itemId(b), { item: b });    // doneAt 1000+20d
  io._setNow(1000 + 40 * DAY);
  assert.equal(pruneDone(io, paths, 30), 1);      // only 'a' (40d old) pruned
  assert.equal(io.exists(`${paths.done}/${itemId(b)}.json`), true);
});

test('the bin module exposes main, fsIo and stateRoot, and does not run on require', () => {
  const mod = require('../assist/bin/queue.js');
  assert.equal(typeof mod.main, 'function');
  assert.equal(typeof mod.stateRoot, 'function');
  // stateRoot derives from the checkout dir, never a hardcoded path
  assert.match(mod.stateRoot('/repo'), /^\/repo\/state$/);
  // fsIo is the real-fs adapter with the injected-io shape
  ['read', 'write', 'rename', 'remove', 'exists', 'list', 'mkdirp', 'now'].forEach(k =>
    assert.equal(typeof mod.fsIo[k], 'function', `fsIo.${k}`));
});
