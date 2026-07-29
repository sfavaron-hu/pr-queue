const { test } = require('node:test');
const assert = require('node:assert');
const { extractTicket, groupProcesses, attachSessions, COLD_DAYS } = require('../classify.js');

test('COLD_DAYS is 14', () => {
  assert.equal(COLD_DAYS, 14);
});

test('extractTicket pulls the ticket out of a branch name', () => {
  assert.equal(extractTicket('feat/SQSH-3851-web-feed-mejorar-con-ai'), 'SQSH-3851');
  assert.equal(extractTicket('fix/CSBM-5716-heic-images-fail-silently'), 'CSBM-5716');
  assert.equal(extractTicket('chore/SQXS-1920-migrate-module-feed'), 'SQXS-1920');
});

test('extractTicket returns null when there is no ticket', () => {
  assert.equal(extractTicket('chore/no-ticket-e2e-coverage-instrumentation'), null);
  assert.equal(extractTicket('develop'), null);
  assert.equal(extractTicket(null), null);
});

test('extractTicket ignores lowercase and too-short prefixes', () => {
  assert.equal(extractTicket('feat/ab-12-something'), null);
  assert.equal(extractTicket('feat/sqsh-3851-lowercase'), null);
});

test('groupProcesses collapses two repos on the same ticket into one process', () => {
  const out = groupProcesses({
    worktrees: [
      { repo: 'humand-web', path: '/w/a', branch: 'feat/SQSH-3851-web', detached: false,
        prunable: false, dirty: 0, unpushed: 1, lastCommit: 2000 },
      { repo: 'hu-translations', path: '/w/b', branch: 'feat/SQSH-3851-copy', detached: false,
        prunable: false, dirty: 0, unpushed: 0, lastCommit: 3000 },
    ],
    sessions: [],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'SQSH-3851');
  assert.equal(out[0].ticket, 'SQSH-3851');
  assert.equal(out[0].worktrees.length, 2);
  assert.equal(out[0].branches.length, 2);
});

test('groupProcesses keys a ticketless branch by branch and marks it', () => {
  const out = groupProcesses({
    worktrees: [
      { repo: 'humand-web', path: '/w/a', branch: 'chore/no-ticket-e2e', detached: false,
        prunable: false, dirty: 2, unpushed: 0, lastCommit: 1000 },
    ],
    sessions: [],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'chore/no-ticket-e2e');
  assert.equal(out[0].ticket, null);
});

test('groupProcesses attaches sessions by branch', () => {
  const out = groupProcesses({
    worktrees: [
      { repo: 'humand-web', path: '/w/a', branch: 'feat/SQSH-3851-web', detached: false,
        prunable: false, dirty: 0, unpushed: 0, lastCommit: 1000 },
    ],
    sessions: [
      { sessionId: 's1', name: 'humand-09', kind: 'interactive', status: 'idle',
        cwd: '/w/a', lastActivity: 5000, branch: 'feat/SQSH-3851-web' },
    ],
  });
  assert.equal(out[0].sessions.length, 1);
  assert.equal(out[0].sessions[0].sessionId, 's1');
  assert.equal(out[0].branches.length, 1);
  assert.equal(out[0].branches[0], 'feat/SQSH-3851-web');
});

const WT = [
  { repo: 'humand-web', path: '/w/humand-web', branch: 'develop', detached: false,
    prunable: false, dirty: 0, unpushed: 0, lastCommit: 1000 },
  { repo: 'humand-web', path: '/w/humand-web/.worktrees/chore/SQSH-3239-virtualize',
    branch: 'chore/SQSH-3239-virtualize', detached: false, prunable: false,
    dirty: 0, unpushed: 0, lastCommit: 2000 },
];

function sess(over) {
  return Object.assign({ sessionId: 's1', name: 'n', kind: 'interactive', status: 'idle',
                         cwd: '/w', lastActivity: 5000, prLink: null }, over);
}

test('attachSessions resolves a session whose cwd is a worktree', () => {
  const { attached, loose } = attachSessions(
    [sess({ cwd: '/w/humand-web/.worktrees/chore/SQSH-3239-virtualize' })], WT);
  assert.equal(loose.length, 0);
  assert.equal(attached[0].branch, 'chore/SQSH-3239-virtualize');
});

test('attachSessions resolves a nested cwd to its owning worktree', () => {
  // Sessions often sit in a subdirectory of the worktree.
  const { attached } = attachSessions(
    [sess({ cwd: '/w/humand-web/.worktrees/chore/SQSH-3239-virtualize/src/feed' })], WT);
  assert.equal(attached[0].branch, 'chore/SQSH-3239-virtualize');
});

test('attachSessions prefers the longest matching worktree path', () => {
  // /w/humand-web is a prefix of the nested worktree; the deeper one must win.
  const { attached } = attachSessions(
    [sess({ cwd: '/w/humand-web/.worktrees/chore/SQSH-3239-virtualize' })], WT);
  assert.equal(attached[0].branch, 'chore/SQSH-3239-virtualize');
});

test('attachSessions puts a workspace-root session in loose, never keyed by cwd', () => {
  const { attached, loose } = attachSessions([sess({ cwd: '/w' })], WT);
  assert.equal(attached.length, 0);
  assert.equal(loose.length, 1);
  assert.equal(loose[0].sessionId, 's1');
});

test('attachSessions puts a session with no cwd in loose', () => {
  const { attached, loose } = attachSessions([sess({ cwd: null })], WT);
  assert.equal(attached.length, 0);
  assert.equal(loose.length, 1);
});

test('attachSessions does not let a prefix match steal a sibling directory', () => {
  const wt = [{ repo: 'r', path: '/w/humand-web', branch: 'develop', detached: false,
                prunable: false, dirty: 0, unpushed: 0, lastCommit: 1 }];
  const { attached, loose } = attachSessions([sess({ cwd: '/w/humand-web-other' })], wt);
  assert.equal(attached.length, 0, 'humand-web-other must not match humand-web');
  assert.equal(loose.length, 1);
});

test('groupProcesses keeps detached worktrees as their own branchless process', () => {
  const out = groupProcesses({
    worktrees: [
      { repo: 'humand-web', path: '/w/det', branch: null, detached: true,
        prunable: false, dirty: 0, unpushed: null, lastCommit: 1000 },
    ],
    sessions: [],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].ticket, null);
  assert.equal(out[0].key, '/w/det');
  assert.equal(out[0].worktrees[0].detached, true);
});

test('groupProcesses sets lastLocalActivity to the max across worktrees and sessions', () => {
  const out = groupProcesses({
    worktrees: [
      { repo: 'humand-web', path: '/w/a', branch: 'feat/SQSH-1-x', detached: false,
        prunable: false, dirty: 0, unpushed: 0, lastCommit: 2000 },
    ],
    sessions: [
      { sessionId: 's1', name: 'n', kind: 'interactive', status: 'idle', cwd: '/w/a',
        summary: null, lastActivity: 9000, branch: 'feat/SQSH-1-x' },
    ],
  });
  assert.equal(out[0].lastLocalActivity, 9000);
});

test('groupProcesses ignores a session with no branch instead of keying it by cwd', () => {
  // The regression this guards: keying by cwd collapses every root-cwd session
  // into one meaningless process. Unattached sessions belong in looseSessions.
  const out = groupProcesses({
    worktrees: [],
    sessions: [
      { sessionId: 's1', name: 'n', kind: 'interactive', status: 'idle', cwd: '/w',
        lastActivity: 9000, branch: null },
    ],
  });
  assert.deepEqual(out, []);
});
