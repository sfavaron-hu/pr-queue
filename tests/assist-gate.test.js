const { test } = require('node:test');
const assert = require('node:assert');
const { buildGate, gateExitCode, readBabysitNotifications } = require('../assist/gate.js');

const flags = (over) => Object.assign(
  { notOnOrigin: false, dirty: false, prunable: false, cold: false, noTicket: false,
    sessionIdle: false, hasOpenPR: false, hasDraftPR: false, hasMergedPR: false,
    mergedWithLiveWorktree: false }, over);
const proc = (over) => Object.assign(
  { key: 'SQSH-1', ticket: 'SQSH-1', worktrees: [], prs: [], lastLocalActivity: 0, flags: flags() }, over);
const ledger = (processes, warnings) => ({ processes, workspaceRoot: '/w', warnings: warnings || [] });

// A fake io whose files are a { path: contents } map and dirs a { dir: [names] } map.
const fakeIo = (files, dirs) => ({
  exists: (p) => (files && p in files) || (dirs && p in dirs),
  readText: (p) => { if (!files || !(p in files)) throw new Error('ENOENT'); return files[p]; },
  listFiles: (d) => (dirs && dirs[d]) || [],
});

test('buildGate assembles actions, questions and notify', () => {
  const g = buildGate(ledger([
    proc({ key: 'a', worktrees: [{ repo: 'r', path: '/w/r', branch: 'feat/a', onOrigin: false, dirty: 0 }], prs: [], flags: flags({ notOnOrigin: true }) }),
    proc({ key: 'b', worktrees: [{ repo: 'r', path: '/w/r2', branch: 'feat/b', dirty: 2, onOrigin: true }], prs: [], flags: flags({ dirty: true }) }),
  ]), 1000, {});
  assert.equal(g.version, 1);
  assert.equal(g.actions.filter(x => x.kind === 'push').length, 1);
  assert.equal(g.questions.length, 1);
  assert.equal(g.generatedAt, 1000);
});

test('gateExitCode: 10 when there is work, 0 when there is none', () => {
  const withWork = buildGate(ledger([proc({ worktrees: [{ repo: 'r', path: '/w/r', branch: 'feat/a', onOrigin: false, dirty: 0 }], flags: flags({ notOnOrigin: true }) })]), 0, {});
  assert.equal(gateExitCode(withWork, []), 10);
  const idle = buildGate(ledger([proc({})]), 0, {});
  assert.equal(gateExitCode(idle, []), 0);
});

test('gateExitCode: 4 when a gh warning made the PR half untrustworthy', () => {
  const g = buildGate(ledger([proc({})]), 0, {});
  assert.equal(gateExitCode(g, [{ step: 'gh-search', message: 'boom' }]), 4);
  // a non-gh warning does not degrade
  assert.equal(gateExitCode(g, [{ step: 'workspace', message: 'x' }]), 0);
});

test('readBabysitNotifications: absent dir yields nothing', () => {
  assert.deepEqual(readBabysitNotifications('/no/such', fakeIo({}, {})), []);
  assert.deepEqual(readBabysitNotifications(null, fakeIo({}, {})), []);
});

test('readBabysitNotifications: counts comments/conflicts and names each needs-human file', () => {
  const dir = '/babysit';
  const io = fakeIo({
    [`${dir}/pending-comments.txt`]: 'line1\nline2\n\nline3\n',
    [`${dir}/pending-conflicts.txt`]: '',
  }, {
    [dir]: ['pending-comments.txt', 'pending-conflicts.txt',
            'needs-human-hu-ai-agent-plugin-57.txt', 'log.txt'],
  });
  const out = readBabysitNotifications(dir, io);
  const byKey = Object.fromEntries(out.map(n => [n.key, n]));
  assert.match(byKey['babysit:comments'].message, /3 comentario/);
  assert.ok(!('babysit:conflicts' in byKey)); // empty file → no notify
  const nh = out.find(n => n.key.startsWith('babysit:needs-human'));
  assert.match(nh.message, /hu-ai-agent-plugin#57/);
  out.forEach(n => assert.equal(n.source, 'pr-babysit'));
});

test('buildGate folds pr-babysit notifications in through the injected io', () => {
  const dir = '/babysit';
  const io = fakeIo({ [`${dir}/pending-comments.txt`]: 'a\nb\n' },
                    { [dir]: ['pending-comments.txt'] });
  const g = buildGate(ledger([proc({})]), 0, { babysitDir: dir, io });
  assert.equal(g.notify.length, 1);
  assert.match(g.notify[0].message, /2 comentario/);
  // and now there IS work (a notify), so the exit code is 10
  assert.equal(gateExitCode(g, []), 10);
});
