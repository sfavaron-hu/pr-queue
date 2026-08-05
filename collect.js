// IO orchestration. All effects are injected so this is testable without a
// real workspace; bin/collect.js supplies the real implementations.
const nodePath = require('node:path');
const { parseWorktrees, parseStatusShort, parseAgents,
        parseTranscriptTail, parseGithubSlug,
        parseLastCommitLog } = require('./collect-parse.js');
const { resolveWorkspaceRoot, resolveClaudeDir, pickBaseBranch } = require('./collect-paths.js');
const { groupProcesses, attachSessions } = require('./classify.js');

// Splits `git log --format=%P%x00%s origin/<base>..HEAD` output (newest
// first) into the total line count and the newest NON-merge commit's
// subject. %P (parent hashes, space-separated) rides along in the same call
// so a merge commit — more than one parent — can be skipped for the subject
// without a second git invocation: the owner routinely merges the base
// branch into feature branches, and a merge's subject (e.g. "Merge
// remote-tracking branch 'origin/main' into <branch>") describes that merge,
// not the owner's actual work. Splitting on the first NUL only mirrors
// parseLastCommitLog/parseCommitRangeLog, for the same reason (a subject can
// contain anything, including more NULs, in theory; %P never does, so it is
// safe as the field before the split point). Count includes merges — it
// answers "what have I not pushed", where a merge commit still counts; only
// the subject selection skips them. A range with no non-merge commit (e.g.
// the branch's only commits are merges) yields subject: null.
function pickUnpushedAndSubject(stdout) {
  const lines = String(stdout).split('\n').filter(l => l !== '');
  let subject = null;
  for (const line of lines) {
    const sep = line.indexOf('\x00');
    const parents = sep === -1 ? '' : line.slice(0, sep);
    const isMerge = parents.trim().split(/\s+/).filter(Boolean).length > 1;
    if (!isMerge) {
      subject = (sep === -1 ? '' : line.slice(sep + 1)) || null;
      break;
    }
  }
  return { count: lines.length, subject };
}

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

  // One `git remote` call per repo, not per worktree — shared across every row
  // below. A missing/non-GitHub/unparseable remote never aborts the repo.
  let githubRepo = null;
  try {
    const remoteUrl = (await run('git', ['remote', 'get-url', 'origin'], repoPath)).trim();
    githubRepo = parseGithubSlug(remoteUrl);
  } catch (e) {
    warn(repo, 'githubRemote', e.message);
  }

  // One `git for-each-ref` call per repo builds the set of branches that exist
  // on origin, tested per worktree below — same shape as the base-branch
  // fallback above, but unconditional (that call only runs when
  // `symbolic-ref` fails) and repo-wide rather than scoped to picking a base
  // branch. `originBranches === null` means the call failed and "is this
  // branch on origin" is simply unknown for this repo; every other repo's
  // worktrees are unaffected.
  //
  // Caveat: remote-tracking refs are a local cache. If a branch is deleted on
  // the remote and the user has not run `git fetch --prune`, its
  // refs/remotes/origin/<branch> can still be sitting around locally, so
  // `onOrigin: true` can be optimistic (a stale "yes" for a branch that's
  // actually gone). We accept that: it was accurate for all 13 real
  // mismatches measured on this machine, and the alternative — `git
  // ls-remote` per repo — is a network round-trip that would dominate this
  // collector's runtime just to cover a rare case.
  //
  // Membership is compared case-insensitively (lowercased on both sides,
  // below). Real case observed on this machine: a repo with
  // core.ignorecase=true (the macOS/APFS default) had a local
  // refs/remotes/origin/Chore/SQSH-4074-... left over from before the remote
  // branch settled on lowercase chore/SQSH-4074-...; `git ls-remote` against
  // GitHub confirmed the real branch is lowercase, matching the worktree. A
  // case-sensitive comparison called that `onOrigin: false` — a false claim
  // the UI would have used to hide a working compare link, which is the exact
  // failure this field exists to prevent. On a case-insensitive filesystem,
  // two refs differing only in case cannot coexist in the local ref store, so
  // comparing case-insensitively loses no real information there; on a
  // genuinely case-sensitive filesystem this could in principle match the
  // wrong same-name-different-case branch, but that only downgrades a
  // confident false claim into a link that might 404 — the milder failure
  // mode, chosen deliberately. This does not change `branch` in the payload,
  // or lowercase anything else (githubRepo, etc.) — comparison only.
  let originBranches = null;
  try {
    const refs = await run('git', ['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin'], repoPath);
    originBranches = new Set(refs.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean));
  } catch (e) {
    warn(repo, 'originBranches', e.message);
  }

  return Promise.all(active.map(async (wt) => {
    // A detached worktree has no branch, and a prunable one's directory is
    // gone — neither can have a working compare link, so both are `false`
    // regardless of what the origin-branch set says (never `null`: the UI
    // needs one thing to test, not a "well, actually" case per flag).
    const onOrigin = (wt.detached || wt.prunable)
      ? false
      : (originBranches === null ? null : originBranches.has(String(wt.branch).toLowerCase()));
    // `isPrimary` rides along from the parser (position in `git worktree list`),
    // not from anything measured here: the base-branch filter above drops main
    // checkouts sitting on `main`/`develop`, but one parked on a feature branch
    // survives — and that is the row a consumer must not try to `worktree
    // remove`. See parseWorktrees for why position is the only available signal.
    const row = { repo, path: wt.path, branch: wt.branch, detached: wt.detached,
                  prunable: wt.prunable, isPrimary: wt.isPrimary === true,
                  dirty: null, unpushed: null, lastCommit: null,
                  lastCommitSubject: null, githubRepo, baseBranch: base, onOrigin };
    // A prunable worktree's directory is gone — running git in it would just fail.
    if (wt.prunable) return row;

    try {
      row.dirty = parseStatusShort(await run('git', ['status', '--short'], wt.path));
    } catch (e) { warn(repo, 'status', e.message); }

    // HEAD's own subject — used for `lastCommit` (the timestamp; that stays
    // HEAD's regardless, since it feeds "when was this worktree last
    // touched") and, only when no base range can be computed below, as the
    // best available fallback for the human-readable subject too.
    // HEAD's own subject — used for `lastCommit` (the timestamp; that stays
    // HEAD's regardless, since it feeds "when was this worktree last
    // touched") and, only when no base range can be computed below, as the
    // best available fallback for the human-readable subject too.
    let headSubject = null;
    try {
      const raw = await run('git', ['log', '-1', '--format=%ct%x00%s'], wt.path);
      const { ts, subject } = parseLastCommitLog(raw);
      row.lastCommit = ts;
      headSubject = subject;
    } catch (e) { warn(repo, 'lastCommit', e.message); }

    if (base && wt.branch) {
      // One call covers both `unpushed` (line count, merges included) and
      // `lastCommitSubject` (the newest NON-merge line's subject) over the
      // same range — no second git invocation; see pickUnpushedAndSubject.
      // An empty range, or a range containing only merges, means there is no
      // own-work subject to report: falling back to a merge's subject or to
      // HEAD's subject would both describe someone else's/the-merge's
      // commit as this worktree's work (the exact bug this replaced).
      try {
        const raw = await run('git', ['log', '--format=%P%x00%s', `origin/${base}..HEAD`], wt.path);
        const { count, subject } = pickUnpushedAndSubject(raw);
        row.unpushed = count;
        row.lastCommitSubject = subject;
      } catch (e) { warn(repo, 'unpushed', e.message); }
    } else {
      // No base branch derivable (or no branch, e.g. detached): there is no
      // range to compute, so HEAD's own subject is the best available signal.
      row.lastCommitSubject = headSubject;
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
      aiTitle: null, resumeCmd: `claude --resume ${a.sessionId}`,
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

    const { lastTs, lastCwd, prLink, aiTitle } = parseTranscriptTail(tail);
    return Object.assign(base, {
      // NEVER the file mtime: bookkeeping records bump it by hours or days.
      lastActivity: lastTs !== null ? lastTs : a.startedAt,
      cwd: lastCwd || a.cwd,
      prLink,
      aiTitle,
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

  // A typo'd PRQ_WORKSPACE (or one pointing nowhere) must not fail the whole
  // run: sessions still come from claudeDir independent of this, and the rest
  // of the collector honours "never fail closed" everywhere else already.
  let repos = [];
  try {
    repos = await listDirs(workspaceRoot);
  } catch (e) {
    warn(null, 'workspace', `Cannot read workspace root "${workspaceRoot}" (check PRQ_WORKSPACE): ${e.message}`);
  }

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
