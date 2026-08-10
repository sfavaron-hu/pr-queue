// tests/assist-executor-cli.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { runCli } = require('../assist/executor.js');
const { queuePaths, itemId, syncItems, readAnswer } = require('../assist/queue.js');

function memIo(nowMs) {
  const files = new Map(); let clock = nowMs || 0;
  return { _files: files, now: () => clock,
    read: (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p); },
    write: (p, s) => { files.set(p, s); },
    rename: (a, b) => { if (!files.has(a)) throw new Error('ENOENT ' + a); files.set(b, files.get(a)); files.delete(a); },
    remove: (p) => { files.delete(p); }, exists: (p) => files.has(p),
    list: (dir) => { const pre = dir.endsWith('/') ? dir : dir + '/'; const n = new Set(); for (const k of files.keys()) if (k.startsWith(pre)) n.add(k.slice(pre.length).split('/')[0]); return [...n]; },
    mkdirp: () => {} };
}
function fakeExec(script) {
  const calls = [];
  const exec = (argv) => { calls.push(argv); return (script && script(argv)) || { code: 0, stdout: '', stderr: '' }; };
  exec.calls = calls; return exec;
}
const pushAction = { id: 'push:p1:r:b', kind: 'push', processKey: 'p1', repo: 'r',
  cmd: 'git -C /w/r push -u origin b', argv: ['git', '-C', '/w/r', 'push', '-u', 'origin', 'b'] };
const draftAction = { id: 'open-draft-pr:p2:r2:b2', kind: 'open-draft-pr', processKey: 'p2', repo: 'r2',
  githubRepo: 'Org/r2', head: 'b2', base: 'develop', why: 'commits sobre base', evidence: 'r2/b2: 3 commits',
  cmd: 'gh pr create --draft --fill -R Org/r2 --head b2 --base develop',
  argv: ['gh', 'pr', 'create', '--draft', '--fill', '-R', 'Org/r2', '--head', 'b2', '--base', 'develop'] };
const coldItem = { type: 'question', key: 'cold:p1', processKey: 'p1',
  question: 'p1 no se toca hace más de 14 días. ¿Qué hago?', header: 'Frío',
  options: [{ label: 'Retomar', description: '…' }, { label: 'Dejar', description: '…' }] };
const gate = (over) => Object.assign({ version: 1, generatedAt: 0, actions: [pushAction], questions: [coldItem], notify: [] }, over);
const deps = (io, exec, over) => Object.assign({
  io, exec, paths: queuePaths('/s'), now: () => 1000,
  loadGate: async () => ({ gate: gate(), warnings: [] }),
}, over);

test('drain runs reversible actions, syncs questions, and prunes; a new question makes it exit 10', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli([], deps(io, exec));
  assert.equal(res.exit, 10);   // a NEW unanswered question is waiting → heartbeat pings the owner
  assert.equal(res.output.notify, true);
  assert.deepEqual(exec.calls[0], ['git', '-C', '/w/r', 'push', '-u', 'origin', 'b']);   // action ran via argv
  assert.equal(io.exists(`${queuePaths('/s').items}/${itemId(coldItem)}.json`), true);   // question queued
  assert.equal(res.output.actions.ran, 1);
  assert.equal(res.output.questions.synced, 1);
});

test('a failed action reports its stderr; a successful one carries no stderr key', async () => {
  const io = memIo(1000);
  // 128 is ambiguous on its own: the main working tree and a worktree with untracked
  // files both return it, and they need opposite handling.
  const exec = fakeExec((argv) => argv.includes('push')
    ? { code: 128, stdout: '', stderr: "  fatal: '/w/r' contains modified or untracked files, use --force to delete it\n" }
    : { code: 0, stdout: '', stderr: '' });
  const res = await runCli([], deps(io, exec));
  const failed = res.output.actions.results.find(r => r.id === pushAction.id);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 128);
  assert.match(failed.stderr, /contains modified or untracked files/);
  assert.ok(!failed.stderr.startsWith(' '), 'stderr should be trimmed');

  const io2 = memIo(1000);
  const ok = await runCli([], deps(io2, fakeExec()));
  assert.equal(Object.hasOwn(ok.output.actions.results[0], 'stderr'), false);
});

test('reported stderr is capped so a chatty failure cannot flood the digest', async () => {
  const io = memIo(1000);
  const exec = fakeExec(() => ({ code: 1, stdout: '', stderr: 'x'.repeat(5000) }));
  const res = await runCli([], deps(io, exec));
  assert.equal(res.output.actions.results[0].stderr.length, 500);
});

test('drain runs the push but does NOT open draft PRs (left for /work-assistant)', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli([], deps(io, exec, {
    loadGate: async () => ({ gate: gate({ actions: [pushAction, draftAction] }), warnings: [] }),
  }));
  assert.ok(exec.calls.some(c => c[0] === 'git' && c.includes('push')), 'push should run');
  assert.ok(!exec.calls.some(c => c[0] === 'gh' && c.includes('create')), 'draft PR must NOT be created mechanically');
  assert.equal(res.output.actions.ran, 1);       // only the push
  assert.equal(res.output.draftsPending, 1);      // the draft is deferred to the skill
});

test('drafts lists pending draft PRs with semantic fields, read-only', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli(['drafts'], deps(io, exec, {
    loadGate: async () => ({ gate: gate({ actions: [pushAction, draftAction] }), warnings: [] }),
  }));
  assert.equal(res.exit, 0);
  assert.equal(exec.calls.length, 0);             // reads a gate, spawns nothing
  assert.deepEqual(res.output, [{
    id: 'open-draft-pr:p2:r2:b2', githubRepo: 'Org/r2', head: 'b2', base: 'develop',
    repo: 'r2', why: 'commits sobre base', evidence: 'r2/b2: 3 commits',
  }]);
});

test('drain does NOT re-notify a question already notified last pass (exit 0)', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const first = await runCli([], deps(io, exec));
  assert.equal(first.exit, 10);                 // first pass pings
  const second = await runCli([], deps(io, exec));
  assert.equal(second.exit, 0);                 // same question → throttled, no re-ping
  assert.equal(second.output.notify, false);
  assert.equal(second.output.questions.new, 0);
  assert.equal(second.output.questions.open, 1); // still open, just already notified
});

test('drain with no open questions does not notify (exit 0)', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli([], deps(io, exec, { loadGate: async () => ({ gate: gate({ questions: [] }), warnings: [] }) }));
  assert.equal(res.exit, 0);
  assert.equal(res.output.notify, false);
  assert.equal(res.output.questions.open, 0);
});

test('drain applies a "Dejar" answer already sitting in the queue', async () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  syncItems(io, paths, [coldItem]);
  io.write(`${paths.answers}/${itemId(coldItem)}.json`, JSON.stringify({ value: 'Dejar' }));
  const res = await runCli([], deps(io, fakeExec()));
  assert.equal(io.exists(`${paths.done}/${itemId(coldItem)}.json`), true);   // resolved
  assert.equal(res.output.questions.declined, 1);
});

test('a gh-degraded drain skips actions and syncing, prunes only, exits 4', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli([], deps(io, exec, {
    loadGate: async () => ({ gate: gate(), warnings: [{ step: 'gh:fetchOwnPRs', error: 'boom' }] }),
  }));
  assert.equal(res.exit, 4);
  assert.equal(exec.calls.length, 0);   // NOTHING executed while PR half is untrustworthy
  assert.equal(io.exists(`${queuePaths('/s').items}/${itemId(coldItem)}.json`), false);
});

test('action <id> runs exactly the matching action, by argv', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli(['action', 'push:p1:r:b'], deps(io, exec));
  assert.equal(res.exit, 0);
  assert.deepEqual(exec.calls, [['git', '-C', '/w/r', 'push', '-u', 'origin', 'b']]);
});

test('action <unknown-id> executes nothing and exits non-zero', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli(['action', 'nope'], deps(io, exec));
  assert.notEqual(res.exit, 0);
  assert.equal(exec.calls.length, 0);
});

test('answer <id> --value writes a valid answer and rejects a bad one', async () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  syncItems(io, paths, [coldItem]);
  const ok = await runCli(['answer', itemId(coldItem), '--value', 'Dejar'], deps(io, fakeExec()));
  assert.equal(ok.output.ok, true);
  assert.deepEqual(readAnswer(io, paths, itemId(coldItem)), { value: 'Dejar' });
  const bad = await runCli(['answer', itemId(coldItem), '--value', 'Nope'], deps(io, fakeExec()));
  assert.equal(bad.output.ok, false);
  assert.equal(bad.output.reason, 'bad-value');
});

test('answer <id> --other is accepted (allowOther on from the skill path)', async () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  syncItems(io, paths, [coldItem]);
  const r = await runCli(['answer', itemId(coldItem), '--other', 'rebasealo primero'], deps(io, fakeExec()));
  assert.equal(r.output.ok, true);
  assert.deepEqual(readAnswer(io, paths, itemId(coldItem)), { other: 'rebasealo primero' });
});

test('done <id> marks the item done', async () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  syncItems(io, paths, [coldItem]);
  const r = await runCli(['done', itemId(coldItem), '--resolution', 'retomado en subagente'], deps(io, fakeExec()));
  assert.equal(r.exit, 0);
  assert.equal(io.exists(`${paths.done}/${itemId(coldItem)}.json`), true);
  assert.equal(io.exists(`${paths.items}/${itemId(coldItem)}.json`), false);
});

test('done <id> records the question and answer, not just the resolution', async () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  syncItems(io, paths, [coldItem]);
  await runCli(['answer', itemId(coldItem), '--other', 'ya está merged'], deps(io, fakeExec()));
  await runCli(['done', itemId(coldItem), '--resolution', 'merged: PR #2258'], deps(io, fakeExec()));
  // done/ is the only surviving trace; it must carry "asked X, answered Y, did Z".
  const rec = JSON.parse(io.read(`${paths.done}/${itemId(coldItem)}.json`));
  assert.equal(rec.resolution, 'merged: PR #2258');
  assert.equal(rec.item.key, coldItem.key);          // the question is preserved
  assert.deepEqual(rec.answer, { other: 'ya está merged' });  // and the owner's answer
});

test('list prints open items with their answered flag', async () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  syncItems(io, paths, [coldItem]);
  const r = await runCli(['list'], deps(io, fakeExec()));
  assert.equal(r.output.length, 1);
  assert.equal(r.output[0].id, itemId(coldItem));
  assert.equal(r.output[0].answered, false);
});

test('--dry-run never calls exec even in drain', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli(['--dry-run'], deps(io, exec));
  assert.equal(exec.calls.length, 0);
  assert.equal(res.output.dryRun, true);
});

// --- `ask` is the one place the budget lives ---------------------------------
// The skill used to cap `list` itself, but `list` is a directory read with no
// order, so "the top 4" was arbitrary. `ask` hands back the gate's own ordered
// slice, already paired with the queue id each answer is written against.

const q = (k) => ({ type: 'question', key: `cold:${k}`, processKey: k,
  question: `${k} no se toca hace más de 14 días. ¿Qué hago?`, header: 'Frío',
  options: [{ label: 'Retomar', description: '…' }, { label: 'Dejar', description: '…' }] });

test('ask returns the budgeted slice with queue ids, in the gate order', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const all = ['a', 'b', 'c', 'd', 'e', 'f'].map(q);
  const res = await runCli(['ask'], deps(io, exec, {
    loadGate: async () => ({ gate: gate({ questions: all, ask: all.slice(0, 4) }), warnings: [] }),
  }));
  assert.equal(res.exit, 0);
  assert.equal(res.output.length, 4);
  assert.deepEqual(res.output.map(e => e.item.processKey), ['a', 'b', 'c', 'd']);
  assert.deepEqual(res.output.map(e => e.id), all.slice(0, 4).map(itemId));
});

test('ask drops a question the owner already answered', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const all = ['a', 'b'].map(q);
  const paths = queuePaths('/s');
  syncItems(io, paths, all);
  io.write(`${paths.answers}/${itemId(all[0])}.json`, JSON.stringify({ value: 'Dejar' }));
  const res = await runCli(['ask'], deps(io, exec, {
    loadGate: async () => ({ gate: gate({ questions: all, ask: all }), warnings: [] }),
  }));
  assert.deepEqual(res.output.map(e => e.item.processKey), ['b']);
});

// The gate rebuilds its questions from the live situation on every pass, so a
// declined question returns the moment the situation persists — and "Dejar" is
// usually chosen *because* it is going to persist. Found in the wild: three
// questions declined until September were served again, and writeAnswer then
// refused all three with `already-done` (the drain had moved them to done/).
// Asked forever, answerable never.
test('ask drops a question the owner declined, even when the gate re-emits it', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const all = ['a', 'b'].map(q);
  const paths = queuePaths('/s');
  io.write(`${paths.declined}/${itemId(all[0])}.json`, JSON.stringify({ until: 1000 + 30 * 86400000 }));
  const res = await runCli(['ask'], deps(io, exec, {
    loadGate: async () => ({ gate: gate({ questions: all, ask: all }), warnings: [] }),
  }));
  assert.deepEqual(res.output.map(e => e.item.processKey), ['b']);
});

// The decline is a 30-day silence, not a permanent one: once it lapses the
// question has to come back, or "Dejar" quietly becomes "never ask me again".
test('ask asks a declined question again once the decline has expired', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const all = ['a'].map(q);
  const paths = queuePaths('/s');
  io.write(`${paths.declined}/${itemId(all[0])}.json`, JSON.stringify({ until: 999 }));
  const res = await runCli(['ask'], deps(io, exec, {
    loadGate: async () => ({ gate: gate({ questions: all, ask: all }), warnings: [] }),
  }));
  assert.deepEqual(res.output.map(e => e.item.processKey), ['a']);
});

test('ask on a gate with no budgeted questions returns an empty batch', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli(['ask'], deps(io, exec, {
    loadGate: async () => ({ gate: gate({ questions: [], ask: [] }), warnings: [] }),
  }));
  assert.deepEqual(res.output, []);
});

// The persistence bug, at the drain level: everything the gate emits is stored,
// even though only the budgeted slice is asked. Storing only the slice deleted
// items the owner had already answered.
test('the drain persists every emitted question, not just the asked ones', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const paths = queuePaths('/s');
  const all = ['a', 'b', 'c', 'd', 'e', 'f'].map(q);
  const res = await runCli([], deps(io, exec, {
    loadGate: async () => ({ gate: gate({ actions: [], questions: all, ask: all.slice(0, 4) }), warnings: [] }),
  }));
  assert.equal(res.output.questions.synced, 6, 'all six stored');
  assert.equal(res.output.questions.deferred, 2, 'two persisted but not asked');
  for (const item of all) assert.ok(io.exists(`${paths.items}/${itemId(item)}.json`));
});
