// IO orchestration. All effects are injected so this is testable without a
// real workspace; bin/collect.js supplies the real implementations.
const nodePath = require('node:path');
const { parseWorktrees, parseStatusShort, parseAgents,
        parseTranscriptTail } = require('./collect-parse.js');
const { resolveWorkspaceRoot, resolveClaudeDir, pickBaseBranch } = require('./collect-paths.js');
const { groupProcesses, attachSessions } = require('./classify.js');

async function collectRepo(repo, repoPath, run, warn) {
  let worktrees;
  try {
    worktrees = parseWorktrees(await run('git', ['worktree', 'list', '--porcelain'], repoPath));
  } catch (e) {
    warn(repo, 'worktrees', e.message);
    return [];
  }

  let base = null;
  try {
    // Real `git symbolic-ref` output ends in a trailing newline that
    // pickBaseBranch's anchored regex won't match through — trim before
    // handing it off, or base silently comes back null for every repo.
    const headRef = (await run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], repoPath)).trim();
    base = pickBaseBranch(headRef, []);
  } catch {
    try {
      const refs = await run('git', ['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin'], repoPath);
      base = pickBaseBranch(null, refs.split('\n').map(s => s.trim()).filter(Boolean));
    } catch (e) {
      warn(repo, 'baseBranch', e.message);
    }
  }

  // A worktree on its repo's own base branch is not work in progress. Keeping
  // them is actively misleading: grouping is by branch name, so every repo
  // sitting on `main` collapses into one process merging unrelated repos.
  // Detached worktrees have no branch and are kept; so is everything in a repo
  // whose base branch could not be derived, since there is nothing to compare.
  const active = base
    ? worktrees.filter(wt => wt.branch !== base)
    : worktrees;

  return Promise.all(active.map(async (wt) => {
    const row = { repo, path: wt.path, branch: wt.branch, detached: wt.detached,
                  prunable: wt.prunable, dirty: null, unpushed: null, lastCommit: null };
    // A prunable worktree's directory is gone — running git in it would just fail.
    if (wt.prunable) return row;

    try {
      row.dirty = parseStatusShort(await run('git', ['status', '--short'], wt.path));
    } catch (e) { warn(repo, 'status', e.message); }

    try {
      const secs = (await run('git', ['log', '-1', '--format=%ct'], wt.path)).trim();
      if (secs) row.lastCommit = Number(secs) * 1000;
    } catch (e) { warn(repo, 'lastCommit', e.message); }

    if (base && wt.branch) {
      try {
        const n = (await run('git', ['rev-list', '--count', `origin/${base}..HEAD`], wt.path)).trim();
        if (n) row.unpushed = Number(n);
      } catch (e) { warn(repo, 'unpushed', e.message); }
    }
    return row;
  }));
}

const TAIL_BYTES = 64 * 1024;

// Builds sessionId -> transcript path by scanning the project dirs. Probed at
// 1271 transcripts across 99 dirs; one readdir each, so this is cheap.
async function indexTranscripts(claudeDir, listFiles, warn) {
  const index = new Map();
  const projects = nodePath.join(claudeDir, 'projects');
  let dirs;
  try {
    dirs = await listFiles(projects);
  } catch (e) {
    warn(null, 'transcriptIndex', e.message);
    return index;
  }
  await Promise.all(dirs.map(async (d) => {
    let files;
    try { files = await listFiles(nodePath.join(projects, d)); } catch { return; }
    files.forEach(f => {
      if (f.endsWith('.jsonl')) {
        index.set(f.slice(0, -'.jsonl'.length), nodePath.join(projects, d, f));
      }
    });
  }));
  return index;
}

async function collectSessions(agents, claudeDir, deps, warn) {
  const { listFiles, readTail } = deps;
  const index = await indexTranscripts(claudeDir, listFiles, warn);

  return Promise.all(agents.map(async (a) => {
    const base = {
      sessionId: a.sessionId, name: a.name, kind: a.kind, status: a.status,
      cwd: a.cwd, lastActivity: a.startedAt, prLink: null, branch: null,
      resumeCmd: `claude --resume ${a.sessionId}`,
    };

    const file = index.get(a.sessionId);
    if (!file) return base;  // observed for background agents; not an error

    let tail;
    try {
      tail = await readTail(file, TAIL_BYTES);
    } catch (e) {
      warn(null, 'transcript', e.message);
      return base;
    }

    const { lastTs, lastCwd, prLink } = parseTranscriptTail(tail);
    return Object.assign(base, {
      // NEVER the file mtime: bookkeeping records bump it by hours or days.
      lastActivity: lastTs !== null ? lastTs : a.startedAt,
      cwd: lastCwd || a.cwd,
      prLink,
    });
  }));
}

async function collect(opts) {
  const { env, homeDir, checkoutDir, run, listDirs, listFiles, readTail, now } = opts;
  const warnings = [];
  const warn = (repo, step, message) => warnings.push({ repo, step, message });

  const workspaceRoot = resolveWorkspaceRoot(env, checkoutDir);
  const claudeDir = resolveClaudeDir(env, homeDir);

  let agents = [];
  try {
    agents = parseAgents(await run('claude', ['agents', '--json'], workspaceRoot));
  } catch (e) {
    warn(null, 'agents', e.message);
  }

  const repos = await listDirs(workspaceRoot);
  const [perRepo, rawSessions] = await Promise.all([
    Promise.all(repos.map(repo =>
      collectRepo(repo, nodePath.join(workspaceRoot, repo), run, warn))),
    collectSessions(agents, claudeDir, { listFiles, readTail }, warn),
  ]);

  // Backstop: a worktree can be re-reported by more than one repo scan (e.g. if
  // repo discovery regresses and a linked worktree gets treated as its own
  // repo, `git worktree list` from there reports the whole set again). Never
  // let a duplicate path reach the payload, regardless of discovery. Keep the
  // first occurrence.
  const seenPaths = new Set();
  const worktrees = perRepo.flat().filter(wt => {
    if (seenPaths.has(wt.path)) return false;
    seenPaths.add(wt.path);
    return true;
  });
  const { attached, loose } = attachSessions(rawSessions, worktrees);

  return {
    generatedAt: now(),
    workspaceRoot,
    warnings,
    processes: groupProcesses({ worktrees, sessions: attached }),
    looseSessions: loose,
  };
}

module.exports = { collect };
