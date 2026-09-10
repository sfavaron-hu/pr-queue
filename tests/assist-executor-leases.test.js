// The drain is the half that mutates, and it runs unattended while agents work.
// A push rewrites the ref one of them is committing onto and `worktree remove`
// deletes the tree it is editing — neither is recoverable, because the work
// being destroyed was never on origin. `--skip-branch` is how the caller that
// holds the leases keeps the drain off those branches.
const { test } = require('node:test');
const assert = require('node:assert');
const { runCli, skipLeased } = require('../assist/executor.js');
const { queuePaths, itemId } = require('../assist/queue.js');

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
function fakeExec() {
  const calls = [];
  const exec = (argv) => { calls.push(argv); return { code: 0, stdout: '', stderr: '' }; };
  exec.calls = calls; return exec;
}

const push = (branch) => ({ id: `push:${branch}:r:${branch}`, kind: 'push', processKey: branch, repo: 'r', branch,
  cmd: `git -C /w/${branch} push -u origin ${branch}`, argv: ['git', '-C', `/w/${branch}`, 'push', '-u', 'origin', branch] });
const remove = (branch) => ({ id: `remove-merged-worktree:${branch}:r:${branch}`, kind: 'remove-merged-worktree',
  processKey: branch, repo: 'r', branch, cmd: `git -C /w worktree remove /w/${branch}`,
  argv: ['git', '-C', '/w', 'worktree', 'remove', `/w/${branch}`] });
const draft = (branch) => ({ id: `open-draft-pr:${branch}:r:${branch}`, kind: 'open-draft-pr', processKey: branch,
  repo: 'r', branch, githubRepo: 'Org/r', head: branch, base: 'develop',
  cmd: 'gh pr create', argv: ['gh', 'pr', 'create', '--draft', '--fill', '-R', 'Org/r', '--head', branch, '--base', 'develop'] });

const gate = (actions) => ({ version: 1, generatedAt: 0, actions, questions: [], ask: [], notify: [] });
const deps = (io, exec, actions) => ({
  io, exec, paths: queuePaths('/s'), now: () => 1000,
  loadGate: async () => ({ gate: gate(actions), warnings: [] }),
});

test('the drain runs nothing on a leased branch and pushes the free one', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli(['--skip-branch', 'feat/live'], deps(io, exec, [push('feat/live'), push('feat/idle')]));
  assert.deepEqual(exec.calls, [['git', '-C', '/w/feat/idle', 'push', '-u', 'origin', 'feat/idle']]);
  assert.equal(res.output.actions.ran, 1);
  assert.equal(res.output.actions.leasedSkipped.count, 1);
  assert.deepEqual(res.output.actions.leasedSkipped.branches, ['feat/live']);
});

// The whole point of the counter: a pass where every action was held reports
// ran=0, and ran=0 alone is indistinguishable from a pass with nothing to do.
test('a pass where everything is leased says so instead of reading as clean', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli(['--skip-branch', 'feat/a', '--skip-branch', 'feat/b'],
    deps(io, exec, [push('feat/a'), remove('feat/b')]));
  assert.deepEqual(exec.calls, []);
  assert.equal(res.output.actions.ran, 0);
  assert.equal(res.output.actions.leasedSkipped.count, 2);
  assert.deepEqual(res.output.actions.leasedSkipped.branches.sort(), ['feat/a', 'feat/b']);
});

test('--dry-run reports the skip and does not list the leased action in wouldRun', async () => {
  const io = memIo(1000);
  const res = await runCli(['--dry-run', '--skip-branch', 'feat/live'],
    deps(io, fakeExec(), [push('feat/live'), push('feat/idle')]));
  assert.deepEqual(res.output.wouldRun, [['git', '-C', '/w/feat/idle', 'push', '-u', 'origin', 'feat/idle']]);
  assert.equal(res.output.leasedSkipped.count, 1);
  assert.deepEqual(res.output.leasedSkipped.branches, ['feat/live']);
});

// A draft PR is handed to a model, which then pushes and opens against that
// branch. Leaving it in `draftsPending` routes the same mutation around the
// guard by way of the skill.
test('a leased branch is not offered for a draft PR either', async () => {
  const io = memIo(1000);
  const res = await runCli(['drafts', '--skip-branch', 'feat/live'],
    deps(io, fakeExec(), [draft('feat/live'), draft('feat/idle')]));
  assert.deepEqual(res.output.map(d => d.head), ['feat/idle']);
});

test('running a leased action by id refuses with `leased`, not `no-such-action`', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const a = push('feat/live');
  const res = await runCli(['action', a.id, '--skip-branch', 'feat/live'], deps(io, exec, [a]));
  assert.equal(res.exit, 3);
  assert.equal(res.output.reason, 'leased');
  assert.deepEqual(exec.calls, []);
});

test('no --skip-branch leaves every action where it was', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli([], deps(io, exec, [push('feat/a'), push('feat/b')]));
  assert.equal(res.output.actions.ran, 2);
  assert.equal(res.output.actions.leasedSkipped.count, 0);
  assert.deepEqual(res.output.actions.leasedSkipped.branches, []);
});

// A branch name is not a shell word: one flag per branch is what lets a name
// with a space or a quote in it arrive intact.
test('a branch name with shell metacharacters is matched literally', () => {
  const a = push("feat/it's a; branch");
  assert.deepEqual(skipLeased([a], ["feat/it's a; branch"]).skipped, [a]);
  assert.deepEqual(skipLeased([a], ['feat/it']).run, [a]);
});

// The process key names the process and the worktree's branch names the
// worktree; a lease that names either one has to cover the action.
test('a lease on the process key covers an action whose branch differs', () => {
  const a = { id: 'x', kind: 'push', processKey: 'feat/parent', repo: 'r', branch: 'feat/child', argv: ['git'] };
  assert.deepEqual(skipLeased([a], ['feat/parent']).skipped, [a]);
  assert.deepEqual(skipLeased([a], ['feat/child']).skipped, [a]);
});

// An unrelated branch must not be swept up by a prefix or substring match.
test('a lease on a branch that merely prefixes another does not cover it', () => {
  const a = push('feat/live-2');
  assert.deepEqual(skipLeased([a], ['feat/live']).run, [a]);
  assert.deepEqual(skipLeased([a], ['feat/live']).skipped, []);
});

test('a prunable worktree carries a null branch and is never swept up by a lease', () => {
  const a = { id: 'prune:x', kind: 'prune-worktree', processKey: 'feat/gone', repo: 'r', branch: null, argv: ['git'] };
  assert.deepEqual(skipLeased([a], ['feat/other']).run, [a]);
  assert.deepEqual(skipLeased([a], ['feat/gone']).skipped, [a]);
});

test('a degraded pass still reports what was leased', async () => {
  const io = memIo(1000);
  const res = await runCli(['--skip-branch', 'feat/live'], {
    io, exec: fakeExec(), paths: queuePaths('/s'), now: () => 1000,
    loadGate: async () => ({ gate: gate([push('feat/live')]), warnings: [{ step: 'gh-prs', error: 'boom' }] }),
  });
  assert.equal(res.exit, 4);
  assert.equal(res.output.actions.leasedSkipped.count, 1);
});

// `--skip-branch` is the last flag on the line; a missing value must not eat
// the subcommand that follows it or silently lease the empty string.
test('a --skip-branch with no value adds nothing', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli(['--skip-branch'], deps(io, exec, [push('feat/a')]));
  assert.equal(res.output.actions.ran, 1);
  assert.equal(res.output.actions.leasedSkipped.count, 0);
});

// The questions belong to the caller: it renders a leased one as work in
// progress, which is information the drain would throw away by filtering it.
test('the question queue is untouched by a lease', async () => {
  const io = memIo(1000);
  const cold = { type: 'question', key: 'cold:feat/live', processKey: 'feat/live',
    question: 'feat/live has not been touched in 14 days. What do I do?', header: 'Cold',
    options: [{ label: 'Resume', description: '…' }, { label: 'Leave it', description: '…' }] };
  const res = await runCli(['--skip-branch', 'feat/live'], {
    io, exec: fakeExec(), paths: queuePaths('/s'), now: () => 1000,
    loadGate: async () => ({ gate: { version: 1, generatedAt: 0, actions: [push('feat/live')], questions: [cold], ask: [cold], notify: [] }, warnings: [] }),
  });
  assert.equal(res.output.questions.synced, 1);
  assert.equal(io.exists(`${queuePaths('/s').items}/${itemId(cold)}.json`), true);
});
