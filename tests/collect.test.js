const { test } = require('node:test');
const assert = require('node:assert');
const { collect } = require('../collect.js');

const NOW = 1785000000000;

// Builds the stdout of `git log --format=%P%x00%s origin/<base>..HEAD`:
// newest commit first, one line per commit ahead of base. Each entry is
// either a plain subject string (a normal, single-parent commit) or the
// result of merge(subject) (a merge commit — two parents), so tests can
// express which of several commits in a range is the one that should be
// skipped when picking lastCommitSubject.
function rangeLog(...entries) {
  return entries.map((e) => {
    const isMerge = e !== null && typeof e === 'object' && e.merge === true;
    const subject = isMerge ? e.subject : e;
    const parents = isMerge ? 'p1 p2' : 'p1';
    return `${parents}\x00${subject}`;
  }).join('\n');
}

function merge(subject) {
  return { merge: true, subject };
}

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
      JSON.stringify({ type: 'ai-title', aiTitle: 'Review GitHub pull request 133 adversarially' }),
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
      if (a.includes('log -1')) return Math.floor((NOW - 3600000) / 1000) + '\x00chore: do the thing';
      if (a.includes('..HEAD')) return rangeLog('chore: do the thing', 'earlier work');
      if (a.includes('remote get-url')) return 'git@github.com:HumandDev/humand-web.git\n';
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
      if (a.includes('..HEAD')) return '';
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

test('collect de-duplicates a worktree path reported by more than one repo scan', async () => {
  // Guards against a repo-discovery regression (e.g. a linked worktree being
  // treated as its own "repo") re-reporting the same worktree via a second
  // `git worktree list` scan. The payload must never contain a duplicate path,
  // even if discovery misbehaves.
  const { opts } = harness({
    listDirs: async () => ['humand-web', 'humand-web--dup'],
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        // Both "repos" report the exact same worktree set, as would happen if
        // the second is really just a linked worktree of the first.
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/feat/SQSH-3851-web-ai\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      if (a.includes('..HEAD')) return '';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes.flatMap(p => p.worktrees);
  assert.equal(wt.length, 1);
  assert.equal(wt[0].path, '/w/humand-web');
});

test('collect drops a worktree sitting on its own base branch', async () => {
  // Grouping is by branch name, so a base-branch worktree is not just noise —
  // it would collapse every repo sitting on `main`/`develop` into one process.
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/develop\n\n' +
               'worktree /w/humand-web-feat\nHEAD def\nbranch refs/heads/feat/SQSH-3851-web-ai\n';
      }
      // Real `git symbolic-ref` output ends in a newline — exercise the
      // integration path with the same shape real git actually produces.
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop\n';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      if (a.includes('..HEAD')) return '';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes.flatMap(p => p.worktrees);
  assert.equal(wt.length, 1);
  assert.equal(wt[0].path, '/w/humand-web-feat');
});

// The base-branch filter above is what usually hides a main checkout, but it
// only fires when that checkout sits on `main`/`develop`. Parked on a feature
// branch it survives into the payload — and it is the one row that cannot be
// `git worktree remove`d (exit 128). Real case: hu-translations' and
// material-hu's main checkouts, both left on merged feature branches.
test('collect marks a primary checkout on a feature branch as isPrimary', async () => {
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/hu-translations\nHEAD abc\nbranch refs/heads/feat/SQSH-3954-translations\n\n' +
               'worktree /w/hu-translations/.worktrees/other\nHEAD def\nbranch refs/heads/fix/CSBM-5716-heic\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop\n';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      if (a.includes('..HEAD')) return '';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const byPath = new Map(out.processes.flatMap(p => p.worktrees).map(w => [w.path, w]));
  assert.equal(byPath.size, 2);
  assert.equal(byPath.get('/w/hu-translations').isPrimary, true);
  assert.equal(byPath.get('/w/hu-translations/.worktrees/other').isPrimary, false);
});

test('collect keeps every worktree when the base branch cannot be derived', async () => {
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/develop\n\n' +
               'worktree /w/humand-web-feat\nHEAD def\nbranch refs/heads/feat/SQSH-3851-web-ai\n';
      }
      if (a.includes('symbolic-ref')) throw new Error('no origin/HEAD');
      // Neither of these is in the develop/main/master fallback list, so
      // pickBaseBranch returns null.
      if (a.includes('for-each-ref')) return 'trunk\nrelease\n';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes.flatMap(p => p.worktrees);
  assert.equal(wt.length, 2);
  assert.deepEqual(wt.map(w => w.path).sort(), ['/w/humand-web', '/w/humand-web-feat']);
});

test('collect keeps a detached worktree in a repo whose base branch is derivable', async () => {
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/develop\n\n' +
               'worktree /w/humand-web-detached\nHEAD def\ndetached\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      if (a.includes('..HEAD')) return '';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes.flatMap(p => p.worktrees);
  assert.equal(wt.length, 1);
  assert.equal(wt[0].path, '/w/humand-web-detached');
  assert.equal(wt[0].detached, true);
});

test('collect never fails closed when the workspace root cannot be read (e.g. a typo\'d PRQ_WORKSPACE)', async () => {
  const { opts } = harness({
    listDirs: async () => { throw new Error('ENOENT: no such file or directory, scandir \'/w\''); },
  });

  const out = await collect(opts);

  // Exits with a well-formed payload rather than rejecting.
  assert.equal(out.generatedAt, NOW);
  assert.equal(out.workspaceRoot, '/w');
  assert.deepEqual(out.processes, []);

  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0].message, /PRQ_WORKSPACE/);
  assert.match(out.warnings[0].message, /\/w/);

  // Sessions don't depend on the workspace root being readable — the one
  // session the harness produces still comes through, just as a loose
  // session since there are no worktrees left to attach it to.
  assert.equal(out.looseSessions.length, 1);
  assert.equal(out.looseSessions[0].sessionId, 's1');
});

test('collect carries aiTitle through onto the session', async () => {
  const { opts } = harness();
  const [p] = (await collect(opts)).processes;
  assert.equal(p.sessions[0].aiTitle, 'Review GitHub pull request 133 adversarially');
});

test('collect puts lastCommitSubject, githubRepo, and baseBranch on the worktree row', async () => {
  const { opts } = harness();
  const [p] = (await collect(opts)).processes;
  const wt = p.worktrees[0];
  assert.equal(wt.lastCommitSubject, 'chore: do the thing');
  assert.equal(wt.githubRepo, 'HumandDev/humand-web');
  assert.equal(wt.baseBranch, 'develop');
});

test('collect takes lastCommitSubject from the branch\'s own commits, not from HEAD', async () => {
  // HEAD's subject and the range's newest subject are deliberately different
  // here so a regression that reads HEAD's subject instead of the range's
  // gets caught, not accidentally passed by both happening to match.
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/feat/SQSH-3851-web-ai\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return Math.floor(NOW / 1000) + '\x00chore: unrelated colleague commit';
      if (a.includes('..HEAD')) return rangeLog('fix audience update (#11916)', 'wip');
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes[0].worktrees[0];
  assert.equal(wt.lastCommitSubject, 'fix audience update (#11916)');
  assert.equal(wt.unpushed, 2);
});

test('collect reports lastCommitSubject as null with 0 commits ahead of base, while lastCommit keeps HEAD\'s timestamp', async () => {
  // This is the reported bug: a worktree freshly created on develop's tip,
  // sitting on a colleague's commit with zero commits of its own. The panel
  // must not invent a description from that commit.
  const headTs = Math.floor(NOW / 1000);
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\n' +
               'branch refs/heads/fix/no-ticket-groups-notifications-config\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return headTs + '\x00fix audience update (#11916)';
      if (a.includes('..HEAD')) return '';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes[0].worktrees[0];
  assert.equal(wt.unpushed, 0);
  assert.equal(wt.lastCommitSubject, null);
  assert.equal(wt.lastCommit, headTs * 1000);
});

test('collect skips a merge commit and takes the subject from the next non-merge commit', async () => {
  // Real case hit on the actual machine: the newest commit in range was
  // "Merge remote-tracking branch 'origin/main' into ..." — a genuine commit
  // of the owner's, but not a description of their work. The owner merges the
  // base branch into feature branches routinely, so this recurs.
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\n' +
               'branch refs/heads/chore/no-ticket-askuserquestion-prompts\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/main';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return Math.floor(NOW / 1000) + '\x00chore: unrelated';
      if (a.includes('..HEAD')) {
        return rangeLog(
          merge("Merge remote-tracking branch 'origin/main' into chore/no-ticket-askuserquestion-prompts"),
          'add the actual prompt change',
          'wip',
        );
      }
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes[0].worktrees[0];
  assert.equal(wt.lastCommitSubject, 'add the actual prompt change');
  assert.equal(wt.unpushed, 3);
});

test('collect reports lastCommitSubject as null when every commit in range is a merge, while lastCommit and unpushed are unaffected', async () => {
  const headTs = Math.floor(NOW / 1000);
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/chore/merges-only\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/main';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return headTs + '\x00Merge remote-tracking branch \'origin/main\' into chore/merges-only';
      if (a.includes('..HEAD')) {
        return rangeLog(
          merge("Merge remote-tracking branch 'origin/main' into chore/merges-only"),
          merge('Merge remote-tracking branch \'origin/main\' into chore/merges-only (2)'),
        );
      }
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes[0].worktrees[0];
  assert.equal(wt.lastCommitSubject, null);
  assert.equal(wt.lastCommit, headTs * 1000);
  assert.equal(wt.unpushed, 2);
});

test('collect falls back to HEAD\'s subject when no base branch can be derived', async () => {
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
      if (a.includes('log -1')) return Math.floor(NOW / 1000) + '\x00chore: only signal we have';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes[0].worktrees[0];
  assert.equal(wt.baseBranch, null);
  assert.equal(wt.lastCommitSubject, 'chore: only signal we have');
});

test('collect records a warning and sets githubRepo null when git remote throws', async () => {
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') {
        return JSON.stringify([{ pid: 1, cwd: '/w/humand-web', kind: 'interactive',
          startedAt: NOW - 1000, sessionId: 's1', name: 'humand-09', status: 'idle' }]);
      }
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/feat/SQSH-3851-web-ai\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      if (a.includes('..HEAD')) return '';
      if (a.includes('remote get-url')) throw new Error('No such remote origin');
      return '';
    },
  });
  const out = await collect(opts);
  const wt = out.processes[0].worktrees[0];
  assert.equal(wt.githubRepo, null);
  assert.ok(out.warnings.some(w => w.repo === 'humand-web' && w.step === 'githubRemote'));
  // The run still succeeds end-to-end despite the failed remote lookup.
  assert.equal(out.processes.length, 1);
});

test('collect sets onOrigin true for a branch present in the remote-ref set, false for one absent', async () => {
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/feat/on-origin\n\n' +
               'worktree /w/humand-web-2\nHEAD def\nbranch refs/heads/feat/not-on-origin\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      if (a.includes('for-each-ref')) return 'develop\nfeat/on-origin\n';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      if (a.includes('..HEAD')) return '';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes.flatMap(p => p.worktrees);
  const onOriginBranch = wt.find(w => w.branch === 'feat/on-origin');
  const notOnOriginBranch = wt.find(w => w.branch === 'feat/not-on-origin');
  assert.equal(onOriginBranch.onOrigin, true);
  assert.equal(notOnOriginBranch.onOrigin, false);
});

test('collect sets onOrigin false for a detached worktree and for a prunable one, even when the remote set would otherwise match', async () => {
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web-detached\nHEAD def\ndetached\n\n' +
               'worktree /w/humand-web-gone\nHEAD ghi\nbranch refs/heads/feat/gone\n' +
               'prunable gitdir file points to non-existent location\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      // feat/gone IS in the remote set — proves prunable forces false rather
      // than falling through to a set-membership check.
      if (a.includes('for-each-ref')) return 'develop\nfeat/gone\n';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      if (a.includes('..HEAD')) return '';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes.flatMap(p => p.worktrees);
  const detached = wt.find(w => w.path === '/w/humand-web-detached');
  const gone = wt.find(w => w.path === '/w/humand-web-gone');
  assert.equal(detached.onOrigin, false);
  assert.equal(gone.onOrigin, false);
});

test('collect sets onOrigin null and records a warning when for-each-ref fails, without failing the run', async () => {
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/feat/x\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      if (a.includes('for-each-ref')) throw new Error('fatal: not a git repository');
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      if (a.includes('..HEAD')) return '';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes[0].worktrees[0];
  assert.equal(wt.onOrigin, null);
  assert.ok(out.warnings.some(w => w.repo === 'humand-web' && w.step === 'originBranches'));
  // The run still succeeds end-to-end despite the failed for-each-ref call.
  assert.equal(out.processes.length, 1);
});

test('collect requires exact branch-name membership: a near-miss name must not match', async () => {
  // Remote has `feat/x`; the worktree is on `feat/x-2`. A prefix/substring
  // match here would be a false "onOrigin: true" for a branch that isn't
  // actually on the remote.
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/feat/x-2\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      if (a.includes('for-each-ref')) return 'feat/x\n';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      if (a.includes('..HEAD')) return '';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes[0].worktrees[0];
  assert.equal(wt.onOrigin, false);
});

test('collect matches branch membership case-insensitively', async () => {
  // Regression test for the real case hit on this machine: a repo with
  // core.ignorecase=true had a local refs/remotes/origin/Chore/SQSH-4074-...
  // left over from before the remote branch settled on lowercase
  // chore/SQSH-4074-...; git ls-remote against GitHub confirmed the real
  // branch is lowercase and matches the worktree. A case-sensitive compare
  // called this `onOrigin: false` — a false claim the UI would use to hide a
  // working compare link.
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\n' +
               'branch refs/heads/chore/SQSH-4074-web-feed-groups-color-tokens-dark-mode\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      if (a.includes('for-each-ref')) return 'Chore/SQSH-4074-web-feed-groups-color-tokens-dark-mode\n';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      if (a.includes('..HEAD')) return '';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes[0].worktrees[0];
  assert.equal(wt.onOrigin, true);
  // Case-insensitive matching must not change the branch value itself.
  assert.equal(wt.branch, 'chore/SQSH-4074-web-feed-groups-color-tokens-dark-mode');
});

test('collect keeps onOrigin false when case differs AND the name genuinely differs', async () => {
  // Case-insensitivity must not become fuzzy matching: `Feat/X` in the set
  // does not make `feat/x-2` a match.
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/feat/x-2\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      if (a.includes('for-each-ref')) return 'Feat/X\n';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      if (a.includes('..HEAD')) return '';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes[0].worktrees[0];
  assert.equal(wt.onOrigin, false);
});

// The payload must carry WHAT is uncommitted, not only how much: a consumer that
// asks "commit this?" is unanswerable with a bare count.
test('collect carries a sample of the dirty paths alongside the count', async () => {
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web-feat\nHEAD abc\nbranch refs/heads/feat/SQSH-3954\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop\n';
      if (a.startsWith('status')) return ' M src/hooks/useCommunityFeature.ts\n?? scratch.md\n';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      if (a.includes('..HEAD')) return '';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes.flatMap(p => p.worktrees)[0];
  assert.equal(wt.dirty, 2);
  assert.deepEqual(wt.dirtyFiles, [
    { code: 'M', path: 'src/hooks/useCommunityFeature.ts' },
    { code: '??', path: 'scratch.md' },
  ]);
});

test('collect leaves dirtyFiles empty for a prunable worktree', async () => {
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/gone\nHEAD abc\nbranch refs/heads/feat/x\nprunable gitdir missing\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop\n';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes.flatMap(p => p.worktrees)[0];
  assert.deepEqual(wt.dirtyFiles, []);
  assert.equal(wt.dirty, null);
});
