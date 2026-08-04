const { test } = require('node:test');
const assert = require('node:assert');
const { queuePaths, itemId, syncItems, decline, isDeclined, pruneDeclined, readItem } = require('../assist/queue.js');

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
const q = (key, over) => Object.assign({ type: 'question', processKey: key.split(':')[1] || key, key }, over);

test('syncItems writes each open item to items/<id>.json', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const items = [q('dirty:a'), q('cold:b')];
  const res = syncItems(io, paths, items);
  assert.equal(res.written.length, 2);
  assert.deepEqual(readItem(io, paths, itemId(items[0])).key, 'dirty:a');
});

test('re-syncing the same items writes the same ids (idempotent dedup)', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const items = [q('dirty:a')];
  const first = syncItems(io, paths, items).written;
  const second = syncItems(io, paths, items).written;
  assert.deepEqual(first, second);
  assert.equal(io.list(paths.items).length, 1);
});

test('a declined-and-unexpired item is skipped, not written', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const item = q('cold:a');
  decline(io, paths, itemId(item), 30);
  const res = syncItems(io, paths, [item]);
  assert.deepEqual(res.skipped, [itemId(item)]);
  assert.equal(io.exists(`${paths.items}/${itemId(item)}.json`), false);
});

test('an expired decline no longer suppresses', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const item = q('cold:a');
  decline(io, paths, itemId(item), 30);
  io._setNow(1000 + 31 * DAY);
  const res = syncItems(io, paths, [item]);
  assert.deepEqual(res.written, [itemId(item)]);
});

test('isDeclined is true only while unexpired', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const id = itemId(q('cold:a'));
  decline(io, paths, id, 10);
  assert.equal(isDeclined(io, paths, id), true);
  io._setNow(1000 + 11 * DAY);
  assert.equal(isDeclined(io, paths, id), false);
});

test('pruneDeclined removes expired declines and counts them', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  decline(io, paths, 'aaa', 5);
  decline(io, paths, 'bbb', 40);
  io._setNow(1000 + 10 * DAY);
  assert.equal(pruneDeclined(io, paths), 1);       // only 'aaa' expired
  assert.equal(io.exists(`${paths.declined}/bbb.json`), true);
});

test('syncItems removes a stale item the gate no longer produces', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  syncItems(io, paths, [q('dirty:a'), q('cold:b')]);
  const res = syncItems(io, paths, [q('dirty:a')]);   // cold:b resolved
  assert.deepEqual(res.removed, [itemId(q('cold:b'))]);
  assert.equal(io.exists(`${paths.items}/${itemId(q('cold:b'))}.json`), false);
});

test('syncItems does NOT remove a stale item that has a pending answer', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const item = q('cold:b');
  syncItems(io, paths, [item]);
  io.write(`${paths.answers}/${itemId(item)}.json`, JSON.stringify({ value: 'Dejar' }));
  const res = syncItems(io, paths, []);              // gate no longer emits it
  assert.equal(res.removed.includes(itemId(item)), false);
  assert.equal(io.exists(`${paths.items}/${itemId(item)}.json`), true);
});
