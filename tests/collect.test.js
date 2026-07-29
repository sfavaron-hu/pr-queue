const { test } = require('node:test');
const assert = require('node:assert');
const { collect } = require('../collect.js');

const NOW = 1785000000000;

function harness(over) {
  const calls = [];
  const base = {
    env: {}, homeDir: '/home/dev', checkoutDir: '/w/pr-queue', now: () => NOW,
    listDirs: async () => ['humand-web'],
    listFiles: async (dir) => dir.endsWith('projects') ? ['-w-humand-web'] : ['s1.jsonl'],
    readTail: async () => [
      JSON.stringify({ type: 'user', cwd: '/w/humand-web',
                       timestamp: new Date(NOW - 7200000).toISOString() }),
      JSON.stringify({ type: 'pr-link', prNumber: 9294, prRepository: 'HumandDev/humand-web',
                       prUrl: 'https://github.com/HumandDev/humand-web/pull/9294',
                       timestamp: new Date(NOW - 7200000).toISOString() }),
      JSON.stringify({ type: 'ai-title' }),
    ].join('\n'),
    run: async (cmd, args) => {
      calls.push([cmd, args.join(' ')]);
      if (cmd === 'claude') {
        return JSON.stringify([{ pid: 1, cwd: '/w/humand-web', kind: 'interactive',
          startedAt: NOW - 1000, sessionId: 's1', name: 'humand-09', status: 'idle' }]);
      }
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/feat/SQSH-3851-web-ai\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      if (a.startsWith('status')) return ' M src/a.ts\n';
      if (a.includes('log -1')) return String(Math.floor((NOW - 3600000) / 1000));
      if (a.includes('rev-list')) return '2';
      return '';
    },
  };
  return { opts: Object.assign(base, over), calls };
}

test('collect returns the payload contract', async () => {
  const { opts } = harness();
  const out = await collect(opts);
  assert.equal(out.generatedAt, NOW);
  assert.equal(out.workspaceRoot, '/w');
  assert.deepEqual(out.warnings, []);
  assert.equal(out.processes.length, 1);
});

test('collect groups the worktree and session into one ticket process', async () => {
  const { opts } = harness();
  const [p] = (await collect(opts)).processes;
  assert.equal(p.key, 'SQSH-3851');
  assert.equal(p.ticket, 'SQSH-3851');
  assert.equal(p.worktrees.length, 1);
  assert.equal(p.worktrees[0].repo, 'humand-web');
  assert.equal(p.worktrees[0].dirty, 1);
  assert.equal(p.worktrees[0].unpushed, 2);
  assert.equal(p.sessions.length, 1);
  assert.equal(p.sessions[0].resumeCmd, 'claude --resume s1');
});

test('collect takes session activity from the transcript, not the agent startedAt', async () => {
  const { opts } = harness();
  const [p] = (await collect(opts)).processes;
  assert.equal(p.sessions[0].lastActivity, NOW - 7200000);
});

test('collect carries the pr-link through', async () => {
  const { opts } = harness();
  const [p] = (await collect(opts)).processes;
  assert.equal(p.sessions[0].prLink.number, 9294);
  assert.equal(p.sessions[0].prLink.repo, 'HumandDev/humand-web');
});

test('collect never reads a whole transcript', async () => {
  // Guards against someone swapping readTail for a full readFile.
  const seen = [];
  const { opts } = harness();
  const wrapped = Object.assign({}, opts, {
    readTail: async (p, bytes) => { seen.push(bytes); return ''; },
  });
  await collect(wrapped);
  assert.ok(seen.length > 0, 'readTail must be called');
  assert.ok(seen.every(b => b === 65536), `expected 64KB reads, got ${seen}`);
});

test('collect puts a workspace-root session in looseSessions, not in a process', async () => {
  const { opts } = harness({
    readTail: async () => JSON.stringify({
      type: 'user', cwd: '/w', timestamp: new Date(NOW - 3600000).toISOString() }),
  });
  const out = await collect(opts);
  assert.equal(out.looseSessions.length, 1);
  assert.equal(out.processes.every(p => p.sessions.length === 0), true);
  // The failure mode being guarded: a process keyed by the workspace root.
  assert.equal(out.processes.some(p => p.key === '/w'), false);
});

test('collect falls back to startedAt for a session with no transcript', async () => {
  const { opts } = harness({ listFiles: async () => [] });
  const out = await collect(opts);
  const all = out.processes.flatMap(p => p.sessions).concat(out.looseSessions);
  assert.equal(all.length, 1);
  assert.equal(all[0].lastActivity, NOW - 1000);
});

test('collect records a warning and keeps going when a repo throws', async () => {
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      if (args.join(' ').startsWith('worktree list')) throw new Error('not a git repo');
      return '';
    },
  });
  const out = await collect(opts);
  assert.equal(out.processes.length, 0);
  assert.equal(out.warnings.length, 1);
  assert.equal(out.warnings[0].repo, 'humand-web');
  assert.equal(out.warnings[0].step, 'worktrees');
});

test('collect survives claude being absent', async () => {
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') throw new Error('command not found');
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/feat/SQSH-3851-web-ai\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      if (a.includes('rev-list')) return '0';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  assert.equal(out.processes.length, 1);
  assert.equal(out.processes[0].sessions.length, 0);
  assert.ok(out.warnings.some(w => w.step === 'agents'));
});

test('collect skips git detail for prunable worktrees', async () => {
  const { opts, calls } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/gone\nHEAD abc\nbranch refs/heads/feat/SQSH-7-gone\n' +
               'prunable gitdir file points to non-existent location\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes[0].worktrees[0];
  assert.equal(wt.prunable, true);
  assert.equal(wt.dirty, null);
  assert.equal(wt.lastCommit, null);
  assert.equal(calls.some(c => c[1].startsWith('status')), false);
});

test('collect reports unpushed as null when no base branch can be derived', async () => {
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/feat/SQSH-3851-web-ai\n';
      }
      if (a.includes('symbolic-ref')) throw new Error('no origin/HEAD');
      if (a.includes('for-each-ref')) return 'trunk\nrelease\n';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  assert.equal(out.processes[0].worktrees[0].unpushed, null);
});
