const { test } = require('node:test');
const assert = require('node:assert');
const { buildItems, questionFor } = require('../assist/gate.js');

const flags = (over) => Object.assign(
  { notOnOrigin: false, dirty: false, prunable: false, cold: false, noTicket: false,
    sessionIdle: false, hasOpenPR: false, hasDraftPR: false, hasMergedPR: false,
    mergedWithLiveWorktree: false }, over);
const wt = (over) => Object.assign({ repo: 'r', branch: 'feat/x', unpushed: 0, onOrigin: true, dirty: 0 }, over);
const proc = (over) => Object.assign(
  { key: 'SQSH-1', ticket: 'SQSH-1', worktrees: [], prs: [], lastLocalActivity: 0, flags: flags() }, over);
const ledger = (processes) => ({ processes, workspaceRoot: '/w' });

const renderable = (q) => {
  assert.ok(q.options.length >= 2 && q.options.length <= 4, 'options 2..4');
  q.options.forEach(o => { assert.ok(o.label && o.description, 'label+description'); });
  assert.ok(q.header.length <= 12, `header <=12: "${q.header}"`);
  assert.ok(/\?$/.test(q.question), 'ends with ?');
};

test('a dirty worktree produces a renderable question, not an action', () => {
  const q = questionFor(proc({ worktrees: [wt({ dirty: 3 })], flags: flags({ dirty: true }) }), ledger([]));
  assert.equal(q.type, 'question');
  renderable(q);
  assert.match(q.question, /sin commitear/);
});

test('a cold process produces the worked-example question', () => {
  const q = questionFor(proc({
    key: 'fix/no-ticket-tiptap-v3', ticket: null,
    worktrees: [wt({ branch: 'fix/no-ticket-tiptap-v3', unpushed: 9 })],
    flags: flags({ cold: true }) }), ledger([]));
  renderable(q);
  assert.equal(q.header, 'Frío');
  assert.match(q.options.map(o => o.label).join(','), /Retomar/);
  assert.match(q.options.find(o => o.label === 'Retomar').description, /9 commits/);
});

test('dirty takes priority over cold', () => {
  const q = questionFor(proc({ worktrees: [wt({ dirty: 1 })], flags: flags({ dirty: true, cold: true }) }), ledger([]));
  assert.match(q.question, /sin commitear/);
});

test('a process needing no decision yields no question', () => {
  assert.equal(questionFor(proc({ flags: flags() }), ledger([])), null);
});

// The budget bounds what the owner is SHOWN, never what the queue persists.
// Truncating the persisted list deleted items that had merely fallen out of the
// top 4, and answers written against their ids came back `no-item` — a decision
// the owner had already made, silently lost.
test('the budget caps what is asked but never what is emitted', () => {
  const procs = [];
  for (let i = 0; i < 6; i++) {
    procs.push(proc({ key: 'p' + i, worktrees: [wt({ dirty: 1 })], flags: flags({ dirty: true }), lastLocalActivity: i }));
  }
  const { questions, ask } = buildItems(ledger(procs), [], []);
  assert.equal(ask.length, 4, 'at most 4 in front of the owner');
  assert.equal(questions.length, 6, 'every situation still persists');
  // `ask` must be a prefix of `questions`, so the same ordering decides both.
  assert.deepEqual(ask, questions.slice(0, 4));
});

test('questions order by unblock score, then recency', () => {
  const procs = [
    proc({ key: 'low',  worktrees: [wt({ dirty: 1 })], flags: flags({ dirty: true }), lastLocalActivity: 100 }),
    proc({ key: 'high', worktrees: [wt({ dirty: 1 })], flags: flags({ dirty: true }), lastLocalActivity: 1 }),
  ];
  // 'high' has 2 actions on it, 'low' has 0 → 'high' first despite older recency
  const actions = [{ processKey: 'high' }, { processKey: 'high' }];
  const { questions } = buildItems(ledger(procs), actions, []);
  assert.equal(questions[0].processKey, 'high');
});

test('every emitted question is AskUserQuestion-renderable', () => {
  const procs = [
    proc({ key: 'd', worktrees: [wt({ dirty: 2 })], flags: flags({ dirty: true }) }),
    proc({ key: 'c', ticket: null, worktrees: [wt({ unpushed: 4 })], flags: flags({ cold: true }) }),
  ];
  const { questions } = buildItems(ledger(procs), [], []);
  assert.equal(questions.length, 2);
  questions.forEach(renderable);
});

test('notify items pass through untouched and unbudgeted', () => {
  const notify = [{ type: 'notify', key: 'babysit:comments', message: 'x', source: 'pr-babysit' }];
  const { notify: out } = buildItems(ledger([]), [], notify);
  assert.deepEqual(out, notify);
});

const fs = require('node:fs');
const path = require('node:path');

// --- Huérfano: PR done but local-only work (two changes from real use) ---
test('orphan question fires when a merged PR leaves unpushed local commits', () => {
  const q = questionFor(proc({
    worktrees: [wt({ unpushedLocal: 3, isPrimary: false })],
    prs: [{ number: 9577, merged: true, closed: false }], flags: flags() }), ledger([]));
  assert.equal(q.type, 'question');
  assert.equal(q.header, 'Huérfano');
  assert.match(q.key, /^orphan:/);
  renderable(q);
  assert.match(q.question, /sin pushear/);
  const labels = q.options.map(o => o.label);
  assert.deepEqual(labels, ['Nuevo PR', 'Descartar', 'Dejar']);
  const d = q.options.find(o => o.label === 'Descartar');
  assert.match(d.description, /worktree remove --force/);
  assert.match(d.description, /confirmo/i);   // destructive → must promise a confirmation
});

test('orphan fires for a closed-unmerged PR whose worktree has uncommitted work', () => {
  const q = questionFor(proc({
    worktrees: [wt({ dirty: 2, unpushedLocal: 0, isPrimary: false })],
    prs: [{ number: 6, merged: false, closed: true }], flags: flags() }), ledger([]));
  assert.equal(q.header, 'Huérfano');
});

test('orphan does NOT fire while any PR is still open', () => {
  const q = questionFor(proc({
    worktrees: [wt({ unpushedLocal: 3, isPrimary: false })],
    prs: [{ merged: true, closed: false }, { merged: false, closed: false }],
    flags: flags({ cold: true }) }), ledger([]));
  assert.notEqual(q && q.header, 'Huérfano');
});

test('orphan does NOT fire on the primary checkout (parked on base, nothing lost)', () => {
  const q = questionFor(proc({
    worktrees: [wt({ unpushedLocal: 3, isPrimary: true })],
    prs: [{ merged: true, closed: false }], flags: flags({ cold: true }) }), ledger([]));
  assert.notEqual(q && q.header, 'Huérfano');
});

test('cold offers Descartar (not Archivar) when the worktree holds only-local work', () => {
  const q = questionFor(proc({
    worktrees: [wt({ unpushed: 4, unpushedLocal: 4, isPrimary: false })],
    prs: [], flags: flags({ cold: true }) }), ledger([]));
  assert.equal(q.header, 'Frío');
  const labels = q.options.map(o => o.label);
  assert.ok(labels.includes('Descartar'), 'has Descartar');
  assert.ok(!labels.includes('Archivar'), 'no Archivar when there is local-only work to lose');
  assert.match(q.options.find(o => o.label === 'Descartar').description, /worktree remove --force/);
});

test('cold keeps plain Archivar when the worktree is clean and fully pushed', () => {
  const q = questionFor(proc({
    worktrees: [wt({ unpushed: 0, unpushedLocal: 0, isPrimary: false })],
    prs: [], flags: flags({ cold: true }) }), ledger([]));
  const labels = q.options.map(o => o.label);
  assert.ok(labels.includes('Archivar'));
  assert.ok(!labels.includes('Descartar'));
});

test('cold question pluralizes commits correctly (1 commit, 2 commits)', () => {
  const { questionFor } = require('../assist/gate.js');
  const proc = (unpushed) => ({ key: 'p1', flags: { cold: true },
    worktrees: [{ repo: 'r', branch: 'b', unpushed, onOrigin: true }], prs: [] });
  const q1 = questionFor(proc(1), { _coldDays: 14 });
  const q2 = questionFor(proc(2), { _coldDays: 14 });
  assert.match(q1.options[0].description, /\b1 commit\b/);   // singular, no trailing s
  assert.match(q2.options[0].description, /\b2 commits\b/);
});

test('the work-assistant skill states its load-bearing invariants', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', '.claude', 'skills', 'work-assistant', 'SKILL.md'), 'utf8');
  assert.match(md, /AskUserQuestion/);           // uses the one-call tool
  assert.match(md, /assist\/bin\/run\.js/);      // acts via the executor CLI, not ad-hoc shell
  assert.match(md, /subagent|Task tool/i);       // idle work → subagent
  assert.match(md, /--resume/);                  // explicitly names what NOT to do
});

// Each of these is a mistake the skill actually made on its first real run, and
// each was possible because the instruction was absent rather than wrong.
test('the skill documents what went wrong on the first real run', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', '.claude', 'skills', 'work-assistant', 'SKILL.md'), 'utf8');
  // The batch comes from `ask`, not from capping `list` (which has no ordering).
  assert.match(md, /run\.js"? ask/);
  // A main working tree cannot be removed; 128 is the symptom to recognize.
  assert.match(md, /128/);
  assert.match(md, /Ir a la base/);
  // The drain isolates failures, so a success exit can still mean nothing worked.
  assert.match(md, /actions\.results/);
  // Every exit code the drain can return, not just the degraded one.
  for (const code of ['`0`', '`10`', '`4`', '`3`']) assert.ok(md.includes(code), `exit ${code} undocumented`);
  // Drafts must be vetted: a PR may exist in any state, or the work may have
  // landed from a different branch.
  assert.match(md, /--state all/);
  // origin can be ahead of the local worktree; never push the stale local.
  assert.match(md, /BEHIND origin|behind origin/i);
  // A lone modified file is as likely to be a local-testing hack as real work.
  assert.match(md, /DO NOT COMMIT/);
  // --force is never the answer, including for a node_modules symlink.
  assert.match(md, /--force/);
  assert.match(md, /symlink/i);
});

// --- questions must carry enough evidence to be answerable -------------------
// The complaint that produced these: "no me sirve el nombre para tomar una
// decisión". A process key is a branch name, and a branch name says nothing about
// which repo, where on disk, how stale, or whether a PR already settled it.

test('a cold question names the repo, not just the branch', () => {
  const q = questionFor(proc({
    key: 'worktree-agent-af19fc7f', ticket: null,
    worktrees: [wt({ repo: 'hu-ai-agent-plugin', branch: 'worktree-agent-af19fc7f', unpushed: 38 })],
    flags: flags({ cold: true }) }), ledger([]));
  assert.match(q.question, /hu-ai-agent-plugin\/worktree-agent-af19fc7f/);
  renderable(q);
});

test('a cold question states the PR state, since that usually decides it', () => {
  const merged = questionFor(proc({
    worktrees: [wt({ unpushed: 6 })], prs: [{ number: 22, merged: true, closed: false }],
    flags: flags({ cold: true }) }), ledger([]));
  assert.match(merged.options.find(o => o.label === 'Retomar').description, /#22 mergeado/);

  const closed = questionFor(proc({
    worktrees: [wt({ unpushed: 1 })], prs: [{ number: 6, merged: false, closed: true }],
    flags: flags({ cold: true }) }), ledger([]));
  assert.match(closed.options.find(o => o.label === 'Retomar').description, /#6 cerrado sin mergear/);

  const none = questionFor(proc({
    worktrees: [wt({ unpushed: 2 })], prs: [], flags: flags({ cold: true }) }), ledger([]));
  assert.match(none.options.find(o => o.label === 'Retomar').description, /sin PR/);
});

test('a cold question reports how stale the branch actually is', () => {
  const now = 1785959522535;
  const q = questionFor(
    proc({ worktrees: [wt({ unpushed: 3, lastCommit: now - 21 * 86400000, lastCommitSubject: 'wire the resolver' })],
           flags: flags({ cold: true }) }),
    { processes: [], workspaceRoot: '/w', generatedAt: now });
  const resume = q.options.find(o => o.label === 'Retomar').description;
  assert.match(resume, /hace 21 día\(s\)/);
  assert.match(resume, /wire the resolver/);
});

// Offering `Archivar` on a main working tree hands back an option that cannot
// work: `git worktree remove` on it exits 128. The equivalent is parking it on base.
test('a cold primary checkout is offered its base branch, never worktree remove', () => {
  const q = questionFor(proc({
    worktrees: [wt({ repo: 'hu-translations', isPrimary: true, baseBranch: 'develop', unpushed: 1 })],
    prs: [{ number: 2258, merged: true, closed: false }],
    flags: flags({ cold: true }) }), ledger([]));
  const labels = q.options.map(o => o.label);
  assert.ok(!labels.includes('Archivar'), 'must not offer an impossible removal');
  assert.ok(labels.includes('Ir a la base'));
  const base = q.options.find(o => o.label === 'Ir a la base');
  assert.match(base.description, /checkout principal/);
  assert.match(base.description, /develop/);
  renderable(q);
});

test('a cold non-primary worktree still gets Archivar, with its path', () => {
  const q = questionFor(proc({
    worktrees: [wt({ path: '/w/r/.worktrees/feat-x', isPrimary: false, unpushed: 1 })],
    flags: flags({ cold: true }) }), ledger([]));
  const archive = q.options.find(o => o.label === 'Archivar');
  assert.match(archive.description, /\/w\/r\/\.worktrees\/feat-x/);
});

// "1 archivo sin commitear" is unanswerable; the real case behind this was a
// single modified file holding a `TEMP — DO NOT COMMIT` flag override.
test('a dirty question says WHICH files, with their status codes', () => {
  const q = questionFor(proc({
    worktrees: [wt({ repo: 'humand-web', dirty: 1,
                     dirtyFiles: [{ code: 'M', path: 'src/hooks/useCommunityFeature.ts' }] })],
    flags: flags({ dirty: true }) }), ledger([]));
  assert.match(q.question, /M src\/hooks\/useCommunityFeature\.ts/);
  renderable(q);
});

test('a dirty question truncates a long file list but says how many are hidden', () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ code: 'M', path: `f${i}.ts` }));
  const q = questionFor(proc({
    worktrees: [wt({ dirty: 9, dirtyFiles: files })], flags: flags({ dirty: true }) }), ledger([]));
  assert.match(q.question, /\+4 más/);
  renderable(q);
});

test('a dirty question with no file sample still reads correctly', () => {
  const q = questionFor(proc({
    worktrees: [wt({ dirty: 2, dirtyFiles: [] })], flags: flags({ dirty: true }) }), ledger([]));
  assert.match(q.question, /2 archivo\(s\) sin commitear\. ¿Qué hago\?/);
  renderable(q);
});
