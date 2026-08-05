// Pure parsers for local command output. No IO, no dependencies.

// safeHttpUrl lives in classify.js — the one file already shared by both the
// browser (local.js) and Node (this file) runtimes — so the scheme-allowlist
// security control has exactly one implementation. Re-exported below so
// existing tests can keep importing it from here.
const { safeHttpUrl } = require('./classify.js');

function parseWorktrees(stdout) {
  const out = [];
  let cur = null;
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice('worktree '.length), branch: null, head: null,
              detached: false, prunable: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      cur.prunable = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Untracked worktree-container dirs are tooling artifacts, not the owner's
// uncommitted work: git surfaces `?? .worktrees/` (or `?? .claude/worktrees/`)
// whenever worktrees are nested under the repo. Counting it as "dirty" both
// hides a merged worktree from autonomous cleanup and emits a spurious
// "¿commiteo?" question. Drop only these known containers — every other
// untracked entry (a real new file) still counts.
const WORKTREE_CONTAINERS = new Set(['.worktrees/', '.claude/worktrees/']);
function parseStatusShort(stdout) {
  return String(stdout).split('\n').filter(l => {
    if (l.trim() === '') return false;
    if (l.startsWith('?? ') && WORKTREE_CONTAINERS.has(l.slice(3).trim())) return false;
    return true;
  }).length;
}

function parseAgents(stdout) {
  let raw;
  try { raw = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.map(a => ({
    sessionId: a.sessionId || null,
    name: a.name || null,
    kind: a.kind || null,
    status: a.status || a.state || null,
    cwd: a.cwd || null,
    startedAt: a.startedAt || null,
  }));
}

// Scans a transcript tail backwards. Records are one JSON object per line;
// the first line is usually truncated by the 64KB read and must be tolerated.
// Trailing ai-title/mode/permission-mode records have no timestamp — skipping
// them is the whole reason we do not use the file's mtime. The ai-title record
// itself never carries a timestamp either, so "newest wins" just means the
// first one hit while scanning backwards (the transcript is append-only).
function parseTranscriptTail(text) {
  const out = { lastTs: null, lastCwd: null, prLink: null, aiTitle: null };
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }  // truncated line
    if (out.lastTs === null && o.timestamp) {
      const t = new Date(o.timestamp).getTime();
      if (!isNaN(t)) out.lastTs = t;
    }
    if (out.lastCwd === null && o.cwd) out.lastCwd = o.cwd;
    if (out.prLink === null && o.type === 'pr-link' && o.prNumber) {
      out.prLink = { number: o.prNumber, repo: o.prRepository || null, url: safeHttpUrl(o.prUrl) };
    }
    if (out.aiTitle === null && o.type === 'ai-title' && o.aiTitle) {
      out.aiTitle = o.aiTitle;
    }
    if (out.lastTs !== null && out.lastCwd !== null && out.prLink !== null && out.aiTitle !== null) break;
  }
  return out;
}

// Parses `git log -1 --format=%ct%x00%s` output: epoch seconds and the
// subject, split on the FIRST NUL only — a commit subject can itself contain
// anything (including more NULs, in theory) so it must never be assumed
// non-empty or NUL-free.
function parseLastCommitLog(stdout) {
  const raw = String(stdout).trim();
  const sep = raw.indexOf('\0');
  const secsStr = sep === -1 ? raw : raw.slice(0, sep);
  const subject = sep === -1 ? '' : raw.slice(sep + 1);
  return { ts: secsStr ? Number(secsStr) * 1000 : null, subject: subject || null };
}

// Parses `git log --format=%ct%x00%s origin/<base>..HEAD`: zero or more
// commits unique to this branch (newest first), one per line since %s is a
// single-line subject. Splitting on the first NUL only mirrors
// parseLastCommitLog, for the same reason. An empty range (0 commits ahead)
// is not an error — it means the branch has made no commits of its own yet,
// so there is no own-work subject to report; callers must not fall back to
// HEAD's subject in that case, since HEAD may be sitting on someone else's
// commit (e.g. a freshly created worktree on the base branch's tip).
function parseCommitRangeLog(stdout) {
  const lines = String(stdout).split('\n').filter(l => l !== '');
  if (lines.length === 0) return { count: 0, subject: null };
  const sep = lines[0].indexOf('\0');
  const subject = sep === -1 ? '' : lines[0].slice(sep + 1);
  return { count: lines.length, subject: subject || null };
}

// Parses `owner/name` out of a real `git remote get-url origin` value. Handles
// the SSH form (git@github.com:Owner/Repo.git) and the HTTPS form
// (https://github.com/Owner/Repo.git), each with or without the `.git`
// suffix. Anything else — missing remote, non-GitHub host, unparseable text —
// returns null rather than guessing.
function parseGithubSlug(remoteUrl) {
  const s = String(remoteUrl || '').trim();
  if (!s) return null;
  let m = s.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (m) return `${m[1]}/${m[2]}`;
  m = s.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

module.exports = { parseWorktrees, parseStatusShort, parseAgents, parseTranscriptTail,
                    parseGithubSlug, parseLastCommitLog, parseCommitRangeLog, safeHttpUrl };
