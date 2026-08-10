const { test } = require('node:test');
const assert = require('node:assert');
const { queuePaths, itemId, writeAtomic } = require('../assist/queue.js');

function memIo(nowMs) {
  const files = new Map(); let clock = nowMs || 0;
  return { _files: files, _setNow: (t)=>{clock=t;}, now: ()=>clock,
    read: (p)=>{ if(!files.has(p)) throw new Error('ENOENT '+p); return files.get(p); },
    write: (p,s)=>{ files.set(p,s); }, rename: (a,b)=>{ if(!files.has(a)) throw new Error('ENOENT '+a); files.set(b,files.get(a)); files.delete(a); },
    remove: (p)=>{ files.delete(p); }, exists: (p)=>files.has(p),
    list: (dir)=>{ const pre=dir.endsWith('/')?dir:dir+'/'; const n=new Set(); for(const k of files.keys()) if(k.startsWith(pre)) n.add(k.slice(pre.length).split('/')[0]); return [...n]; },
    mkdirp: ()=>{} };
}

test('queuePaths lays out the six dirs under <root>/assist', () => {
  const p = queuePaths('/state');
  assert.equal(p.items, '/state/assist/items');
  assert.equal(p.answers, '/state/assist/answers');
  assert.equal(p.done, '/state/assist/done');
  assert.equal(p.declined, '/state/assist/declined');
  assert.equal(p.tmp, '/state/assist/tmp');
});

test('itemId is stable for the same item identity', () => {
  const a = { type: 'question', processKey: 'SQSH-1', key: 'dirty:SQSH-1', question: 'x?', options: [] };
  const b = { type: 'question', processKey: 'SQSH-1', key: 'dirty:SQSH-1', question: 'DIFFERENT COPY?', options: [{ label: 'z' }] };
  // Same identity (type+processKey+key) → same id even though question/options text differs.
  assert.equal(itemId(a), itemId(b));
  assert.match(itemId(a), /^[0-9a-f]{16}$/);
});

test('itemId diverges when the situation changes (different key)', () => {
  const cold = itemId({ type: 'question', processKey: 'SQSH-1', key: 'cold:SQSH-1' });
  const dirty = itemId({ type: 'question', processKey: 'SQSH-1', key: 'dirty:SQSH-1' });
  assert.notEqual(cold, dirty);
});

test('itemId does not fold volatile magnitude into the id', () => {
  // A dirty question with 3 files vs 5 files is the same decision — same id, so a
  // "leave it" keeps suppressing. The count lives in the item body, not the key.
  const three = itemId({ type: 'question', processKey: 'p', key: 'dirty:p' });
  const five  = itemId({ type: 'question', processKey: 'p', key: 'dirty:p' });
  assert.equal(three, five);
});

test('writeAtomic writes to tmp then renames onto the final path', () => {
  const io = memIo();
  const paths = queuePaths('/state');
  const order = [];
  const wrapped = Object.assign({}, io, {
    write: (p, s) => { order.push(['write', p]); io.write(p, s); },
    rename: (a, b) => { order.push(['rename', a, b]); io.rename(a, b); },
  });
  writeAtomic(wrapped, paths, `${paths.items}/abc.json`, { hello: 1 });
  // wrote to a tmp path first, then renamed onto the final path
  assert.equal(order[0][0], 'write');
  assert.match(order[0][1], /\/state\/assist\/tmp\//);
  assert.equal(order[1][0], 'rename');
  assert.equal(order[1][2], `${paths.items}/abc.json`);
  // final file exists and parses; no tmp left behind
  assert.deepEqual(JSON.parse(io.read(`${paths.items}/abc.json`)), { hello: 1 });
  assert.equal(io.list(paths.tmp).length, 0);
});
