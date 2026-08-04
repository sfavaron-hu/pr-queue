// tests/assist-executor-answers.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { applyAnswer } = require('../assist/executor.js');
const { queuePaths, itemId, syncItems, writeAnswer } = require('../assist/queue.js');

function memIo(nowMs) {
  const files = new Map(); let clock = nowMs || 0;
  return { _files: files, _setNow: (t) => { clock = t; }, now: () => clock,
    read: (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p); },
    write: (p, s) => { files.set(p, s); },
    rename: (a, b) => { if (!files.has(a)) throw new Error('ENOENT ' + a); files.set(b, files.get(a)); files.delete(a); },
    remove: (p) => { files.delete(p); }, exists: (p) => files.has(p),
    list: (dir) => { const pre = dir.endsWith('/') ? dir : dir + '/'; const n = new Set(); for (const k of files.keys()) if (k.startsWith(pre)) n.add(k.slice(pre.length).split('/')[0]); return [...n]; },
    mkdirp: () => {} };
}
// A cold question, shaped exactly like the gate emits it.
const coldItem = (over) => Object.assign({
  type: 'question', key: 'cold:p1', processKey: 'p1',
  question: 'p1 no se toca hace más de 14 días. ¿Qué hago?', header: 'Frío',
  options: [{ label: 'Retomar', description: '…' }, { label: 'Dejar', description: '…' }, { label: 'Archivar', description: '…' }],
}, over);

function seed(io, item, answerValue) {
  const paths = queuePaths('/s');
  syncItems(io, paths, [item]);
  const id = itemId(item);
  if (answerValue) writeAnswer(io, paths, id, { value: answerValue }, { allowOther: true });
  return { paths, id };
}

test('applyAnswer: an unanswered item is left alone', () => {
  const io = memIo(1000); const { paths, id } = seed(io, coldItem(), null);
  const r = applyAnswer(io, paths, { id, item: coldItem(), answer: null });
  assert.equal(r.status, 'unanswered');
  assert.equal(r.done, false);
  assert.equal(io.exists(`${paths.items}/${id}.json`), true);   // still open
});

test('applyAnswer: "Dejar" declines for 30 days and marks the item done', () => {
  const io = memIo(1000); const { paths, id } = seed(io, coldItem(), 'Dejar');
  const r = applyAnswer(io, paths, { id, item: coldItem(), answer: { value: 'Dejar' } });
  assert.equal(r.status, 'declined');
  assert.equal(r.done, true);
  assert.equal(io.exists(`${paths.declined}/${id}.json`), true);      // decline recorded
  assert.equal(io.exists(`${paths.done}/${id}.json`), true);          // moved to done
  assert.equal(io.exists(`${paths.items}/${id}.json`), false);        // cleared from items
  const decl = JSON.parse(io.read(`${paths.declined}/${id}.json`));
  assert.equal(decl.until, 1000 + 30 * 86400000);
});

test('applyAnswer: a declined item stays suppressed on the next syncItems', () => {
  const io = memIo(1000); const { paths, id } = seed(io, coldItem(), 'Dejar');
  applyAnswer(io, paths, { id, item: coldItem(), answer: { value: 'Dejar' } });
  const res = syncItems(io, paths, [coldItem()]);   // gate still emits it next pass
  assert.deepEqual(res.skipped, [id]);              // suppressed by the decline
  assert.equal(io.exists(`${paths.items}/${id}.json`), false);
});

test('applyAnswer: non-Dejar values are left for the model, not resolved', () => {
  for (const value of ['Retomar', 'Archivar', 'Commitear']) {
    const io = memIo(1000); const { paths, id } = seed(io, coldItem(), value);
    const r = applyAnswer(io, paths, { id, item: coldItem(), answer: { value } });
    assert.equal(r.status, 'needs-model', value);
    assert.equal(r.done, false, value);
    assert.equal(io.exists(`${paths.items}/${id}.json`), true, value);   // still open for the skill
  }
});

test('applyAnswer: an { other } free-text answer is needs-model', () => {
  const io = memIo(1000); const { paths, id } = seed(io, coldItem(), null);
  writeAnswer(io, paths, id, { other: 'dale pero primero rebasealo' }, { allowOther: true });
  const r = applyAnswer(io, paths, { id, item: coldItem(), answer: { other: 'dale pero primero rebasealo' } });
  assert.equal(r.status, 'needs-model');
  assert.equal(r.done, false);
});
